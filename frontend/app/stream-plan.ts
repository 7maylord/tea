import { decodeFunctionData, erc20Abi, isAddress, parseAbi, type Hex } from "viem";

const streamAbi = parseAbi([
  "function create(address recipient, uint256 amount, uint64 duration) returns (uint256 streamId)",
  "function withdraw(uint256 streamId) returns (uint256 amount)",
  "function cancel(uint256 streamId) returns (uint256 refund)",
]);
export type StreamIntent = {
  id: string; state: string; chainId: number; token: string; streamContract: string;
  sender: string; recipient: string; amountUnits: string; durationSeconds: string; streamId: string | null;
  plan: { approve: { chainId: number; from: string; to: string; value: string; data: Hex };
    create: { chainId: number; from: string; to: string; value: string; data: Hex } } | null;
};
export type StreamAction = { id: string; kind: "withdraw" | "cancel"; state: string; plan: {
  chainId: number; from: string; to: string; value: string; data: Hex } };

export function checkedStreamPlan(intent: StreamIntent, account: string, token: string, chainId: number,
  recipient: string, amountUnits: string, durationSeconds: string) {
  const plan = intent.plan;
  if (intent.state !== "AWAITING_AUTHORIZATION" || !plan || !isAddress(account) || !isAddress(token) ||
    !isAddress(recipient) || !isAddress(intent.streamContract) || intent.chainId !== chainId ||
    plan.approve.chainId !== chainId || plan.create.chainId !== chainId || intent.sender.toLowerCase() !== account.toLowerCase() ||
    plan.approve.from.toLowerCase() !== account.toLowerCase() || plan.create.from.toLowerCase() !== account.toLowerCase() ||
    intent.token.toLowerCase() !== token.toLowerCase() || plan.approve.to.toLowerCase() !== token.toLowerCase() ||
    plan.create.to.toLowerCase() !== intent.streamContract.toLowerCase() || intent.recipient.toLowerCase() !== recipient.toLowerCase() ||
    intent.amountUnits !== amountUnits || intent.durationSeconds !== durationSeconds || plan.approve.value !== "0" || plan.create.value !== "0") {
    throw new Error("Stream details changed. Start again.");
  }
  try {
    const approve = decodeFunctionData({ abi: erc20Abi, data: plan.approve.data });
    const create = decodeFunctionData({ abi: streamAbi, data: plan.create.data });
    if (approve.functionName !== "approve" || approve.args[0].toLowerCase() !== intent.streamContract.toLowerCase() ||
      approve.args[1] !== BigInt(amountUnits) || create.functionName !== "create" ||
      create.args[0].toLowerCase() !== recipient.toLowerCase() || create.args[1] !== BigInt(amountUnits) ||
      create.args[2] !== BigInt(durationSeconds)) throw new Error("Wrong plan");
  } catch { throw new Error("Stream details changed. Start again."); }
  return plan;
}

export function checkedStreamAction(action: StreamAction, account: string, contract: string, chainId: number, streamId: string) {
  if (action.state !== "READY" || action.plan.chainId !== chainId || action.plan.from.toLowerCase() !== account.toLowerCase() ||
    action.plan.to.toLowerCase() !== contract.toLowerCase() || action.plan.value !== "0") throw new Error("Stream action changed. Refresh and try again.");
  try {
    const decoded = decodeFunctionData({ abi: streamAbi, data: action.plan.data });
    if (decoded.functionName !== action.kind || decoded.args[0] !== BigInt(streamId)) throw new Error("Wrong action");
  } catch { throw new Error("Stream action changed. Refresh and try again."); }
  return action.plan;
}
