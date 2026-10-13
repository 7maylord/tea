import { indexer, type ChainEvent } from 'envio';

type EventMeta = {
  chainId: number;
  logIndex: number;
  srcAddress: string;
  transaction: { hash: string };
  block: { number: number; hash: string; timestamp: number };
};

const fields = { transaction: ['hash'], block: ['hash', 'timestamp'] } as const;

function base(event: EventMeta, eventType: string): ChainEvent {
  const txHash = event.transaction.hash.toLowerCase();
  return {
    id: `${event.chainId}:${txHash}:${event.logIndex}`,
    chainId: event.chainId,
    txHash,
    logIndex: event.logIndex,
    blockNumber: BigInt(event.block.number),
    blockHash: event.block.hash.toLowerCase(),
    blockTimestamp: BigInt(event.block.timestamp),
    contractAddress: event.srcAddress.toLowerCase(),
    eventType,
    tokenAddress: undefined,
    fromAddress: undefined,
    toAddress: undefined,
    amountUnits: undefined,
    lockId: undefined,
    unlockAt: undefined,
    streamId: undefined,
    claimId: undefined,
    start: undefined,
    end: undefined,
    recipientEntitlementUnits: undefined,
    senderRefundUnits: undefined,
  };
}

indexer.onEvent(
  { contract: 'SettlementToken', event: 'Transfer', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'TRANSFER'),
      fromAddress: event.params.from,
      toAddress: event.params.to,
      amountUnits: event.params.value,
      tokenAddress: event.srcAddress,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaStream', event: 'StreamCreated', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'STREAM_CREATED'),
      fromAddress: event.params.sender,
      toAddress: event.params.recipient,
      amountUnits: event.params.deposit,
      tokenAddress: event.params.token,
      streamId: event.params.streamId,
      start: event.params.start,
      end: event.params.end,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaStream', event: 'StreamWithdrawn', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'STREAM_WITHDRAWN'),
      fromAddress: event.params.sender,
      toAddress: event.params.recipient,
      amountUnits: event.params.amount,
      tokenAddress: event.params.token,
      streamId: event.params.streamId,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaStream', event: 'StreamCanceled', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'STREAM_CANCELED'),
      fromAddress: event.params.sender,
      toAddress: event.params.recipient,
      streamId: event.params.streamId,
      tokenAddress: event.params.token,
      recipientEntitlementUnits: event.params.recipientEntitlement,
      senderRefundUnits: event.params.senderRefund,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaClaimEscrow', event: 'ClaimDeposited', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'CLAIM_DEPOSITED'),
      fromAddress: event.params.payer,
      amountUnits: event.params.amount,
      tokenAddress: event.params.token,
      claimId: event.params.claimId,
      end: event.params.expiry,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaClaimEscrow', event: 'ClaimPaid', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'CLAIM_PAID'),
      fromAddress: event.params.payer,
      toAddress: event.params.recipient,
      amountUnits: event.params.amount,
      tokenAddress: event.params.token,
      claimId: event.params.claimId,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaClaimEscrow', event: 'ClaimRefunded', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'CLAIM_REFUNDED'),
      fromAddress: event.params.payer,
      toAddress: event.params.payer,
      amountUnits: event.params.amount,
      tokenAddress: event.params.token,
      claimId: event.params.claimId,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaDateUnlock', event: 'LockCreated', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'LOCK_CREATED'),
      fromAddress: event.params.sender,
      toAddress: event.params.recipient,
      amountUnits: event.params.amount,
      tokenAddress: event.params.token,
      lockId: event.params.lockId,
      unlockAt: event.params.unlockAt,
    });
  },
);

indexer.onEvent(
  { contract: 'TeaDateUnlock', event: 'LockWithdrawn', fields },
  async ({ event, context }) => {
    context.ChainEvent.set({
      ...base(event, 'LOCK_WITHDRAWN'),
      fromAddress: event.params.sender,
      toAddress: event.params.recipient,
      amountUnits: event.params.amount,
      tokenAddress: event.params.token,
      lockId: event.params.lockId,
    });
  },
);
