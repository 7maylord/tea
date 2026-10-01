"use client";

import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { authHeaders } from "./auth";
import { createPublicClient, custom, formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useState } from "react";
import { useOnlineStatus } from "./pwa";
import { checkedDateLockPlan, type DateLockIntent } from "./date-lock-plan";
import { sendWithSponsorFallback } from "./send-transaction";

type Saved = { id: string; recipientAddress: string; reference: string; amountUnits: string; unlockAt: string; submitKey: string; stage: "APPROVAL_REQUESTED" | "APPROVAL_SUBMITTED" | "READY_CREATE" | "CREATE_REQUESTED" | "CREATE_SUBMITTED"; approvalHash?: Hex; createHash?: Hex };
type Draft = { createKey: string; reference: string; amountUnits: string; unlockAt: string };
const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50";

export default function DateLockSend({ apiOrigin, userId, reference, recipient, amountUnits, unlockAt, address, chainId, token, decimals, symbol, onBack, onSettled }: {
  apiOrigin: string; userId: string; reference: string; recipient: string; amountUnits: string; unlockAt: string;
  address: string; chainId: number; token: string; decimals: number; symbol: string; onBack: () => void; onSettled: () => void;
}) {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const online = useOnlineStatus();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [error, setError] = useState("");
  const storageKey = `tea:date-lock:${userId}`;
  const draftKey = `tea:date-lock-draft:${userId}`;
  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${apiOrigin}${path}`, { ...options, cache: "no-store", headers: { "Content-Type": "application/json", ...await authHeaders(), ...options.headers } });
    if (!response.ok) throw new Error(response.status === 422 ? "Not enough available funds." : "Could not prepare this date lock.");
    return response.json() as Promise<DateLockIntent>;
  }, [apiOrigin]);
  const save = useCallback((record: Saved) => { sessionStorage.setItem(storageKey, JSON.stringify(record)); setSaved(record); }, [storageKey]);
  const waitFor = useCallback(async (hash: Hex) => {
    const wallet = wallets.find((item) => item.address.toLowerCase() === address.toLowerCase());
    if (!wallet) throw new Error("Settlement wallet unavailable.");
    const receipt = await createPublicClient({ transport: custom(await wallet.getEthereumProvider()) }).waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("Transaction failed.");
  }, [address, wallets]);
  const reconcile = useCallback(async (record: Saved) => {
    if (!record.createHash) return;
    try {
      const lock = await api(`/v1/date-locks/${record.id}/submission`, { method: "POST", headers: { "Idempotency-Key": record.submitKey }, body: JSON.stringify({ txHash: record.createHash }) });
      if (lock.state === "CONFIRMED") { sessionStorage.removeItem(storageKey); setSaved(null); setDone(true); setError(""); onSettled(); }
    } catch { setError("The date lock was submitted. Confirmation is still being checked."); }
  }, [api, onSettled, storageKey]);
  useEffect(() => {
    const initial = window.setTimeout(() => {
      try { const record = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Saved | null; if (record?.id && record.reference === reference && record.amountUnits === amountUnits && record.unlockAt === unlockAt) setSaved(record); } catch { /* Ignore broken local recovery data. */ }
      try { const record = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as Draft | null; if (record?.reference === reference && record.amountUnits === amountUnits && record.unlockAt === unlockAt && /^[0-9a-f-]{36}$/.test(record.createKey)) setDraft(record); } catch { /* Ignore broken intent recovery data. */ }
    }, 0);
    return () => window.clearTimeout(initial);
  }, [amountUnits, draftKey, reference, storageKey, unlockAt]);
  useEffect(() => {
    if (!online || !saved) return;
    if (saved.stage === "APPROVAL_SUBMITTED" && saved.approvalHash) {
      const initial = window.setTimeout(() => void waitFor(saved.approvalHash!).then(() => save({ ...saved, stage: "READY_CREATE" })).catch(() => setError("Approval is still being checked.")), 0);
      return () => window.clearTimeout(initial);
    }
    if (saved.stage === "CREATE_SUBMITTED" && saved.createHash) {
      const initial = window.setTimeout(() => void reconcile(saved), 0), poll = window.setInterval(() => void reconcile(saved), 5000);
      return () => { window.clearTimeout(initial); window.clearInterval(poll); };
    }
  }, [online, reconcile, save, saved, waitFor]);
  async function approve() {
    if (!online) { setError("Reconnect before approving this date lock."); return; }
    setBusy(true); setError("");
    try {
      const request = draft ?? { createKey: crypto.randomUUID(), reference, amountUnits, unlockAt };
      if (!draft) { sessionStorage.setItem(draftKey, JSON.stringify(request)); setDraft(request); }
      const lock = await api("/v1/date-locks", { method: "POST", headers: { "Idempotency-Key": request.createKey }, body: JSON.stringify({ recipientReference: request.reference, amountUnits: request.amountUnits, unlockAt: request.unlockAt }) });
      const plan = checkedDateLockPlan(lock, address, token, chainId, lock.recipient, amountUnits, unlockAt);
      const record: Saved = { id: lock.id, recipientAddress: lock.recipient, reference, amountUnits, unlockAt, submitKey: crypto.randomUUID(), stage: "APPROVAL_REQUESTED" };
      save(record); sessionStorage.removeItem(draftKey); setDraft(null);
      const sent = await sendWithSponsorFallback(sendTransaction, { to: plan.approve.to as Hex, data: plan.approve.data, value: BigInt(0), chainId }, address);
      const submitted = { ...record, stage: "APPROVAL_SUBMITTED" as const, approvalHash: sent.hash };
      save(submitted); await waitFor(sent.hash); save({ ...submitted, stage: "READY_CREATE" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not approve date-lock funding."); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!online) { setError("Reconnect before creating this date lock."); return; }
    if (!saved || saved.stage !== "READY_CREATE") return;
    setBusy(true); setError("");
    try {
      const lock = await api(`/v1/date-locks/${saved.id}`);
      const plan = checkedDateLockPlan(lock, address, token, chainId, saved.recipientAddress, amountUnits, unlockAt);
      save({ ...saved, stage: "CREATE_REQUESTED" });
      const sent = await sendWithSponsorFallback(sendTransaction, { to: plan.create.to as Hex, data: plan.create.data, value: BigInt(0), chainId }, address);
      const submitted = { ...saved, stage: "CREATE_SUBMITTED" as const, createHash: sent.hash };
      save(submitted); await reconcile(submitted);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the date lock."); }
    finally { setBusy(false); }
  }
  return <><button type="button" onClick={onBack} className="mb-5 min-h-11 self-start text-sm font-semibold text-orange-700">← {done ? "Back" : "Edit date lock"}</button><h1 className="text-4xl font-semibold tracking-tight">Unlock later</h1><div className="mt-8 rounded-3xl border border-stone-200 bg-white p-6"><p className="text-sm text-stone-500">Recipient</p><p className="mt-1 font-semibold">{recipient}</p><p className="mt-5 text-sm text-stone-500">Amount</p><p className="mt-1 text-3xl font-semibold">{formatUnits(BigInt(amountUnits), decimals)} {symbol}</p><p className="mt-5 text-sm text-stone-500">Unlocks</p><p className="mt-1 font-semibold">{new Date(unlockAt).toLocaleString()}</p><p className="mt-5 text-sm leading-6 text-stone-600">The full amount is funded now. The recipient can collect it after the unlock time.</p>{done ? <p className="mt-6 font-semibold text-emerald-800">Date lock confirmed.</p> : !saved ? <button type="button" disabled={busy || !online} onClick={() => void approve()} className={`${button} mt-7 w-full`}>{busy ? "Approving…" : draft ? "Retry setup" : "Approve date-lock funding"}</button> : saved.stage === "READY_CREATE" ? <button type="button" disabled={busy || !online} onClick={() => void create()} className={`${button} mt-7 w-full`}>{busy ? "Creating…" : "Create date lock"}</button> : saved.stage === "APPROVAL_REQUESTED" ? <div className="mt-6"><p className="text-sm font-semibold text-amber-800">Approval was not submitted.</p><button type="button" disabled={busy || !online} onClick={() => void approve()} className={`${button} mt-4 w-full`}>{busy ? "Approving…" : "Retry approval"}</button></div> : saved.stage === "CREATE_REQUESTED" ? <div className="mt-6"><p className="text-sm font-semibold text-amber-800">Date lock was not submitted.</p><button type="button" disabled={busy || !online} onClick={() => void create()} className={`${button} mt-4 w-full`}>{busy ? "Creating…" : "Retry date lock"}</button></div> : <p role="status" className="mt-6 text-sm text-stone-600">{saved.stage === "APPROVAL_SUBMITTED" ? "Checking approval…" : "Checking date-lock confirmation…"}</p>}</div>{error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}</>;
}
