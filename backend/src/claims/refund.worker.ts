import { PrismaClient } from '@prisma/client';
import {
  createPublicClient as createPublicClientBase,
  createWalletClient,
  defineChain,
  getAbiItem,
  http,
  parseEventLogs as parseEventLogsBase,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import escrowAbiJson from '../abi/TeaClaimEscrow.json';
import tokenAbiJson from '../abi/TestUSD.json';

const escrowAbi = escrowAbiJson as any;
const tokenAbi = tokenAbiJson as any;
const createPublicClient = createPublicClientBase as any;
const parseEventLogs = parseEventLogsBase as any;
const claimRefundedEvent = getAbiItem({
  abi: escrowAbi,
  name: 'ClaimRefunded',
}) as any;

export async function processNextClaimRefund(
  db: PrismaClient,
): Promise<boolean> {
  const now = new Date();
  const job = await db.outboxJob.findFirst({
    where: {
      kind: 'CLAIM_REFUND',
      OR: [
        { state: 'PENDING', nextAttemptAt: { lte: now } },
        { state: 'SUBMITTED', nextAttemptAt: { lte: now } },
        { state: 'PROCESSING', leaseUntil: { lt: now } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
  });
  if (!job) return false;
  const leaseUntil = new Date(Date.now() + 60_000);
  const locked = await db.outboxJob.updateMany({
    where: {
      id: job.id,
      state: job.state,
      ...(job.state === 'PROCESSING'
        ? { leaseUntil: job.leaseUntil }
        : { nextAttemptAt: job.nextAttemptAt }),
    },
    data: { state: 'PROCESSING', leaseUntil, attempts: { increment: 1 } },
  });
  if (locked.count !== 1) return true;

  try {
    const claim = await db.claim.findUniqueOrThrow({
      where: { id: job.claimId },
    });
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) throw new Error('RPC unavailable');
    const client = createPublicClient({
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    if ((await client.getChainId()) !== claim.chainId)
      throw new Error('Wrong chain');
    const block = await client.getBlock();
    const onchain = await client.readContract({
      address: claim.escrowAddress as Address,
      abi: escrowAbi,
      functionName: 'claims',
      args: [claim.id as Hex],
      blockNumber: block.number,
    });
    if (
      onchain[0].toLowerCase() !== claim.payerAddress ||
      onchain[1] !== BigInt(claim.amountUnits.toString()) ||
      onchain[3] !== claim.identityCommitment ||
      onchain[2] * 1000n !== BigInt(claim.expiry?.getTime() ?? 0)
    )
      throw new Error('Claim state mismatch');

    if (onchain[4] === 2) {
      await db.$transaction([
        db.outboxJob.update({
          where: { id: job.id },
          data: {
            state: 'CANCELED',
            leaseUntil: null,
          },
        }),
        db.claim.update({
          where: { id: claim.id },
          data: { state: 'CLAIMED' },
        }),
        db.paymentIntent.updateMany({
          where: { claimId: claim.id },
          data: { state: 'CONFIRMED' },
        }),
      ]);
      return true;
    }
    if (onchain[4] === 3) {
      const refunds = await client.getLogs({
        address: claim.escrowAddress as Address,
        event: claimRefundedEvent,
        args: { claimId: claim.id as Hex },
        fromBlock: claim.depositBlockNumber ?? block.number,
        toBlock: block.number,
      });
      const refund = refunds.find(
        (event) =>
          event.args.payer?.toLowerCase() === claim.payerAddress &&
          event.args.amount === BigInt(claim.amountUnits.toString()) &&
          event.transactionHash &&
          event.blockNumber !== null &&
          event.blockHash,
      );
      if (
        !refund?.transactionHash ||
        refund.blockNumber === null ||
        !refund.blockHash
      ) {
        throw new Error('Claim refund receipt unavailable');
      }
      await db.$transaction(async (tx) => {
        const payment = await tx.paymentIntent.findUnique({
          where: { claimId: claim.id },
        });
        if (payment) {
          const existing = await tx.transactionAttempt.findUnique({
            where: {
              chainId_txHash: {
                chainId: claim.chainId,
                txHash: refund.transactionHash,
              },
            },
          });
          if (existing && existing.intentId !== payment.id) {
            throw new Error('Claim refund already belongs to another payment');
          }
          if (!existing) {
            await tx.transactionAttempt.create({
              data: {
                intentId: payment.id,
                operationIndex: 1,
                chainId: claim.chainId,
                txHash: refund.transactionHash,
                state: 'CONFIRMED',
                idempotencyKey: `claim-refund:${claim.id}`,
                requestHash: claim.requestHash,
                confirmedAt: new Date(),
                blockNumber: refund.blockNumber,
                blockHash: refund.blockHash,
              },
            });
          }
          await tx.paymentIntent.update({
            where: { id: payment.id },
            data: { state: 'REFUNDED' },
          });
        }
        await Promise.all([
          tx.outboxJob.update({
            where: { id: job.id },
            data: {
              state: 'SENT',
              txHash: refund.transactionHash,
              leaseUntil: null,
            },
          }),
          tx.claim.update({
            where: { id: claim.id },
            data: { state: 'REFUNDED' },
          }),
        ]);
      });
      return true;
    }
    if (onchain[4] !== 1) throw new Error('Claim is not open');
    if (block.timestamp < onchain[2]) {
      await db.outboxJob.updateMany({
        where: { id: job.id, state: 'PROCESSING', leaseUntil },
        data: {
          state: 'PENDING',
          leaseUntil: null,
          nextAttemptAt: new Date(Number(onchain[2]) * 1000),
        },
      });
      return true;
    }

    if (job.txHash) {
      const receipt = await client
        .getTransactionReceipt({ hash: job.txHash as Hex })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (!receipt) {
        await db.outboxJob.updateMany({
          where: { id: job.id, state: 'PROCESSING', leaseUntil },
          data: {
            state: 'SUBMITTED',
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 15_000),
          },
        });
        return true;
      }
      if (receipt.status === 'success') {
        const refunds = parseEventLogs({
          abi: escrowAbi,
          eventName: 'ClaimRefunded',
          logs: receipt.logs,
        });
        const transfers = parseEventLogs({
          abi: tokenAbi,
          eventName: 'Transfer',
          logs: receipt.logs,
        });
        const refunded = refunds.some(
          (log) =>
            log.address.toLowerCase() === claim.escrowAddress &&
            log.args.claimId === claim.id &&
            log.args.payer?.toLowerCase() === claim.payerAddress &&
            log.args.amount === BigInt(claim.amountUnits.toString()),
        );
        const paid = transfers.some(
          (log) =>
            log.address.toLowerCase() === claim.tokenAddress &&
            log.args.from?.toLowerCase() === claim.escrowAddress &&
            log.args.to?.toLowerCase() === claim.payerAddress &&
            log.args.value === BigInt(claim.amountUnits.toString()),
        );
        if (!refunded || !paid) throw new Error('Refund receipt mismatch');
        await db.$transaction([
          db.outboxJob.update({
            where: { id: job.id },
            data: { state: 'SENT', leaseUntil: null },
          }),
          db.claim.update({
            where: { id: claim.id },
            data: { state: 'REFUNDED' },
          }),
          db.paymentIntent.updateMany({
            where: { claimId: claim.id },
            data: { state: 'REFUNDED' },
          }),
        ]);
        return true;
      }
      await db.outboxJob.updateMany({
        where: { id: job.id, state: 'PROCESSING', leaseUntil },
        data: {
          state: 'PENDING',
          txHash: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      return true;
    }

    const key = process.env.RELAYER_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
      throw new Error('Relayer unavailable');
    const wallet = createWalletClient({
      account: privateKeyToAccount(key as Hex),
      chain: defineChain({
        id: claim.chainId,
        name: 'TEA settlement',
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }),
      transport: http(rpcUrl, { timeout: 5000 }),
    });
    const hash = await wallet.writeContract({
      address: claim.escrowAddress as Address,
      abi: escrowAbi,
      functionName: 'refund',
      args: [claim.id as Hex],
    });
    await db.outboxJob.updateMany({
      where: { id: job.id, state: 'PROCESSING', leaseUntil },
      data: {
        state: 'SUBMITTED',
        txHash: hash,
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + 3_000),
      },
    });
  } catch {
    const backoffSeconds = Math.min(30 * 2 ** Math.min(job.attempts, 7), 3600);
    await db.outboxJob.updateMany({
      where: { id: job.id, state: 'PROCESSING', leaseUntil },
      data: {
        state: job.txHash ? 'SUBMITTED' : 'PENDING',
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
      },
    });
    console.error('Claim refund retry scheduled', job.id);
  }
  return true;
}
