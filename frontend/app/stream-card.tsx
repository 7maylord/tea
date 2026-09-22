"use client";

import { getIdentityToken, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useMemo, useState } from "react";
import { checkedStoredStreamAction, checkedStreamAction, type SavedStreamAction, type StreamAction, type StreamIntent } from "./stream-plan";

type StreamDetail = StreamIntent & { chainState: null | {
  start: string; end: string; withdrawnUnits: string; canceled: boolean;
  recipientEntitlementUnits: string | null; withdrawableUnits: string;
  blockNumber: string; blockTimestamp: string;
} };
export default function StreamCard({ id, apiOrigin, userId, decimals = 6 }: { id: string; apiOrigin: string; userId: string; decimals?: number }) {
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const storageKey = `tea:stream-action:${userId}:${id}`;
  const [stream, setStream] = useState<StreamDetail | null>(null);
  const [clock, setClock] = useState(0);
  const [anchor, setAnchor] = useState<{ chainTimestamp: number; monotonic: number } | null>(null);
  const [saved, setSaved] = useState<SavedStreamAction | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const record = checkedStoredStreamAction(JSON.parse(sessionStorage.getItem(storageKey) ?? "null"), id);
      if (!record) sessionStorage.removeItem(storageKey);
      return record;
    } catch { sessionStorage.removeItem(storageKey); return null; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = useCallback(async () => {
    const token = await getIdentityToken();
    if (!token) return;
    const response = await fetch(`${apiOrigin}/v1/streams/${id}`, { headers: { "privy-id-token": token }, cache: "no-store" });
    if (response.ok) {
      const next = await response.json() as StreamDetail;
      setStream(next);
      if (next.chainState) setAnchor({ chainTimestamp: Number(next.chainState.blockTimestamp), monotonic: performance.now() });
    }
  }, [apiOrigin, id]);
  const save = useCallback((record: SavedStreamAction) => {
    sessionStorage.setItem(storageKey, JSON.stringify(record));
    setSaved(record);
  }, [storageKey]);
  const reconcile = useCallback(async (record: SavedStreamAction) => {
    if (!record.actionId || !record.hash) return;
    try {
      const identity = await getIdentityToken();
      if (!identity) throw new Error("Sign in again.");
      const response = await fetch(`${apiOrigin}/v1/streams/${id}/actions/${record.actionId}/submission`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "privy-id-token": identity, "Idempotency-Key": record.submitKey },
        body: JSON.stringify({ txHash: record.hash }),
      });
      if (!response.ok) throw new Error("The transaction was submitted. Confirmation is still being checked.");
      const action = await response.json() as StreamAction;
      if (action.state === "CONFIRMED") {
        sessionStorage.removeItem(storageKey); setSaved(null); setError(""); await load();
      } else if (action.state === "FAILED") {
        sessionStorage.removeItem(storageKey); setSaved(null); setError("Transaction failed.");
      } else setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The transaction was submitted. Confirmation is still being checked.");
    }
  }, [apiOrigin, id, load, storageKey]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    const tick = window.setInterval(() => setClock(performance.now()), 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(refresh); window.clearInterval(tick); };
  }, [load]);
  useEffect(() => {
    if (saved?.stage !== "SUBMITTED") return;
    const initial = window.setTimeout(() => void reconcile(saved), 0);
    const poll = window.setInterval(() => void reconcile(saved), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(poll); };
  }, [reconcile, saved]);
  const estimate = useMemo(() => {
    if (!stream?.chainState || !anchor) return null;
    const state = stream.chainState, deposit = BigInt(stream.amountUnits), start = BigInt(state.start), end = BigInt(state.end);
    const chainNow = BigInt(anchor.chainTimestamp + Math.max(0, Math.floor((clock - anchor.monotonic) / 1000)));
    const at = chainNow <= start ? BigInt(0) : chainNow >= end ? end - start : chainNow - start;
    const vested = state.canceled && state.recipientEntitlementUnits !== null
      ? BigInt(state.recipientEntitlementUnits) : deposit * at / (end - start);
    return { vested, available: vested > BigInt(state.withdrawnUnits) ? vested - BigInt(state.withdrawnUnits) : BigInt(0) };
  }, [anchor, clock, stream]);
  async function act(kind: "withdraw" | "cancel") {
    if (!stream?.streamId || (saved && saved.stage !== "PREPARING")) return;
    setBusy(true); setError("");
    try {
      const pending = saved ?? { intentId: id, actionId: null, prepareKey: crypto.randomUUID(), submitKey: crypto.randomUUID(), kind, stage: "PREPARING" as const };
      if (pending.kind !== kind) return;
      if (!saved) save(pending);
      const identity = await getIdentityToken();
      if (!identity) throw new Error("Sign in again.");
      const response = await fetch(`${apiOrigin}/v1/streams/${id}/${kind}`, { method: "POST", headers: { "privy-id-token": identity, "Idempotency-Key": pending.prepareKey } });
      if (!response.ok) throw new Error(kind === "withdraw" ? "Nothing is available to collect yet." : "This stream can no longer be stopped.");
      const action = await response.json() as StreamAction;
      const expected = kind === "withdraw" ? stream.recipient : stream.sender;
      const wallet = wallets.find((item) => item.address.toLowerCase() === expected.toLowerCase());
      if (!wallet) throw new Error("Settlement wallet unavailable.");
      const plan = checkedStreamAction(action, kind, wallet.address, stream.streamContract, stream.chainId, stream.streamId);
      const requested = { ...pending, actionId: action.id, stage: "WALLET_REQUESTED" as const };
      save(requested);
      const sent = await sendTransaction({ to: plan.to as Hex, data: plan.data, value: BigInt(0), chainId: stream.chainId }, { address: wallet.address, sponsor: stream.chainId !== 31337 });
      const submitted = { ...requested, stage: "SUBMITTED" as const, hash: sent.hash };
      save(submitted); await reconcile(submitted);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Stream action failed."); }
    finally { setBusy(false); }
  }
  if (!stream?.chainState || !estimate) return <p role="status" className="mt-3 text-sm text-stone-600">Loading stream details…</p>;
  const walletAddress = wallets.find((item) => [stream.sender, stream.recipient].includes(item.address.toLowerCase()))?.address.toLowerCase();
  const canCollect = walletAddress === stream.recipient && estimate.available > BigInt(0);
  const canCancel = walletAddress === stream.sender && !stream.chainState.canceled && (!anchor || anchor.chainTimestamp + Math.max(0, Math.floor((clock - anchor.monotonic) / 1000)) < Number(stream.chainState.end));
  return <div className="mt-4 rounded-xl bg-stone-50 p-4"><div className="grid grid-cols-2 gap-4"><div><p className="text-xs text-stone-500">Accrued estimate</p><p className="mt-1 font-semibold">{formatUnits(estimate.vested, decimals)}</p></div><div><p className="text-xs text-stone-500">Collected</p><p className="mt-1 font-semibold">{formatUnits(BigInt(stream.chainState.withdrawnUnits), decimals)}</p></div></div><p className="mt-3 text-xs text-stone-500">{stream.chainState.canceled ? "Accrual stopped" : `Ends ${new Date(Number(stream.chainState.end) * 1000).toLocaleString()}`} · checked at block {stream.chainState.blockNumber}</p><div className="mt-4 flex gap-2">{saved?.stage === "PREPARING" ? <button type="button" disabled={busy} onClick={() => void act(saved.kind)} className="min-h-11 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Preparing…" : "Retry action setup"}</button> : saved?.stage === "WALLET_REQUESTED" ? <p className="text-sm font-semibold text-amber-800">Wallet submission is uncertain. Check wallet activity before trying again.</p> : saved?.stage === "SUBMITTED" ? <div><p role="status" className="text-sm text-stone-600">Checking transaction confirmation…</p><button type="button" onClick={() => void reconcile(saved)} className="mt-3 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold">Check status</button></div> : <>{canCollect && <button type="button" disabled={busy} onClick={() => void act("withdraw")} className="min-h-11 rounded-xl bg-stone-900 px-4 text-sm font-semibold text-white disabled:opacity-50">Collect {formatUnits(estimate.available, decimals)}</button>}{canCancel && <button type="button" disabled={busy} onClick={() => void act("cancel")} className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">Stop stream</button>}</>}</div>{error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}</div>;
}
