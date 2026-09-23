"use client";

import { getIdentityToken } from "@privy-io/react-auth";
import { useCallback, useEffect, useState } from "react";
import { useOnlineStatus } from "./pwa";
import StreamCard from "./stream-card";

type Payment = {
  id: string;
  kind: string;
  direction: string;
  state: string;
  amountUnits: string;
  createdAt: string;
  txHash: string | null;
  indexedReceipt: { id: string } | null;
  claimId: string | null;
  claimExpiry: string | null;
};
type Thread = {
  id: string;
  counterpartyHandle: string | null;
  latestPayment: { kind: string; state: string } | null;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Detail = { counterpartyHandle: string | null; activity: Page<Payment> & { indexerAvailable: boolean } };

function money(units: string) {
  const value = BigInt(units);
  const whole = value / BigInt(1_000_000);
  const cents = ((value % BigInt(1_000_000)) / BigInt(10_000)).toString().padStart(2, "0");
  return `$${whole}.${cents}`;
}

export default function Activity({ apiOrigin, userId }: { apiOrigin: string; userId: string }) {
  const online = useOnlineStatus();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [claims, setClaims] = useState<Payment[]>([]);
  const [counterparty, setCounterparty] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [indexerAvailable, setIndexerAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [claimAction, setClaimAction] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal, cursor?: string) => {
    try {
      const token = await getIdentityToken();
      if (!token) throw new Error("Sign in again to view your activity.");
      const path = selected ? `/v1/threads/${selected}` : "/v1/threads";
      const headers = { "privy-id-token": token };
      const [response, claimResponse] = await Promise.all([
        fetch(`${apiOrigin}${path}${cursor ? `?cursor=${cursor}` : ""}`, { headers, cache: "no-store", signal }),
        !selected && !cursor ? fetch(`${apiOrigin}/v1/activity`, { headers, cache: "no-store", signal }) : null,
      ]);
      if (!response.ok || (claimResponse && !claimResponse.ok)) throw new Error("Could not load activity. Try again.");
      if (selected) {
        const detail = (await response.json()) as Detail;
        setPayments((current) => cursor ? [...current, ...detail.activity.items] : detail.activity.items);
        setCounterparty(detail.counterpartyHandle);
        setIndexerAvailable(detail.activity.indexerAvailable);
        setNextCursor(detail.activity.nextCursor);
      } else {
        const page = (await response.json()) as Page<Thread>;
        setThreads((current) => cursor ? [...current, ...page.items] : page.items);
        if (claimResponse) {
          const activity = (await claimResponse.json()) as Page<Payment>;
          setClaims(activity.items.filter((payment) => payment.kind === "CLAIM" && payment.state !== "CONFIRMED"));
        }
        setNextCursor(page.nextCursor);
      }
      setNow(Date.now());
      setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load activity.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiOrigin, selected]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    }, 15_000);
    const onFocus = () => void refresh(controller.signal);
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  async function claimRequest(claim: Payment, action: "resend" | "refund") {
    if (!online) { setError("Reconnect before updating this claim."); return; }
    if (!claim.claimId || claimAction) return;
    setClaimAction(claim.id);
    setError("");
    setNotice("");
    try {
      const token = await getIdentityToken();
      if (!token) throw new Error("Sign in again to manage this claim.");
      const response = await fetch(`${apiOrigin}/v1/claims/${claim.claimId}/${action}`, {
        method: "POST",
        headers: { "privy-id-token": token, "Idempotency-Key": crypto.randomUUID() },
      });
      if (!response.ok) throw new Error(response.status === 429 ? "Wait before sending another invitation." : action === "refund" ? "This claim is not refundable yet." : "Could not resend this invitation.");
      setNotice(action === "refund" ? "Refund queued. Activity will update after chain confirmation." : "Invitation queued for delivery.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this claim.");
    } finally { setClaimAction(null); }
  }

  return <>
    {selected ? <>
      <button type="button" onClick={() => { setSelected(null); setLoading(true); }} className="mb-5 self-start text-sm font-semibold text-orange-700">← All activity</button>
      <h1 className="text-4xl font-semibold tracking-tight">{counterparty ? `@${counterparty}` : "Payment thread"}</h1>
      {!indexerAvailable && payments.some((payment) => payment.state === "CONFIRMED") && <p role="status" className="mt-4 text-sm text-stone-600">Confirmed payments may take a moment to appear in activity.</p>}
      <div className="mt-8 space-y-3">
        {payments.map((payment) => <article key={payment.id} className="rounded-2xl border border-stone-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-semibold">{payment.direction === "INCOMING" ? "Received" : "Sent"} · {payment.kind === "STREAM" ? "Stream" : "Payment"}</p><p className="mt-1 text-sm text-stone-500">{new Date(payment.createdAt).toLocaleString()}</p></div>
            <p className="font-semibold">{money(payment.amountUnits)}</p>
          </div>
          <p className="mt-3 text-sm text-stone-700">{payment.state === "CONFIRMED" ? payment.indexedReceipt ? "Confirmed receipt" : "Confirmed; activity updating" : payment.state.replaceAll("_", " ").toLowerCase()}</p>
          {payment.kind === "STREAM" && payment.state === "CONFIRMED" && <StreamCard id={payment.id} apiOrigin={apiOrigin} userId={userId} />}
        </article>)}
        {!loading && payments.length === 0 && <p className="text-stone-600">No payments in this thread yet.</p>}
      </div>
    </> : <>
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">Your money</p>
      <h1 className="text-4xl font-semibold tracking-tight">Activity</h1>
      {claims.length > 0 && <div className="mt-8 space-y-3">{claims.map((claim) => {
        const expired = claim.claimExpiry ? new Date(claim.claimExpiry).getTime() <= now : false;
        return <article key={claim.id} className="rounded-2xl border border-stone-200 bg-white p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">Email claim</p><p className="mt-1 text-sm text-stone-500">{claim.state === "REFUNDED" ? "Refunded" : expired ? "Refund available" : "Waiting for recipient"}</p></div><p className="font-semibold">{money(claim.amountUnits)}</p></div>{claim.state === "OPEN" && <button type="button" disabled={!online || claimAction === claim.id} onClick={() => void claimRequest(claim, expired ? "refund" : "resend")} className="mt-4 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">{claimAction === claim.id ? "Working…" : expired ? "Request refund" : "Resend invite"}</button>}</article>;
      })}</div>}
      <div className="mt-8 space-y-3">
        {threads.map((thread) => <button key={thread.id} type="button" onClick={() => { setSelected(thread.id); setPayments([]); setLoading(true); }} className="flex min-h-20 w-full items-center justify-between rounded-2xl border border-stone-200 bg-white p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">
          <span><span className="block font-semibold">{thread.counterpartyHandle ? `@${thread.counterpartyHandle}` : "TEA member"}</span><span className="mt-1 block text-sm text-stone-500">{thread.latestPayment?.kind === "STREAM" ? "Stream" : "Payment"} · {thread.latestPayment?.state.replaceAll("_", " ").toLowerCase()}</span></span>
          <span aria-hidden="true">→</span>
        </button>)}
        {!loading && threads.length === 0 && <p className="rounded-2xl border border-stone-200 bg-white p-5 text-stone-600">Payments with other TEA members will appear here.</p>}
      </div>
    </>}
    {loading && <p role="status" className="mt-5 text-sm text-stone-600">Loading activity…</p>}
    {notice && <p role="status" className="mt-5 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    {nextCursor && !loading && <button type="button" onClick={() => { setLoading(true); void refresh(undefined, nextCursor); }} className="mt-5 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold">Load more</button>}
    {error && <div role="alert" className="mt-5 text-sm text-red-800">{error} <button type="button" onClick={() => void refresh()} className="font-semibold underline">Retry</button></div>}
  </>;
}
