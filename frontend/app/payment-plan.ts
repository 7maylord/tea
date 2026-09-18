import { decodeFunctionData, erc20Abi, isAddress, type Hex } from "viem";

export type PaymentIntent = {
  id: string;
  state: string;
  chainId: number;
  token: string;
  payer: string;
  recipient: string;
  amountUnits: string;
  authorizationExpiresAt: string;
  plan: { chainId: number; from: string; to: string; value: string; data: Hex } | null;
};

export function checkedTransferPlan(
  intent: PaymentIntent,
  account: string,
  token: string,
  chainId: number,
  amountUnits: string,
) {
  const plan = intent.plan;
  const expiry = Date.parse(intent.authorizationExpiresAt);
  if (
    intent.state !== "AWAITING_AUTHORIZATION" ||
    !Number.isFinite(expiry) || expiry <= Date.now() ||
    !plan ||
    !isAddress(account) || !isAddress(token) || !isAddress(intent.recipient) ||
    intent.chainId !== chainId || plan.chainId !== chainId ||
    intent.payer.toLowerCase() !== account.toLowerCase() ||
    plan.from.toLowerCase() !== account.toLowerCase() ||
    intent.token.toLowerCase() !== token.toLowerCase() ||
    plan.to.toLowerCase() !== token.toLowerCase() ||
    intent.amountUnits !== amountUnits || plan.value !== "0"
  ) throw new Error("Payment details changed. Start again.");
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: plan.data });
    if (
      decoded.functionName !== "transfer" ||
      decoded.args[0].toLowerCase() !== intent.recipient.toLowerCase() ||
      decoded.args[1] !== BigInt(amountUnits)
    ) throw new Error("Wrong transfer");
  } catch {
    throw new Error("Payment details changed. Start again.");
  }
  return plan;
}
