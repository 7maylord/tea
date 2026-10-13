import type { Hex } from "viem";

export async function submitTransactionSequence<T>(
  transactions: readonly T[],
  send: (transaction: T) => Promise<Hex>,
  wait: (hash: Hex) => Promise<void>,
  onSubmitted?: (index: number, hash: Hex) => void | Promise<void>,
) {
  const hashes: Hex[] = [];
  for (const [index, transaction] of transactions.entries()) {
    const hash = await send(transaction);
    hashes.push(hash);
    await onSubmitted?.(index, hash);
    if (index < transactions.length - 1) await wait(hash);
  }
  return hashes;
}
