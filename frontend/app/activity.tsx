"use client";

import { authHeaders } from "./auth";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { formatUnits, type Hex } from "viem";
import { useOnlineStatus } from "./pwa";
import StreamCard from "./stream-card";
import DateLockCard from "./date-lock-card";
import { checkedTransferPlan, type PaymentIntent } from "./payment-plan";
import { sendWithSponsorFallback } from "./send-transaction";

type Balance = { token: string; decimals: number; balanceUnits: string; symbol: string };
type Payment = { id: string; kind: string; direction: string; state: string; amountUnits: string; token: string; createdAt: string; txHash: string | null; claimId: string | null; claimExpiry: string | null };
type Thread = { id: string; counterpartyHandle: string | null; latestPayment: { kind: string; state: string } | null };
type SplitObligation = { id: string; participantHandle: string | null; amountUnits: string; state: string; paymentIntentId: string | null; paymentState: string | null; txHash: string | null };
type Split = { id: string; title: string | null; role: string; organizerHandle: string | null; state: string; token: string; totalAmountUnits: string; expiresAt: string; obligations: SplitObligation[] };
type Page<T> = { items: T[]; nextCursor: string | null };
type Detail = { counterpartyHandle: string | null; activity: Page<Payment> };

function money(units: string, balance?: Balance) {
  return `${formatUnits(BigInt(units), balance?.decimals ?? 6)} ${balance?.symbol ?? "token"}`;
}

