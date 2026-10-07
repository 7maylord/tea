import type { Hex } from "viem";
import { sendMeraTransaction } from "./mera";

type Transaction = { to: Hex; data: Hex; value: bigint; chainId: number };

export async function sendWithSponsorFallback(ownerId: string, input: Transaction, address: string) {
  return sendMeraTransaction(ownerId, input, address);
}
