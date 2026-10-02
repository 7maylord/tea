import type { Hex } from "viem";

type Transaction = { to: Hex; data: Hex; value: bigint; chainId: number };
type Options = { address: string };
type SendTransaction = (input: Transaction, options?: Options) => Promise<{ hash: Hex }>;

export async function sendWithSponsorFallback(sendTransaction: SendTransaction, input: Transaction, address: string) {
  return sendTransaction(input, { address });
}
