"use client";

import { authHeaders } from "./auth";
import { formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useOnlineStatus } from "./pwa";
import { checkedStreamPlan, type StreamIntent } from "./stream-plan";
import { sendWithSponsorFallback } from "./send-transaction";
import { waitForMeraReceipt } from "./mera";

type Saved = { id: string; recipientAddress: string; reference: string; amountUnits: string; durationSeconds: string; submitKey: string; stage: "APPROVAL_REQUESTED" | "APPROVAL_SUBMITTED" | "READY_CREATE" | "CREATE_REQUESTED" | "CREATE_SUBMITTED"; approvalHash?: Hex; createHash?: Hex };
type StreamDraft = { createKey: string; reference: string; amountUnits: string; durationSeconds: string };
const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50";

export default function StreamSend({ apiOrigin, userId, reference, recipient, amountUnits, durationSeconds, address, chainId, token, decimals, symbol, onBack, onSettled }: {
  apiOrigin: string; userId: string; reference: string; recipient: string;
  amountUnits: string; durationSeconds: string; address: string; chainId: number; token: string;
  decimals: number; symbol: string; onBack: () => void; onSettled: () => void;
}) {
  const online = useOnlineStatus();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [draft, setDraft] = useState<StreamDraft | null>(null);
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const storageKey = `tea:stream:${userId}`;
  const draftKey = `tea:stream-draft:${userId}`;
  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${apiOrigin}${path}`, { ...options, cache: "no-store", headers: { "Content-Type": "application/json", ...await authHeaders(), ...options.headers } });
    if (!response.ok) throw new Error(response.status === 422 ? "Not enough available funds." : "Could not prepare this stream.");
    return response.json() as Promise<StreamIntent>;
  }, [apiOrigin]);
  const save = useCallback((record: Saved) => { sessionStorage.setItem(storageKey, JSON.stringify(record)); setSaved(record); }, [storageKey]);
  const waitFor = useCallback(async (hash: Hex) => {
    await waitForMeraReceipt(chainId, hash);
  }, [chainId]);

  const reconcile = useCallback(async (record: Saved) => {
    if (!record.createHash) return;
    try {
      const stream = await api(`/v1/streams/${record.id}/submission`, { method: "POST", headers: { "Idempotency-Key": record.submitKey }, body: JSON.stringify({ txHash: record.createHash }) });
      if (stream.state === "CONFIRMED") { sessionStorage.removeItem(storageKey); setSaved(null); setDone(true); toast.success("Stream confirmed.", { id: `stream-create:${userId}` }); onSettled(); }
    } catch { toast.loading("Stream submitted. Checking confirmation…", { id: `stream-create:${userId}` }); }
  }, [api, onSettled, storageKey, userId]);
  useEffect(() => {
    const initial = window.setTimeout(() => {
      try { const record = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Saved | null; if (record?.id && record.reference === reference && record.amountUnits === amountUnits && record.durationSeconds === durationSeconds) setSaved(record); } catch { /* Ignore broken local recovery data. */ }
      try { const record = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as StreamDraft | null; if (record?.reference === reference && record.amountUnits === amountUnits && record.durationSeconds === durationSeconds && /^[0-9a-f-]{36}$/.test(record.createKey)) setDraft(record); } catch { /* Ignore broken intent recovery data. */ }
    }, 0);
    return () => window.clearTimeout(initial);
  }, [amountUnits, draftKey, durationSeconds, reference, storageKey]);
  useEffect(() => {
    if (!online || !saved) return;
    if (saved.stage === "APPROVAL_SUBMITTED" && saved.approvalHash) {
      const initial = window.setTimeout(() => void waitFor(saved.approvalHash!).then(() => {
        save({ ...saved, stage: "READY_CREATE" });
        toast.success("Funding approved. You can create the stream now.", { id: `stream-create:${userId}` });
      }).catch(() => toast.loading("Approval submitted. Checking confirmation…", { id: `stream-create:${userId}` })), 0);
      return () => window.clearTimeout(initial);
    }
    if (saved.stage === "CREATE_SUBMITTED" && saved.createHash) {
      const initial = window.setTimeout(() => void reconcile(saved), 0), poll = window.setInterval(() => void reconcile(saved), 5000);
      return () => { window.clearTimeout(initial); window.clearInterval(poll); };
    }
  }, [online, reconcile, save, saved, userId, waitFor]);
  async function approve() {
    if (!online) { toast.error("Reconnect before approving this stream.", { id: `stream-create:${userId}` }); return; }
    setBusy(true);
    toast.loading("Confirm stream funding in your wallet…", { id: `stream-create:${userId}` });
    try {
      const request = draft ?? { createKey: crypto.randomUUID(), reference, amountUnits, durationSeconds };
      if (!draft) { sessionStorage.setItem(draftKey, JSON.stringify(request)); setDraft(request); }
      const stream = await api("/v1/streams", { method: "POST", headers: { "Idempotency-Key": request.createKey }, body: JSON.stringify({ recipientReference: request.reference, amountUnits: request.amountUnits, durationSeconds: request.durationSeconds }) });
      const plan = checkedStreamPlan(stream, address, token, chainId, stream.recipient, amountUnits, durationSeconds);
      const record: Saved = { id: stream.id, recipientAddress: stream.recipient, reference, amountUnits, durationSeconds, submitKey: crypto.randomUUID(), stage: "APPROVAL_REQUESTED" };
      save(record); sessionStorage.removeItem(draftKey); setDraft(null);
      const sent = await sendWithSponsorFallback(userId, { to: plan.approve.to as Hex, data: plan.approve.data, value: BigInt(0), chainId }, address);
      const submitted = { ...record, stage: "APPROVAL_SUBMITTED" as const, approvalHash: sent.hash };
      save(submitted); await waitFor(sent.hash); save({ ...submitted, stage: "READY_CREATE" });
      toast.success("Funding approved. You can create the stream now.", { id: `stream-create:${userId}` });
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Could not approve stream funding.", { id: `stream-create:${userId}` }); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!online) { toast.error("Reconnect before creating this stream.", { id: `stream-create:${userId}` }); return; }
    if (!saved || saved.stage !== "READY_CREATE") return;
    setBusy(true); toast.loading("Confirm stream creation in your wallet…", { id: `stream-create:${userId}` });
    try {
      const stream = await api(`/v1/streams/${saved.id}`);
      const plan = checkedStreamPlan(stream, address, token, chainId, saved.recipientAddress, amountUnits, durationSeconds);
      save({ ...saved, stage: "CREATE_REQUESTED" });
      const sent = await sendWithSponsorFallback(userId, { to: plan.create.to as Hex, data: plan.create.data, value: BigInt(0), chainId }, address);
      const submitted = { ...saved, stage: "CREATE_SUBMITTED" as const, createHash: sent.hash };
      save(submitted); await reconcile(submitted);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Could not create the stream.", { id: `stream-create:${userId}` }); }
    finally { setBusy(false); }
  }
  return <><button type="button" onClick={onBack} className="mb-5 min-h-11 self-start text-sm font-semibold text-orange-700">← {done ? "Back" : "Edit stream"}</button><h1 className="text-4xl font-semibold tracking-tight">Pay over time</h1><div className="mt-8 rounded-3xl border border-stone-200 bg-white p-6"><p className="text-sm text-stone-500">Recipient</p><p className="mt-1 font-semibold">{recipient}</p><p className="mt-5 text-sm text-stone-500">Funded upfront</p><p className="mt-1 text-3xl font-semibold">{formatUnits(BigInt(amountUnits), decimals)} {symbol}</p><p className="mt-5 text-sm leading-6 text-stone-600">Streams evenly over {Number(durationSeconds) < 3600 ? `${Number(durationSeconds) / 60} minutes` : `${Number(durationSeconds) / 3600} hours`}. The recipient collects accrued funds. You can stop future accrual and recover only the unaccrued amount.</p>{done ? <p className="mt-6 font-semibold text-emerald-800">Stream confirmed.</p> : !saved ? <button type="button" disabled={busy || !online} onClick={() => void approve()} className={`${button} mt-7 w-full`}>{busy ? "Approving…" : draft ? "Retry setup" : "Approve stream funding"}</button> : saved.stage === "READY_CREATE" ? <button type="button" disabled={busy || !online} onClick={() => void create()} className={`${button} mt-7 w-full`}>{busy ? "Creating…" : "Create funded stream"}</button> : saved.stage === "APPROVAL_REQUESTED" ? <div className="mt-6"><p className="text-sm font-semibold text-amber-800">Approval was not submitted.</p><button type="button" disabled={busy || !online} onClick={() => void approve()} className={`${button} mt-4 w-full`}>{busy ? "Approving…" : "Retry approval"}</button></div> : saved.stage === "CREATE_REQUESTED" ? <div className="mt-6"><p className="text-sm font-semibold text-amber-800">Stream was not submitted.</p><button type="button" disabled={busy || !online} onClick={() => void create()} className={`${button} mt-4 w-full`}>{busy ? "Creating…" : "Retry stream"}</button></div> : <p role="status" className="mt-6 text-sm text-stone-600">{saved.stage === "APPROVAL_SUBMITTED" ? "Checking approval…" : "Checking stream confirmation…"}</p>}</div></>;
}
