import { decodeFunctionData, erc20Abi, isAddress, parseAbi, type Hex } from "viem";

const escrowAbi = parseAbi(["function deposit(bytes32 claimId, bytes32 commitment, uint256 amount)"]);

export type ClaimIntent = {
  id: Hex;
  state: string;
  chainId: number;
  escrow: string;
  token: string;
  payer: string;
  amountUnits: string;
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
    const approve = decodeFunctionData({ abi: erc20Abi, data: plan.approve.data });
    const deposit = decodeFunctionData({ abi: escrowAbi, data: plan.deposit.data });
    if (approve.functionName !== "approve" || approve.args[0].toLowerCase() !== intent.escrow.toLowerCase() ||
      approve.args[1] !== BigInt(amountUnits) || deposit.functionName !== "deposit" ||
      deposit.args[0] !== intent.id || deposit.args[2] !== BigInt(amountUnits)) throw new Error("Wrong plan");
  } catch {
    throw new Error("Claim details changed. Start again.");
  }
  return plan;
}
