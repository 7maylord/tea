import { matchIndexedReceipt, type IndexedEvent } from './indexed-receipt';

it('accepts only the canonical transfer for the confirmed intent', () => {
  const intent = {
    kind: 'DIRECT',
    chainId: 31337,
    tokenAddress: '0xtoken',
    streamAddress: null,
    payerAddress: '0xsender',
    recipientAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: null,
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
    chainId: 31337,
    tokenAddress: '0xtoken',
    streamAddress: '0xstream',
    payerAddress: '0xsender',
    recipientAddress: '0xrecipient',
    amountUnits: '2500000',
    streamId: '4',
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
  };
  expect(
    matchIndexedReceipt(intent, attempt, [{ ...event, streamId: '5' }]),
  ).toBeNull();
  expect(matchIndexedReceipt(intent, attempt, [event])?.id).toBe(event.id);
});
