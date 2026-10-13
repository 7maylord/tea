import { decodeFunctionData, isAddress, type Abi, type Hex } from "viem";
import escrowAbiJson from "../abi/TeaClaimEscrow.json" with { type: "json" };
import tokenAbiJson from "../abi/TestUSD.json" with { type: "json" };

const escrowAbi = escrowAbiJson as Abi;
const tokenAbi = tokenAbiJson as Abi;
type DecodedCall<Name extends string, Args extends readonly unknown[]> = { functionName: Name; args: Args };

export type ClaimIntent = {
  id: Hex;
  state: string;
  chainId: number;
  escrow: string;
  token: string;
  payer: string;
  amountUnits: string;
  inviteSent?: boolean;
  plan: {
    approve: { chainId: number; from: string; to: string; value: string; data: Hex };
    deposit: { chainId: number; from: string; to: string; value: string; data: Hex };
  } | null;
};

export function checkedClaimPlan(intent: ClaimIntent, account: string, token: string, chainId: number, amountUnits: string) {
  const plan = intent.plan;
  if (intent.state !== "AWAITING_DEPOSIT" || !plan ||
    !isAddress(account) || !isAddress(token) || !isAddress(intent.escrow) ||
    intent.chainId !== chainId || plan.approve.chainId !== chainId || plan.deposit.chainId !== chainId ||
    intent.payer.toLowerCase() !== account.toLowerCase() || plan.approve.from.toLowerCase() !== account.toLowerCase() ||
    plan.deposit.from.toLowerCase() !== account.toLowerCase() || intent.token.toLowerCase() !== token.toLowerCase() ||
    plan.approve.to.toLowerCase() !== token.toLowerCase() || plan.deposit.to.toLowerCase() !== intent.escrow.toLowerCase() ||
    intent.amountUnits !== amountUnits || plan.approve.value !== "0" || plan.deposit.value !== "0") {
    throw new Error("Claim details changed. Start again.");
  }
  try {
    const approve = decodeFunctionData({ abi: tokenAbi, data: plan.approve.data }) as DecodedCall<"approve", readonly [string, bigint]>;
    const deposit = decodeFunctionData({ abi: escrowAbi, data: plan.deposit.data }) as DecodedCall<"deposit", readonly [Hex, Hex, string, bigint]>;
    if (approve.functionName !== "approve" || approve.args[0].toLowerCase() !== intent.escrow.toLowerCase() ||
      approve.args[1] !== BigInt(amountUnits) || deposit.functionName !== "deposit" ||
      deposit.args[0] !== intent.id || deposit.args[2].toLowerCase() !== token.toLowerCase() ||
      deposit.args[3] !== BigInt(amountUnits)) throw new Error("Wrong plan");
  } catch {
    throw new Error("Claim details changed. Start again.");
  }
  return plan;
}
