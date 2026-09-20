export type IndexedEvent = {
  id: string;
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockHash: string;
  contractAddress: string;
  eventType: string;
  fromAddress: string | null;
  toAddress: string | null;
  amountUnits: string | null;
  streamId: string | null;
  claimId: string | null;
};

export function matchIndexedReceipt(
  intent: {
    kind: string;
    chainId: number;
    tokenAddress: string;
    streamAddress: string | null;
    payerAddress: string;
    recipientAddress: string;
    amountUnits: { toString(): string };
    streamId: { toString(): string } | null;
    claimId: string | null;
    claim?: { escrowAddress: string } | null;
  },
  attempt:
    | {
        txHash: string;
        blockNumber: bigint | null;
        blockHash: string | null;
      }
    | undefined,
  events: IndexedEvent[],
) {
  if (!attempt?.blockHash || attempt.blockNumber === null) return null;
  if (!['DIRECT', 'STREAM', 'CLAIM'].includes(intent.kind)) return null;
  const eventType =
    intent.kind === 'DIRECT'
      ? 'TRANSFER'
      : intent.kind === 'STREAM'
        ? 'STREAM_CREATED'
        : 'CLAIM_PAID';
  const contract =
    intent.kind === 'DIRECT'
      ? intent.tokenAddress
      : intent.kind === 'STREAM'
        ? intent.streamAddress
        : intent.claim?.escrowAddress;
  const match = events.find(
    (event) =>
      event.chainId === intent.chainId &&
      event.txHash === attempt.txHash &&
      event.id === `${intent.chainId}:${event.txHash}:${event.logIndex}` &&
      event.blockNumber === attempt.blockNumber?.toString() &&
      event.blockHash === attempt.blockHash &&
      event.eventType === eventType &&
      event.contractAddress === contract &&
      event.fromAddress === intent.payerAddress &&
      event.toAddress === intent.recipientAddress &&
      event.amountUnits === intent.amountUnits.toString() &&
      (intent.kind !== 'STREAM' ||
        event.streamId === intent.streamId?.toString()) &&
      (intent.kind !== 'CLAIM' || event.claimId === intent.claimId),
  );
  return match
    ? {
        id: match.id,
        txHash: match.txHash,
        logIndex: match.logIndex,
        blockNumber: match.blockNumber,
        blockHash: match.blockHash,
      }
    : null;
}
