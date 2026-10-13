import type { Hex } from "viem";
import { authHeaders } from "./auth";
import { sendMeraTransaction } from "./mera";

type Transaction = { to: Hex; data: Hex; value: bigint; chainId: number };

export async function sendWithSponsorFallback(ownerId: string, input: Transaction, address: string) {
  const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
  if (!apiOrigin) throw new Error("Gas sponsorship is not configured.");
  const response = await fetch(`${apiOrigin}/v1/faucet/gas`, {
    method: "POST",
    headers: await authHeaders(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    if (response.status === 409) throw new Error("Today's testnet gas allowance has been used. Add MON to your TEA wallet and try again.");
    throw new Error(body?.message ?? "Testnet gas sponsorship is temporarily unavailable.");
  }
  try {
    return await sendMeraTransaction(ownerId, input, address);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/insufficient balance/i.test(message)) {
      throw new Error("Your TEA wallet needs more testnet MON for network fees.");
    }
    throw cause;
  }
}
