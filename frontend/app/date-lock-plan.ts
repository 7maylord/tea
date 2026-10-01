import { decodeFunctionData, isAddress, type Abi, type Hex } from "viem";
import dateUnlockAbiJson from "../abi/TeaDateUnlock.json" with { type: "json" };
import tokenAbiJson from "../abi/TestUSD.json" with { type: "json" };

const dateUnlockAbi = dateUnlockAbiJson as Abi;
const tokenAbi = tokenAbiJson as Abi;
type DecodedCall<Name extends string, Args extends readonly unknown[]> = { functionName: Name; args: Args };

export type DateLockIntent = {
  id: string;
  state: string;
  chainId: number;
  token: string;
  dateUnlockContract: string;
  sender: string;
  recipient: string;
  amountUnits: string;
  unlockAt: string;
  dateLockId: string | null;
  plan: {
    approve: { chainId: number; from: string; to: string; value: string; data: Hex };
    create: { chainId: number; from: string; to: string; value: string; data: Hex };
  } | null;
};
export type DateLockAction = {
  id: string;
  kind: "withdraw";
  state: string;
  txHash: Hex | null;
  amountUnits: string | null;
  blockNumber: string | null;
  plan: { chainId: number; from: string; to: string; value: string; data: Hex } | null;
};
export type SavedDateLockAction = {
  intentId: string;
  actionId: string | null;
  prepareKey: string;
  submitKey: string;
  stage: "PREPARING" | "SUBMITTED";
  hash?: Hex;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^0x[0-9a-f]{64}$/i;

export function checkedDateLockPlan(
  intent: DateLockIntent,
  account: string,
  token: string,
  chainId: number,
  recipient: string,
  amountUnits: string,
  unlockAt: string,
) {
  const plan = intent.plan;
  const unlockSeconds = BigInt(Math.floor(Date.parse(unlockAt) / 1000));
  if (
    intent.state !== "AWAITING_AUTHORIZATION" ||
    !plan ||
    !Number.isFinite(Date.parse(unlockAt)) ||
    !isAddress(account) ||
    !isAddress(token) ||
    !isAddress(recipient) ||
    !isAddress(intent.dateUnlockContract) ||
    intent.chainId !== chainId ||
    plan.approve.chainId !== chainId ||
    plan.create.chainId !== chainId ||
    intent.sender.toLowerCase() !== account.toLowerCase() ||
    plan.approve.from.toLowerCase() !== account.toLowerCase() ||
    plan.create.from.toLowerCase() !== account.toLowerCase() ||
    intent.token.toLowerCase() !== token.toLowerCase() ||
    plan.approve.to.toLowerCase() !== token.toLowerCase() ||
    plan.create.to.toLowerCase() !== intent.dateUnlockContract.toLowerCase() ||
    intent.recipient.toLowerCase() !== recipient.toLowerCase() ||
    intent.amountUnits !== amountUnits ||
    Math.floor(Date.parse(intent.unlockAt) / 1000) !== Number(unlockSeconds) ||
    plan.approve.value !== "0" ||
    plan.create.value !== "0"
  ) {
    throw new Error("Date lock details changed. Start again.");
  }
  try {
    const approve = decodeFunctionData({ abi: tokenAbi, data: plan.approve.data }) as DecodedCall<"approve", readonly [string, bigint]>;
    const create = decodeFunctionData({ abi: dateUnlockAbi, data: plan.create.data }) as DecodedCall<"create", readonly [string, bigint, bigint]>;
    if (
      approve.functionName !== "approve" ||
      approve.args[0].toLowerCase() !== intent.dateUnlockContract.toLowerCase() ||
      approve.args[1] !== BigInt(amountUnits) ||
      create.functionName !== "create" ||
      create.args[0].toLowerCase() !== recipient.toLowerCase() ||
      create.args[1] !== BigInt(amountUnits) ||
      create.args[2] !== unlockSeconds
    ) throw new Error("Wrong plan");
  } catch {
    throw new Error("Date lock details changed. Start again.");
  }
  return plan;
}

export function checkedDateLockAction(action: DateLockAction, account: string, contract: string, chainId: number, lockId: string) {
  const plan = action.plan;
  if (
    !uuidPattern.test(action.id) ||
    action.kind !== "withdraw" ||
    action.state !== "READY" ||
    !plan ||
    plan.chainId !== chainId ||
    plan.from.toLowerCase() !== account.toLowerCase() ||
    plan.to.toLowerCase() !== contract.toLowerCase() ||
    plan.value !== "0"
  ) throw new Error("Date lock action changed. Refresh and try again.");
  try {
    const decoded = decodeFunctionData({ abi: dateUnlockAbi, data: plan.data }) as DecodedCall<"withdraw", readonly [bigint]>;
    if (decoded.functionName !== "withdraw" || decoded.args[0] !== BigInt(lockId)) throw new Error("Wrong action");
  } catch {
    throw new Error("Date lock action changed. Refresh and try again.");
  }
  return plan;
}

export function checkedStoredDateLockAction(value: unknown, intentId: string): SavedDateLockAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.intentId !== intentId ||
    typeof record.prepareKey !== "string" ||
    !uuidPattern.test(record.prepareKey) ||
    typeof record.submitKey !== "string" ||
    !uuidPattern.test(record.submitKey) ||
    (record.stage !== "PREPARING" && record.stage !== "SUBMITTED") ||
    (record.actionId !== null && (typeof record.actionId !== "string" || !uuidPattern.test(record.actionId))) ||
    (record.hash !== undefined && (typeof record.hash !== "string" || !hashPattern.test(record.hash))) ||
    (record.stage === "PREPARING" ? record.actionId !== null || record.hash !== undefined : record.actionId === null || record.hash === undefined)
  ) return null;
  return record as SavedDateLockAction;
}
