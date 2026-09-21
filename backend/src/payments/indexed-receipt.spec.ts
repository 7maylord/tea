import { matchIndexedReceipt, type IndexedEvent } from './indexed-receipt';

it('accepts only the canonical transfer for the confirmed intent', () => {
  const intent = {
    kind: 'DIRECT',
    state: 'CONFIRMED',
    chainId: 31337,
    tokenAddress: '0xtoken',
    streamAddress: null,
    payerAddress: '0xsender',
    recipientAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: null,
    claimId: null,
  };
  const attempt = {
    txHash: '0xtx',
    blockNumber: 7n,
    blockHash: '0xcanonical',
  };
  const event: IndexedEvent = {
    id: '31337:0xtx:3',
    chainId: 31337,
    txHash: '0xtx',
    logIndex: 3,
    blockNumber: '7',
    blockHash: '0xcanonical',
    contractAddress: '0xtoken',
    eventType: 'TRANSFER',
    fromAddress: '0xsender',
    toAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: null,
    claimId: null,
  };
  expect(
    matchIndexedReceipt(intent, attempt, [
      { ...event, toAddress: '0xattacker' },
    ]),
  ).toBeNull();
  expect(
    matchIndexedReceipt(intent, attempt, [{ ...event, blockHash: '0xorphan' }]),
  ).toBeNull();
  expect(matchIndexedReceipt(intent, attempt, [event])).toMatchObject({
    id: '31337:0xtx:3',
    blockHash: '0xcanonical',
  });
});

it('matches stream creation by its onchain stream ID', () => {
  const intent = {
    kind: 'STREAM',
    state: 'CONFIRMED',
    chainId: 31337,
    tokenAddress: '0xtoken',
    streamAddress: '0xstream',
    payerAddress: '0xsender',
    recipientAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: '4',
    claimId: null,
  };
  const attempt = {
    txHash: '0xtx',
    blockNumber: 7n,
    blockHash: '0xcanonical',
  };
  const event: IndexedEvent = {
    id: '31337:0xtx:3',
    chainId: 31337,
    txHash: '0xtx',
    logIndex: 3,
    blockNumber: '7',
    blockHash: '0xcanonical',
    contractAddress: '0xstream',
    eventType: 'STREAM_CREATED',
    fromAddress: '0xsender',
    toAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: '4',
    claimId: null,
  };
  expect(
    matchIndexedReceipt(intent, attempt, [{ ...event, streamId: '5' }]),
  ).toBeNull();
  expect(matchIndexedReceipt(intent, attempt, [event])?.id).toBe(event.id);
});

it('matches a claim payout by escrow and claim ID', () => {
  const intent = {
    kind: 'CLAIM',
    state: 'CONFIRMED',
    chainId: 31337,
    tokenAddress: '0xtoken',
    streamAddress: null,
    payerAddress: '0xsender',
    recipientAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: null,
    claimId: `0x${'12'.repeat(32)}`,
    claim: { escrowAddress: '0xescrow' },
  };
  const attempt = {
    txHash: '0xtx',
    blockNumber: 7n,
    blockHash: '0xcanonical',
  };
  const event: IndexedEvent = {
    id: '31337:0xtx:3',
    chainId: 31337,
    txHash: '0xtx',
    logIndex: 3,
    blockNumber: '7',
    blockHash: '0xcanonical',
    contractAddress: '0xescrow',
    eventType: 'CLAIM_PAID',
    fromAddress: '0xsender',
    toAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: null,
    claimId: intent.claimId,
  };
  expect(
    matchIndexedReceipt(intent, attempt, [
      { ...event, claimId: `0x${'34'.repeat(32)}` },
    ]),
  ).toBeNull();
  expect(matchIndexedReceipt(intent, attempt, [event])?.id).toBe(event.id);
});

it('matches claim deposit and refund lifecycle receipts', () => {
  const claimId = `0x${'12'.repeat(32)}`;
  const intent = {
    kind: 'CLAIM',
    state: 'OPEN',
    chainId: 31337,
    tokenAddress: '0xtoken',
    streamAddress: null,
    payerAddress: '0xsender',
    recipientAddress: '0xescrow',
    amountUnits: '2500000',
    streamId: null,
    claimId,
    claim: { escrowAddress: '0xescrow' },
  };
  const attempt = {
    txHash: '0xtx',
    blockNumber: 7n,
    blockHash: '0xcanonical',
  };
  const event: IndexedEvent = {
    id: '31337:0xtx:3',
    chainId: 31337,
    txHash: '0xtx',
    logIndex: 3,
    blockNumber: '7',
    blockHash: '0xcanonical',
    contractAddress: '0xescrow',
    eventType: 'CLAIM_DEPOSITED',
    fromAddress: '0xsender',
    toAddress: null,
    amountUnits: '2500000',
    streamId: null,
    claimId,
  };
  expect(matchIndexedReceipt(intent, attempt, [event])?.id).toBe(event.id);
  expect(
    matchIndexedReceipt({ ...intent, state: 'REFUNDED' }, attempt, [
      {
        ...event,
        eventType: 'CLAIM_REFUNDED',
        toAddress: '0xsender',
      },
    ])?.id,
  ).toBe(event.id);
});
