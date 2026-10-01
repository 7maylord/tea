"use client";

import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { authHeaders } from "./auth";
import { formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useState } from "react";
import { useOnlineStatus } from "./pwa";
import { checkedDateLockAction, checkedStoredDateLockAction, type DateLockAction, type DateLockIntent, type SavedDateLockAction } from "./date-lock-plan";
import { sendWithSponsorFallback } from "./send-transaction";

type DateLockDetail = DateLockIntent & { chainState: null | { unlockAt: string; withdrawn: boolean; withdrawableUnits: string; blockNumber: string; blockTimestamp: string } };

export default function DateLockCard({ id, apiOrigin, userId, decimals = 6 }: { id: string; apiOrigin: string; userId: string; decimals?: number }) {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const online = useOnlineStatus();
  const storageKey = `tea:date-lock-action:${userId}:${id}`;
  const [lock, setLock] = useState<DateLockDetail | null>(null);
  const [saved, setSaved] = useState<SavedDateLockAction | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const record = checkedStoredDateLockAction(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"), id);
      if (!record) sessionStorage.removeItem(storageKey);
      return record;
    } catch { sessionStorage.removeItem(storageKey); return null; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`${apiOrigin}/v1/date-locks/${id}`, { headers: await authHeaders(), cache: "no-store" });
    if (response.ok) setLock(await response.json() as DateLockDetail);
  }, [apiOrigin, id]);
  const save = useCallback((record: SavedDateLockAction) => { sessionStorage.setItem(storageKey, JSON.stringify(record)); setSaved(record); }, [storageKey]);
  const reconcile = useCallback(async (record: SavedDateLockAction) => {
    if (!online || !record.actionId || !record.hash) return;
    try {
      const response = await fetch(`${apiOrigin}/v1/date-locks/${id}/actions/${record.actionId}/submission`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authHeaders(), "Idempotency-Key": record.submitKey },
        body: JSON.stringify({ txHash: record.hash }),
      });
      if (!response.ok) throw new Error("The transaction was submitted. Confirmation is still being checked.");
      const action = await response.json() as DateLockAction;
      if (action.state === "CONFIRMED") { sessionStorage.removeItem(storageKey); setSaved(null); setError(""); await load(); }
      else if (action.state === "FAILED") { sessionStorage.removeItem(storageKey); setSaved(null); setError("Transaction failed."); }
      else setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The transaction was submitted. Confirmation is still being checked."); }
  }, [apiOrigin, id, load, online, storageKey]);
  useEffect(() => {
    if (!online) return;
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { window.clearTimeout(initial); window.clearInterval(refresh); };
  }, [load, online]);
  useEffect(() => {
    if (saved?.stage !== "SUBMITTED") return;
    const initial = window.setTimeout(() => void reconcile(saved), 0);
    const poll = window.setInterval(() => void reconcile(saved), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(poll); };
  }, [reconcile, saved]);
  async function collect() {
    if (!online) { setError("Reconnect before collecting this date lock."); return; }
    if (!lock?.dateLockId || saved) return;
    setBusy(true); setError("");
    try {
      const pending = { intentId: id, actionId: null, prepareKey: crypto.randomUUID(), submitKey: crypto.randomUUID(), stage: "PREPARING" as const };
      save(pending);
      const response = await fetch(`${apiOrigin}/v1/date-locks/${id}/withdraw`, { method: "POST", headers: { ...await authHeaders(), "Idempotency-Key": pending.prepareKey } });
      if (!response.ok) throw new Error("Nothing is available to collect yet.");
      const action = await response.json() as DateLockAction;
      const wallet = wallets.find((item) => item.address.toLowerCase() === lock.recipient.toLowerCase());
      if (!wallet) throw new Error("Settlement wallet unavailable.");
      const plan = checkedDateLockAction(action, wallet.address, lock.dateUnlockContract, lock.chainId, lock.dateLockId);
      const sent = await sendWithSponsorFallback(sendTransaction, { to: plan.to as Hex, data: plan.data, value: BigInt(0), chainId: lock.chainId }, wallet.address);
      const submitted = { ...pending, actionId: action.id, stage: "SUBMITTED" as const, hash: sent.hash };
      save(submitted); await reconcile(submitted);
    } catch (cause) { sessionStorage.removeItem(storageKey); setSaved(null); setError(cause instanceof Error ? cause.message : "Date lock collection failed."); }
    finally { setBusy(false); }
  }
  if (!lock?.chainState) return <p role="status" className="mt-3 text-sm text-stone-600">Loading date-lock details…</p>;
  const walletAddress = wallets.find((item) => item.address.toLowerCase() === lock.recipient.toLowerCase())?.address.toLowerCase();
  const unlocked = BigInt(lock.chainState.blockTimestamp) >= BigInt(lock.chainState.unlockAt);
  const canCollect = walletAddress === lock.recipient.toLowerCase() && unlocked && !lock.chainState.withdrawn && BigInt(lock.chainState.withdrawableUnits) > BigInt(0);
  return <div className="mt-4 rounded-xl bg-stone-50 p-4"><div className="grid grid-cols-2 gap-4"><div><p className="text-xs text-stone-500">Unlocks</p><p className="mt-1 font-semibold">{new Date(Number(lock.chainState.unlockAt) * 1000).toLocaleString()}</p></div><div><p className="text-xs text-stone-500">Available</p><p className="mt-1 font-semibold">{formatUnits(BigInt(lock.chainState.withdrawableUnits), decimals)}</p></div></div><p className="mt-3 text-xs text-stone-500">{lock.chainState.withdrawn ? "Collected" : unlocked ? "Ready to collect" : "Locked"} · checked at block {lock.chainState.blockNumber}</p><div className="mt-4">{saved?.stage === "PREPARING" ? <p role="status" className="text-sm text-stone-600">Preparing collection…</p> : saved?.stage === "SUBMITTED" ? <div><p role="status" className="text-sm text-stone-600">Checking transaction confirmation…</p><button type="button" disabled={!online} onClick={() => void reconcile(saved)} className="mt-3 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">Check status</button></div> : canCollect && <button type="button" disabled={busy || !online} onClick={() => void collect()} className="min-h-11 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-white disabled:opacity-50">Collect {formatUnits(BigInt(lock.chainState.withdrawableUnits), decimals)}</button>}</div>{error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}</div>;
}
