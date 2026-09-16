import { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const escrowAbi = parseAbi([
  'function claims(bytes32 claimId) view returns (address payer, uint256 amount, uint64 expiry, bytes32 identityCommitment, uint8 status)',
  'function nonces(bytes32 claimId) view returns (uint256)',
  'function signerEpoch() view returns (uint64)',
  'function claim((bytes32 claimId,bytes32 identityCommitment,address token,uint256 amount,address recipient,uint256 nonce,uint64 deadline,uint64 signerEpoch) authorization, bytes identitySignature, bytes recipientSignature)',
]);

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
    if (onchain[4] === 2 || onchain[4] === 3) {
      await db.$transaction([
        db.claim.update({
          where: { id: claim.id },
          data: { state: onchain[4] === 2 ? 'CLAIMED' : 'REFUNDED' },
        }),
        db.claimAuthorization.update({
          where: { id: authorization.id },
          data: { state: onchain[4] === 2 ? 'CONSUMED' : 'CANCELED' },
        }),
        db.outboxJob.update({
          where: { id: job.id },
          data: {
            state: onchain[4] === 2 ? 'SENT' : 'CANCELED',
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
