"use client";

import { authHeaders } from "./auth";
import { formatUnits, parseUnits, type Hex } from "viem";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { checkedTransferPlan, type PaymentIntent } from "./payment-plan";
import { sendWithSponsorFallback } from "./send-transaction";
import ClaimSend from "./claim-send";
import StreamSend from "./stream-send";
import DateLockSend from "./date-lock-send";
import SplitSend from "./split-send";
import { useOnlineStatus } from "./pwa";

type Balance = { token: string; decimals: number; balanceUnits: string; symbol: string };
type Pending = { id: string; submitKey: string; hash: Hex | null };
type Review =
  | { kind: "direct"; reference: string; recipient: string; amountUnits: string }
  | { kind: "claim"; email: string; amountUnits: string }
  | { kind: "stream"; reference: string; recipient: string; amountUnits: string; durationSeconds: string }
  | { kind: "date"; reference: string; recipient: string; amountUnits: string; unlockAt: string };
type DirectDraft = Extract<Review, { kind: "direct" }> & { createKey: string };

const button = "min-h-14 rounded-2xl bg-[#173e32] px-6 font-semibold text-white transition-colors hover:bg-[#235643] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173e32]";

export default function SendFlow({ apiOrigin, userId, address, chainId, balance, onBack, onSettled }: {
  apiOrigin: string;
  userId: string;
  address: string;
  chainId: number;
  balance: Balance | null;
  onBack: () => void;
  onSettled: () => void;
}) {
  const online = useOnlineStatus();
  const reconciling = useRef(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"now" | "stream" | "date" | "split">("now");
  const [duration, setDuration] = useState("86400");
  const [unlockAt, setUnlockAt] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [draft, setDraft] = useState<DirectDraft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const storageKey = `tea:payment:${userId}`;
  const draftKey = `tea:payment-draft:${userId}`;
  const reviewKey = `tea:send-review:${userId}`;

  const saveReview = useCallback((value: Review) => {
    sessionStorage.setItem(reviewKey, JSON.stringify(value));
    setReview(value);
  }, [reviewKey]);

  const clearReview = useCallback(() => {
    sessionStorage.removeItem(reviewKey);
    sessionStorage.removeItem(draftKey);
    setDraft(null);
    setReview(null);
  }, [draftKey, reviewKey]);

  const settled = useCallback(() => {
    sessionStorage.removeItem(reviewKey);
    onSettled();
  }, [onSettled, reviewKey]);

  const authFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...await authHeaders(), ...options.headers },
    });
    if (!response.ok) throw new Error(response.status === 404 && path === "/v1/resolve" ? "That TEA name was not found." : response.status === 422 ? "Not enough available funds. Refresh your balance." : "Payment is unavailable. Try again.");
    return response.json() as Promise<unknown>;
  }, [apiOrigin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Pending | null;
        if (saved && /^[0-9a-f-]{36}$/.test(saved.id) && /^[0-9a-f-]{36}$/.test(saved.submitKey)) {
          if (saved.hash && /^0x[0-9a-f]{64}$/.test(saved.hash)) {
            setPending(saved);
            toast.loading("Payment submitted. Checking confirmation…", { id: `payment:${userId}` });
          }
          else { sessionStorage.removeItem(storageKey); toast.info("No transaction was submitted. Try again when ready.", { id: `payment:${userId}` }); }
        }
      } catch { /* A broken local record cannot authorize a payment. */ }
      try {
        const saved = JSON.parse(sessionStorage.getItem(reviewKey) ?? "null") as Review | null;
        if (saved?.kind === "direct" && saved.reference && saved.recipient && /^\d+$/.test(saved.amountUnits)) setReview(saved);
        else if (saved?.kind === "claim" && saved.email && /^\d+$/.test(saved.amountUnits)) setReview(saved);
        else if (saved?.kind === "stream" && saved.reference && saved.recipient && /^\d+$/.test(saved.amountUnits) && /^\d+$/.test(saved.durationSeconds)) setReview(saved);
        else if (saved?.kind === "date" && saved.reference && saved.recipient && /^\d+$/.test(saved.amountUnits) && Number.isFinite(Date.parse(saved.unlockAt))) setReview(saved);
      } catch { /* Ignore unusable screen recovery data. */ }
      try {
        const saved = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as DirectDraft | null;
        if (saved?.kind === "direct" && saved.reference && saved.recipient && /^[0-9a-f-]{36}$/.test(saved.createKey) && /^\d+$/.test(saved.amountUnits)) setDraft(saved);
      } catch { /* Ignore unusable intent recovery data. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftKey, reviewKey, storageKey, userId]);

  const reconcile = useCallback(async (record: Pending) => {
    if (!online || !record.hash || reconciling.current) return;
    reconciling.current = true;
    try {
      const result = await authFetch(`/v1/payments/${record.id}/submission`, {
        method: "POST",
        headers: { "Idempotency-Key": record.submitKey },
        body: JSON.stringify({ txHash: record.hash }),
      }) as { state: string };
      if (result.state === "CONFIRMED") {
        sessionStorage.removeItem(storageKey);
        setPending(null);
        setReview(null);
        setRecipient("");
        setAmount("");
        setMode("now");
        setDuration("86400");
        setUnlockAt("");
        toast.success("Payment confirmed.", { id: `payment:${userId}` });
        settled();
      }
    } catch {
      // Keep polling quietly; the submission toast already told the user it is checking.
    } finally {
      reconciling.current = false;
    }
  }, [authFetch, online, settled, storageKey, userId]);

  useEffect(() => {
    if (!pending?.hash) return;
    const initial = window.setTimeout(() => void reconcile(pending), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void reconcile(pending);
    }, 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [pending, reconcile]);

  async function continueToReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!balance) { toast.error("Refresh your balance before sending.", { id: `payment:${userId}` }); return; }
    const entered = recipient.trim();
    const recipientKind = entered.includes("@") ? "email" : "handle";
    const value = recipientKind === "handle" ? entered.toLowerCase() : entered;
    if ((recipientKind === "handle" && !/^[a-z0-9_]{3,20}$/.test(value)) ||
      (recipientKind === "email" && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))) {
      toast.error("Enter an exact TEA name or email address.", { id: `payment:${userId}` }); return;
    }
    let units: bigint;
    try { units = parseUnits(amount, balance.decimals); }
    catch { toast.error("Enter a valid amount.", { id: `payment:${userId}` }); return; }
    if (units <= BigInt(0) || units > BigInt(balance.balanceUnits)) {
      toast.error("Enter an amount within your available balance.", { id: `payment:${userId}` }); return;
    }
    setBusy(true);
    try {
      const result = await authFetch("/v1/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: recipientKind, value }),
      }) as { kind: string; reference?: string; recipient?: { handle: string | null } };
      if (result.kind === "unregistered" && recipientKind === "email" && mode === "now") {
        saveReview({ kind: "claim", email: value, amountUnits: units.toString() });
      } else if (result.kind === "existing" && result.reference) {
        const display = result.recipient?.handle ? `@${result.recipient.handle}` : value;
        if (mode === "stream") saveReview({ kind: "stream", reference: result.reference, recipient: display, amountUnits: units.toString(), durationSeconds: duration });
        else if (mode === "date") {
          const date = new Date(unlockAt);
          if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Choose a future unlock time.");
          saveReview({ kind: "date", reference: result.reference, recipient: display, amountUnits: units.toString(), unlockAt: date.toISOString() });
        } else saveReview({ kind: "direct", reference: result.reference, recipient: display, amountUnits: units.toString() });
      } else if (result.kind === "unregistered" && (mode === "stream" || mode === "date")) {
        throw new Error(mode === "stream" ? "Streams can only be sent to an existing TEA member." : "Date locks can only be sent to an existing TEA member.");
      } else throw new Error("Recipient could not be verified.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Recipient could not be verified.", { id: `payment:${userId}` });
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!online) { toast.error("Reconnect before sending this payment.", { id: `payment:${userId}` }); return; }
    if (!review || review.kind !== "direct" || !balance || busy) return;
    setBusy(true);
    toast.loading("Confirm the payment in your wallet…", { id: `payment:${userId}` });
    try {
      const matchingDraft = draft?.reference === review.reference && draft.recipient === review.recipient && draft.amountUnits === review.amountUnits
        ? draft : null;
      const request = matchingDraft ?? { ...review, createKey: crypto.randomUUID() };
      if (!matchingDraft) {
        sessionStorage.setItem(draftKey, JSON.stringify(request));
        setDraft(request);
      }
      const intent = await authFetch("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": request.createKey },
        body: JSON.stringify({ recipientReference: request.reference, amountUnits: request.amountUnits, token: balance.token }),
      }) as PaymentIntent;
      const plan = checkedTransferPlan(intent, address, balance.token, chainId, request.amountUnits);
      const record: Pending = { id: intent.id, submitKey: crypto.randomUUID(), hash: null };
      sessionStorage.removeItem(draftKey);
      setDraft(null);
      const sent = await sendWithSponsorFallback(userId, { to: plan.to as Hex, data: plan.data, value: BigInt(0), chainId }, address);
      const submitted = { ...record, hash: sent.hash };
      sessionStorage.setItem(storageKey, JSON.stringify(submitted));
      setPending(submitted);
      setReview(null);
      toast.loading("Payment submitted. Checking confirmation…", { id: `payment:${userId}` });
      await reconcile(submitted);
    } catch (cause) {
      sessionStorage.removeItem(storageKey);
      setPending(null);
      toast.error(cause instanceof Error ? cause.message : "Could not submit the payment.", { id: `payment:${userId}` });
    } finally { setBusy(false); }
  }

  return <>
    {review?.kind === "claim" ? <ClaimSend apiOrigin={apiOrigin} userId={userId} email={review.email} amountUnits={review.amountUnits} address={address} chainId={chainId} balance={balance!} onBack={clearReview} onSettled={settled} /> : review?.kind === "stream" ? <StreamSend apiOrigin={apiOrigin} userId={userId} reference={review.reference} recipient={review.recipient} amountUnits={review.amountUnits} durationSeconds={review.durationSeconds} address={address} chainId={chainId} token={balance!.token} decimals={balance!.decimals} symbol={balance!.symbol} onBack={clearReview} onSettled={settled} /> : review?.kind === "date" ? <DateLockSend apiOrigin={apiOrigin} userId={userId} reference={review.reference} recipient={review.recipient} amountUnits={review.amountUnits} unlockAt={review.unlockAt} address={address} chainId={chainId} token={balance!.token} decimals={balance!.decimals} symbol={balance!.symbol} onBack={clearReview} onSettled={settled} /> : <>
    <button type="button" onClick={onBack} className="mb-5 min-h-11 self-start text-sm font-semibold text-[#39634c]">← Back to your space</button>
    <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#39634c]">Made for your everyday</p>
    <h1 className="font-serif text-5xl tracking-tight text-[#173e32]">Money, your way.</h1>
    <p className="mt-3 max-w-md text-sm leading-6 text-stone-600">A little for a friend. A plan for the future. Choose how your money moves.</p>
    {!review && <fieldset className="mt-8">
      <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-stone-500">01 / Choose a payment</legend>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {([
          ['now', 'Send now', 'Straight to someone', '↗'],
          ['stream', 'Over time', 'A little every second', '≈'],
          ['date', 'Unlock later', 'For a date that matters', '◷'],
          ['split', 'Split', 'Share the bill your way', '÷'],
        ] as const).map(([value, label, description, glyph]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`group relative rounded-2xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173e32] ${mode === value ? "border-[#173e32] bg-[#173e32] text-white" : "border-[#dce3d8] bg-white/70 text-[#173e32] hover:border-[#8aa68c] hover:bg-white"}`}>
          <span aria-hidden="true" className={`mb-4 flex size-9 items-center justify-center rounded-full text-xl ${mode === value ? "bg-[#d6ed9c] text-[#173e32]" : "bg-[#eef2e7]"}`}>{glyph}</span>
          <span className="block font-semibold">{label}</span>
          <span className={`mt-1 block text-xs leading-5 ${mode === value ? "text-white/75" : "text-stone-500"}`}>{description}</span>
          <span aria-hidden="true" className={`absolute right-4 top-4 size-2 rounded-full ${mode === value ? "bg-[#d6ed9c]" : "bg-stone-200"}`} />
        </button>)}
      </div>
    </fieldset>}
    {mode === "split" && !review ? <SplitSend apiOrigin={apiOrigin} balance={balance} onSettled={settled} />
      : review ? <div className="mt-8 overflow-hidden rounded-3xl border border-[#dce3d8] bg-white p-6">
        <p className="mb-6 border-b border-dashed border-stone-200 pb-4 text-xs font-semibold uppercase tracking-[0.15em] text-[#39634c]">One last look</p>
        <p className="text-sm text-stone-500">To</p><p className="mt-1 break-words text-xl font-semibold">{review.recipient}</p>
        <p className="mt-6 text-sm text-stone-500">You&apos;re sending</p><p className="mt-1 break-words font-serif text-4xl text-[#173e32]">{formatUnits(BigInt(review.amountUnits), balance?.decimals ?? 6)} <span className="text-lg">{balance?.symbol}</span></p>
        <p className="mt-6 border-t border-dashed border-stone-200 pt-4 text-sm leading-6 text-stone-600">Review the wallet confirmation before signing.</p>
        <button type="button" disabled={busy || !online} onClick={() => void submit()} className={`${button} mt-6 w-full`}>{busy ? "Sending…" : draft ? "Retry setup" : "Confirm and send"}</button>
        <button type="button" disabled={busy} onClick={clearReview} className="mt-3 min-h-11 w-full text-sm font-semibold">Edit payment</button>
      </div>
      : <form onSubmit={(event) => void continueToReview(event)} className="mt-8 flex flex-col gap-4 rounded-3xl border border-[#dce3d8] bg-white/70 p-5 sm:p-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-stone-500">02 / The details</p>
        <label htmlFor="recipient" className="text-sm font-medium">TEA name or email</label>
        <input id="recipient" autoCapitalize="none" autoComplete="off" spellCheck={false} value={recipient} onChange={(event) => setRecipient(event.target.value)} required className="min-h-14 min-w-0 rounded-2xl border border-[#dce3d8] bg-white px-4 focus-visible:outline-2 focus-visible:outline-[#39634c]" placeholder="friend_name or friend@example.com" />
        <label htmlFor="amount" className="mt-2 text-sm font-medium">Amount in {balance?.symbol ?? "test USD"}</label>
        <input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} required className="min-h-20 min-w-0 rounded-2xl border border-[#dce3d8] bg-[#f5f6ef] px-4 font-serif text-4xl text-[#173e32] focus-visible:outline-2 focus-visible:outline-[#39634c]" placeholder="0.00" />
        {mode === "stream" && <><label htmlFor="duration" className="text-sm font-medium">Duration</label><select id="duration" value={duration} onChange={(event) => setDuration(event.target.value)} className="min-h-14 rounded-2xl border border-[#dce3d8] bg-white px-4"><option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000">30 days</option></select></>}
        {mode === "date" && <><label htmlFor="unlock-at" className="text-sm font-medium">Unlock time</label><input id="unlock-at" type="datetime-local" value={unlockAt} onChange={(event) => setUnlockAt(event.target.value)} required className="min-h-14 min-w-0 rounded-2xl border border-[#dce3d8] bg-white px-4" /></>}
        <p className="text-xs leading-5 text-stone-500">Available: {balance ? `${formatUnits(BigInt(balance.balanceUnits), balance.decimals)} ${balance.symbol}` : "Loading…"}</p>
        <button type="submit" disabled={busy || !balance} className={button}>{busy ? "Checking…" : "Review payment →"}</button>
      </form>}
    </>}
  </>;
}
