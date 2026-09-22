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
  chainId: number; from: string; to: string; value: string; data: Hex } | null };
export type SavedStreamAction = {
  intentId: string; actionId: string | null; prepareKey: string; submitKey: string;
  kind: "withdraw" | "cancel"; stage: "PREPARING" | "WALLET_REQUESTED" | "SUBMITTED"; hash?: Hex;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^0x[0-9a-f]{64}$/i;

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

export function checkedStreamAction(action: StreamAction, kind: "withdraw" | "cancel", account: string, contract: string, chainId: number, streamId: string) {
  const plan = action.plan;
  if (!uuidPattern.test(action.id) || action.kind !== kind || action.state !== "READY" || !plan || plan.chainId !== chainId || plan.from.toLowerCase() !== account.toLowerCase() ||
    plan.to.toLowerCase() !== contract.toLowerCase() || plan.value !== "0") throw new Error("Stream action changed. Refresh and try again.");
  try {
    const decoded = decodeFunctionData({ abi: streamAbi, data: plan.data });
    if (decoded.functionName !== action.kind || decoded.args[0] !== BigInt(streamId)) throw new Error("Wrong action");
  } catch { throw new Error("Stream action changed. Refresh and try again."); }
  return plan;
}

export function checkedStoredStreamAction(value: unknown, intentId: string): SavedStreamAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.intentId !== intentId || typeof record.prepareKey !== "string" || !uuidPattern.test(record.prepareKey) ||
    typeof record.submitKey !== "string" || !uuidPattern.test(record.submitKey) ||
    (record.kind !== "withdraw" && record.kind !== "cancel") ||
    (record.stage !== "PREPARING" && record.stage !== "WALLET_REQUESTED" && record.stage !== "SUBMITTED") ||
    (record.actionId !== null && (typeof record.actionId !== "string" || !uuidPattern.test(record.actionId))) ||
    (record.hash !== undefined && (typeof record.hash !== "string" || !hashPattern.test(record.hash))) ||
    (record.stage === "PREPARING" ? record.actionId !== null || record.hash !== undefined :
      record.stage === "WALLET_REQUESTED" ? record.actionId === null || record.hash !== undefined : record.actionId === null || record.hash === undefined)) return null;
  return record as SavedStreamAction;
}