export default function Activity({ apiOrigin, userId, address, chainId, balances, onSettled }: { apiOrigin: string; userId: string; address: string; chainId: number; balances: Balance[]; onSettled: () => void }) {
  const online = useOnlineStatus();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [claims, setClaims] = useState<Payment[]>([]);
  const [splits, setSplits] = useState<Split[]>([]);
  const [counterparty, setCounterparty] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [claimAction, setClaimAction] = useState<string | null>(null);
  const [splitAction, setSplitAction] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal, cursor?: string) => {
    try {
      const path = selected ? `/v1/threads/${selected}` : "/v1/threads";
      const headers = await authHeaders();
      const [response, claimResponse, splitResponse] = await Promise.all([
        fetch(`${apiOrigin}${path}${cursor ? `?cursor=${cursor}` : ""}`, { headers, cache: "no-store", signal }),
        !selected && !cursor ? fetch(`${apiOrigin}/v1/activity`, { headers, cache: "no-store", signal }) : null,
        !selected && !cursor ? fetch(`${apiOrigin}/v1/splits`, { headers, cache: "no-store", signal }) : null,
      ]);
      if (!response.ok || (claimResponse && !claimResponse.ok) || (splitResponse && !splitResponse.ok)) throw new Error("Could not load activity. Try again.");
      if (selected) {
        const detail = (await response.json()) as Detail;
        setPayments((current) => cursor ? [...current, ...detail.activity.items] : detail.activity.items);
        setCounterparty(detail.counterpartyHandle);
        setNextCursor(detail.activity.nextCursor);
      } else {
        const page = (await response.json()) as Page<Thread>;
        setThreads((current) => cursor ? [...current, ...page.items] : page.items);
        if (claimResponse) {
          const activity = (await claimResponse.json()) as Page<Payment>;
          setClaims(activity.items.filter((payment) => payment.kind === "CLAIM" && payment.state !== "CONFIRMED"));
        }
        if (splitResponse) setSplits(((await splitResponse.json()) as { items: Split[] }).items);
        setNextCursor(page.nextCursor);
      }
      setNow(Date.now());
      setError("");
      toast.dismiss("activity-load");
    } catch (cause) {
      if (!signal?.aborted) {
        const message = cause instanceof Error ? cause.message : "Could not load activity.";
        setError(message);
        toast.error(message, { id: "activity-load" });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiOrigin, selected]);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(controller.signal); }, 15_000);
    const onFocus = () => void refresh(controller.signal);
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(poll); window.removeEventListener("focus", onFocus); };
  }, [online, refresh]);

  async function claimRequest(claim: Payment, action: "resend" | "refund") {
    const toastId = `claim-action:${claim.id}`;
    if (!online) { toast.error("Reconnect before updating this claim.", { id: toastId }); return; }
    if (!claim.claimId || claimAction) return;
    setClaimAction(claim.id);
    toast.loading(action === "refund" ? "Requesting refund…" : "Sending invitation…", { id: toastId });
    try {
      const response = await fetch(`${apiOrigin}/v1/claims/${claim.claimId}/${action}`, { method: "POST", headers: { ...await authHeaders(), "Idempotency-Key": crypto.randomUUID() } });
      if (!response.ok) throw new Error(response.status === 429 ? "Wait before sending another invitation." : action === "refund" ? "This claim is not refundable yet." : "Could not resend this invitation.");
      toast.success(action === "refund" ? "Refund requested. Activity will update after confirmation." : "Invite sent.", { id: toastId });
      await refresh();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Could not update this claim.", { id: toastId }); }
    finally { setClaimAction(null); }
  }

  async function paySplit(split: Split, obligation: SplitObligation) {
    const toastId = `split-payment:${obligation.id}`;
    if (!online) { toast.error("Reconnect before paying this split.", { id: toastId }); return; }
    const balance = balances.find((item) => item.token.toLowerCase() === split.token.toLowerCase());
    if (!balance) { toast.error("This split token is unavailable.", { id: toastId }); return; }
    setSplitAction(obligation.id);
    toast.loading("Confirm the split payment in your wallet…", { id: toastId });
    try {
      const prepared = await fetch(`${apiOrigin}/v1/splits/${split.id}/obligations/${obligation.id}/payment`, { method: "POST", headers: { ...await authHeaders(), "Idempotency-Key": crypto.randomUUID() } });
      if (!prepared.ok) throw new Error(prepared.status === 422 ? "Not enough available funds." : "Could not prepare this split payment.");
      const intent = await prepared.json() as PaymentIntent;
      const plan = checkedTransferPlan(intent, address, balance.token, chainId, obligation.amountUnits);
      const sent = await sendWithSponsorFallback(userId, { to: plan.to as Hex, data: plan.data, value: BigInt(0), chainId }, address);
      const submitted = await fetch(`${apiOrigin}/v1/payments/${intent.id}/submission`, { method: "POST", headers: { ...await authHeaders(), "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ txHash: sent.hash }) });
      if (!submitted.ok) throw new Error("Payment was sent, but confirmation check failed. Activity will retry.");
      const result = await submitted.json() as { state: string };
      toast.success(result.state === "CONFIRMED" ? "Split paid." : "Split payment submitted.", { id: toastId });
      onSettled();
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not pay split.", { id: toastId });
    } finally { setSplitAction(null); }
  }

  const incomingSplits = splits.flatMap((split) => split.role === "participant" ? split.obligations.map((obligation) => ({ split, obligation })) : []);

  return <>
    {selected ? <>
      <button type="button" onClick={() => { setSelected(null); setLoading(true); }} className="mb-5 min-h-11 self-start text-sm font-semibold text-[#39634c]">← All activity</button>
      <h1 className="font-serif text-5xl tracking-tight text-[#173e32]">{counterparty ? `@${counterparty}` : "Payment thread"}</h1>
      <div className="mt-8 space-y-3">{payments.map((payment) => <article key={payment.id} className="rounded-2xl border border-[#dce3d8] bg-white/80 p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{payment.direction === "INCOMING" ? "Received" : "Sent"} · {payment.kind === "STREAM" ? "Stream" : payment.kind === "DATE_LOCK" ? "Date lock" : "Payment"}</p><p className="mt-1 text-sm text-stone-500">{new Date(payment.createdAt).toLocaleString()}</p></div><p className="font-semibold">{money(payment.amountUnits, balances.find((item) => item.token.toLowerCase() === payment.token.toLowerCase()))}</p></div><p className="mt-3 text-sm text-stone-700">{payment.state === "CONFIRMED" ? "Confirmed" : payment.state.replaceAll("_", " ").toLowerCase()}</p>{payment.kind === "STREAM" && payment.state === "CONFIRMED" && <StreamCard id={payment.id} apiOrigin={apiOrigin} userId={userId} />} {payment.kind === "DATE_LOCK" && payment.state === "CONFIRMED" && <DateLockCard id={payment.id} apiOrigin={apiOrigin} userId={userId} />}</article>)}{!loading && payments.length === 0 && <p className="text-stone-600">No payments in this thread yet.</p>}</div>
    </> : <>
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#39634c]">The little things add up</p>
      <h1 className="font-serif text-5xl tracking-tight text-[#173e32]">Your money in motion.</h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-stone-600">Every payment has a story. Follow yours, from shared bills to money sent with love.</p>
      {incomingSplits.length > 0 && <div className="mt-8 space-y-3">{incomingSplits.map(({ split, obligation }) => <article key={obligation.id} className="rounded-2xl border border-[#dce3d8] bg-white/80 p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">Split request</p><p className="mt-1 text-sm text-stone-500">{split.title || "Shared payment"} · from {split.organizerHandle ? `@${split.organizerHandle}` : "TEA member"}</p></div><p className="font-semibold">{money(obligation.amountUnits, balances.find((item) => item.token.toLowerCase() === split.token.toLowerCase()))}</p></div><button type="button" disabled={!online || splitAction === obligation.id || obligation.state === "PAID" || obligation.paymentState === "CONFIRMED"} onClick={() => void paySplit(split, obligation)} className="mt-4 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">{splitAction === obligation.id ? "Paying…" : obligation.state === "PAID" || obligation.paymentState === "CONFIRMED" ? "Paid" : "Pay split"}</button></article>)}</div>}
      {claims.length > 0 && <div className="mt-8 space-y-3">{claims.map((claim) => { const expired = claim.claimExpiry ? new Date(claim.claimExpiry).getTime() <= now : false; return <article key={claim.id} className="rounded-2xl border border-[#dce3d8] bg-white/80 p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">Email claim</p><p className="mt-1 text-sm text-stone-500">{claim.state === "REFUNDED" ? "Refunded" : expired ? "Refund available" : "Waiting for recipient"}</p></div><p className="font-semibold">{money(claim.amountUnits, balances.find((item) => item.token.toLowerCase() === claim.token.toLowerCase()))}</p></div>{claim.state === "OPEN" && <button type="button" disabled={!online || claimAction === claim.id} onClick={() => void claimRequest(claim, expired ? "refund" : "resend")} className="mt-4 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">{claimAction === claim.id ? "Working…" : expired ? "Request refund" : "Resend invite"}</button>}</article>; })}</div>}
      <div className="mt-8 space-y-3">{threads.map((thread) => <button key={thread.id} type="button" onClick={() => { setSelected(thread.id); setPayments([]); setLoading(true); }} className="group flex min-h-20 w-full items-center gap-4 rounded-2xl border border-[#dce3d8] bg-white/80 p-5 text-left transition-colors hover:border-[#8aa68c] hover:bg-[#f0f4e8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173e32]"><span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#eaf0dd] font-serif text-xl text-[#173e32]">{thread.counterpartyHandle?.slice(0, 1).toUpperCase() ?? "T"}</span><span className="min-w-0 flex-1 break-words"><span className="block font-semibold">{thread.counterpartyHandle ? `@${thread.counterpartyHandle}` : "TEA member"}</span><span className="mt-1 block text-sm text-stone-500">{thread.latestPayment?.kind === "STREAM" ? "Stream" : thread.latestPayment?.kind === "DATE_LOCK" ? "Date lock" : "Payment"} · {thread.latestPayment?.state.replaceAll("_", " ").toLowerCase()}</span></span><span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full border border-stone-200 text-[#39634c] transition-colors group-hover:border-[#173e32] group-hover:bg-[#173e32] group-hover:text-white">↗</span></button>)}{!loading && threads.length === 0 && incomingSplits.length === 0 && <div className="relative overflow-hidden rounded-3xl border border-[#dce3d8] bg-[#eef2e6] px-6 py-12 text-center"><div aria-hidden="true" className="mx-auto mb-7 flex w-fit items-center gap-3 text-[#39634c]"><span className="flex size-12 -rotate-12 items-center justify-center rounded-2xl border border-[#cbd7b9] bg-white font-serif text-xl">t.</span><span className="text-2xl">···↗</span><span className="flex size-12 rotate-12 items-center justify-center rounded-2xl bg-[#173e32] text-xl text-[#d6ed9c]">♡</span></div><h2 className="font-serif text-3xl text-[#173e32]">Good things start here.</h2><p className="mx-auto mt-3 max-w-xs text-sm leading-6 text-stone-600">Payments with other TEA members will appear here. Send a little something to start your story.</p></div>}</div>
    </>}
    {loading && <p role="status" className="mt-5 text-sm text-stone-600">Loading activity…</p>}
    {nextCursor && !loading && <button type="button" onClick={() => { setLoading(true); void refresh(undefined, nextCursor); }} className="mt-5 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold">Load more</button>}
    {error && <button type="button" onClick={() => void refresh()} className="mt-5 min-h-11 px-2 text-sm font-semibold text-red-800 underline">Retry loading activity</button>}
  </>;
}
