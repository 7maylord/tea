import {
  Claim,
  ClaimAuthorization,
  OutboxJob,
  PrismaClient,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  createPublicClient as createPublicClientBase,
  createWalletClient,
  defineChain,
  getAbiItem,
  http,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import escrowAbiJson from '../abi/TeaClaimEscrow.json';
import { upsertThread } from '../payments/thread';

const escrowAbi = escrowAbiJson as any;
const createPublicClient = createPublicClientBase as any;
const claimPaidEvent = getAbiItem({
  abi: escrowAbi,
  name: 'ClaimPaid',
}) as any;

async function recordClaimPayment(
  db: PrismaClient,
  claim: Claim,
  authorization: ClaimAuthorization,
  job: OutboxJob,
  receipt: { transactionHash: Hex; blockNumber: bigint; blockHash: Hex },
) {
  const recipient = await db.account.findUnique({
    where: {
      chainId_settlementAddress: {
        chainId: claim.chainId,
        settlementAddress: authorization.recipientAddress,
      },
    },
  });
  if (!recipient) throw new Error('Claim recipient account unavailable');
  const requestHash = createHash('sha256')
    .update(`claim-receipt:${claim.id}`)
    .digest('hex');
  await db.$transaction(async (tx) => {
    const thread = await upsertThread(
      tx,
      claim.chainId,
      claim.payerId,
      recipient.userId,
    );
    const payment = await tx.paymentIntent.upsert({
      where: { claimId: claim.id },
      create: {
        claimId: claim.id,
        payerId: claim.payerId,
        recipientUserId: recipient.userId,
        threadId: thread.id,
        chainId: claim.chainId,
        tokenAddress: claim.tokenAddress,
        payerAddress: claim.payerAddress,
        recipientAddress: authorization.recipientAddress,
        amountUnits: claim.amountUnits,
        preparedAtBlock: claim.depositBlockNumber,
        kind: 'CLAIM',
        state: 'CONFIRMED',
        idempotencyKey: null,
        requestHash,
        authorizationExpiresAt: authorization.deadline,
      },
      update: {
        recipientUserId: recipient.userId,
        recipientAddress: authorization.recipientAddress,
        threadId: thread.id,
        state: 'CONFIRMED',
      },
    });
    const existingAttempt = await tx.transactionAttempt.findUnique({
      where: {
        chainId_txHash: {
          chainId: claim.chainId,
          txHash: receipt.transactionHash,
        },
      },
    });
    if (existingAttempt && existingAttempt.intentId !== payment.id) {
      throw new Error('Claim transaction already belongs to another payment');
    }
    if (existingAttempt) {
      await tx.transactionAttempt.update({
        where: { id: existingAttempt.id },
        data: {
          state: 'CONFIRMED',
          confirmedAt: new Date(),
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        },
      });
    } else {
      await tx.transactionAttempt.create({
        data: {
          intentId: payment.id,
          operationIndex: 1,
          chainId: claim.chainId,
          txHash: receipt.transactionHash,
          state: 'CONFIRMED',
          idempotencyKey: `claim-receipt:${claim.id}`,
          requestHash,
          confirmedAt: new Date(),
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
        },
      });
    }
    await Promise.all([
      tx.thread.update({
        where: { id: thread.id },
        data: { lastActivityAt: new Date() },
      }),
      tx.claim.update({
        where: { id: claim.id },
        data: { state: 'CLAIMED' },
      }),
      tx.claimAuthorization.update({
        where: { id: authorization.id },
        data: { state: 'CONSUMED' },
      }),
      tx.outboxJob.update({
        where: { id: job.id },
        data: { state: 'SENT', leaseUntil: null },
      }),
    ]);
  });
}

export async function processNextClaimRelay(
  db: PrismaClient,
): Promise<boolean> {
  const now = new Date();
  const job = await db.outboxJob.findFirst({
    where: {
      kind: 'CLAIM_RELAY',
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
    const authorization = await db.claimAuthorization.findFirstOrThrow({
      where: {
        claimId: claim.id,
        state: { in: ['ACCEPTED', 'SUBMITTED'] },
        recipientSignature: { not: null },
      },
    });
    const recipientSignature = authorization.recipientSignature;
    if (!recipientSignature) throw new Error('Acceptance signature missing');
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
      const payments = await client.getLogs({
        address: claim.escrowAddress as Address,
        event: claimPaidEvent,
        args: { claimId: claim.id as Hex },
        fromBlock: claim.depositBlockNumber ?? block.number,
        toBlock: block.number,
      });
      const payment = payments.find(
        (event) =>
          event.args.payer?.toLowerCase() === claim.payerAddress &&
          event.args.recipient?.toLowerCase() ===
            authorization.recipientAddress &&
          event.args.amount === BigInt(claim.amountUnits.toString()) &&
          event.transactionHash &&
          event.blockNumber !== null &&
          event.blockHash,
      );
      if (
        !payment?.transactionHash ||
        payment.blockNumber === null ||
        !payment.blockHash
      ) {
        throw new Error('Claim payment receipt unavailable');
      }
      await recordClaimPayment(db, claim, authorization, job, {
        transactionHash: payment.transactionHash,
        blockNumber: payment.blockNumber,
        blockHash: payment.blockHash,
      });
      return true;
    }
    if (onchain[4] === 3) {
      await db.$transaction([
        db.claim.update({
          where: { id: claim.id },
          data: { state: 'REFUNDED' },
        }),
        db.claimAuthorization.update({
          where: { id: authorization.id },
          data: { state: 'CANCELED' },
        }),
        db.outboxJob.update({
          where: { id: job.id },
          data: {
            state: 'CANCELED',
            leaseUntil: null,
          },
        }),
      ]);
      return true;
    }
    if (onchain[4] !== 1) throw new Error('Claim is not open');
    if (job.txHash) {
      const receipt = await client
        .getTransactionReceipt({ hash: job.txHash as Hex })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (receipt?.status === 'reverted') {
        await db.outboxJob.update({
          where: { id: job.id },
          data: {
            state: 'PENDING',
            txHash: null,
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 30_000),
          },
        });
        return true;
      }
      await db.outboxJob.update({
        where: { id: job.id },
        data: {
          state: 'SUBMITTED',
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + 15_000),
        },
      });
      return true;
    }
    const nonce = await client.readContract({
      address: claim.escrowAddress as Address,
      abi: escrowAbi,
      functionName: 'nonces',
      args: [claim.id as Hex],
      blockNumber: block.number,
    });
    const signerEpoch = await client.readContract({
      address: claim.escrowAddress as Address,
      abi: escrowAbi,
      functionName: 'signerEpoch',
      blockNumber: block.number,
    });
    if (
      block.timestamp >
        BigInt(Math.floor(authorization.deadline.getTime() / 1000)) ||
      BigInt(authorization.nonce.toString()) !== nonce ||
      authorization.signerEpoch !== signerEpoch
    ) {
      await db.$transaction([
        db.claimAuthorization.update({
          where: { id: authorization.id },
          data: { state: 'EXPIRED' },
        }),
        db.outboxJob.update({
          where: { id: job.id },
          data: { state: 'CANCELED', leaseUntil: null },
        }),
      ]);
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
      functionName: 'claim',
      args: [
        {
          claimId: claim.id as Hex,
          identityCommitment: claim.identityCommitment,
          token: claim.tokenAddress as Address,
          amount: BigInt(claim.amountUnits.toString()),
          recipient: authorization.recipientAddress as Address,
          nonce,
          deadline: BigInt(Math.floor(authorization.deadline.getTime() / 1000)),
          signerEpoch,
        },
        toHex(authorization.identitySignature),
        toHex(recipientSignature),
      ],
    });
    await db.$transaction([
      db.claimAuthorization.update({
        where: { id: authorization.id },
        data: { state: 'SUBMITTED' },
      }),
      db.outboxJob.update({
        where: { id: job.id },
        data: {
          state: 'SUBMITTED',
          txHash: hash,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + 3_000),
        },
      }),
    ]);
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
    console.error('Claim relay retry scheduled', job.id);
  }
  return true;
}
