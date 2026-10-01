import type { Hex } from "viem";

type Transaction = { to: Hex; data: Hex; value: bigint; chainId: number };
type Options = { address: string; sponsor?: boolean };
type SendTransaction = (input: Transaction, options?: Options) => Promise<{ hash: Hex }>;

export async function sendWithSponsorFallback(sendTransaction: SendTransaction, input: Transaction, address: string) {
  return sendTransaction(input, { address, sponsor: true });
}
