"use client";

import { getIdentityToken, useSendTransaction } from "@privy-io/react-auth";
import { formatUnits, parseUnits, type Hex } from "viem";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { checkedTransferPlan, type PaymentIntent } from "./payment-plan";
import ClaimSend from "./claim-send";
import StreamSend from "./stream-send";

type Balance = { token: string; decimals: number; balanceUnits: string; symbol: string };
type Pending = { id: string; submitKey: string; hash: Hex | null };
type Review =
  | { kind: "direct"; reference: string; recipient: string; amountUnits: string }
  | { kind: "claim"; email: string; amountUnits: string }
  | { kind: "stream"; reference: string; recipient: string; amountUnits: string; durationSeconds: string };

const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";

export default function SendFlow({ apiOrigin, userId, address, chainId, balance, onBack, onSettled }: {
  apiOrigin: string;
  userId: string;
  address: string;
  chainId: number;
  balance: Balance | null;
  onBack: () => void;
  onSettled: () => void;
}) {
  const { sendTransaction } = useSendTransaction();
  const reconciling = useRef(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"now" | "stream">("now");
  const [duration, setDuration] = useState(chainId === 31337 ? "300" : "86400");
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const storageKey = `tea:payment:${userId}`;

  const authFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const token = await getIdentityToken();
    if (!token) throw new Error("Your session expired. Sign in again.");
    const response = await fetch(`${apiOrigin}${path}`, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", "privy-id-token": token, ...options.headers },
    });
    if (!response.ok) throw new Error(response.status === 404 && path === "/v1/resolve" ? "That TEA name was not found." : response.status === 422 ? "Not enough available funds. Refresh your balance." : "Payment is unavailable. Try again.");
    return response.json() as Promise<unknown>;
  }, [apiOrigin]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as Pending | null;
        if (saved && /^[0-9a-f-]{36}$/.test(saved.id) && /^[0-9a-f-]{36}$/.test(saved.submitKey) &&
          (saved.hash === null || /^0x[0-9a-f]{64}$/.test(saved.hash))) setPending(saved);
      } catch { /* A broken local record cannot authorize a payment. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey]);

  const reconcile = useCallback(async (record: Pending) => {
    if (!record.hash || reconciling.current) return;
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
        setDone(true);
        setError("");
        onSettled();
      }
    } catch {
      setError("The transaction was submitted. Confirmation is still being checked.");
    } finally {
      reconciling.current = false;
    }
  }, [authFetch, onSettled, storageKey]);

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
    if (!balance) { setError("Refresh your balance before sending."); return; }
    const entered = recipient.trim();
    const recipientKind = entered.includes("@") ? "email" : "handle";
    const value = recipientKind === "handle" ? entered.toLowerCase() : entered;
    if ((recipientKind === "handle" && !/^[a-z0-9_]{3,20}$/.test(value)) ||
      (recipientKind === "email" && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))) {
      setError("Enter an exact TEA name or email address."); return;
    }
    let units: bigint;
    try { units = parseUnits(amount, balance.decimals); }
    catch { setError("Enter a valid amount."); return; }
    if (units <= BigInt(0) || units > BigInt(balance.balanceUnits)) {
      setError("Enter an amount within your available balance."); return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await authFetch("/v1/resolve", {
        method: "POST",
        body: JSON.stringify({ kind: recipientKind, value }),
      }) as { kind: string; reference?: string; recipient?: { handle: string | null } };
      if (result.kind === "unregistered" && recipientKind === "email" && mode === "now") {
        setReview({ kind: "claim", email: value, amountUnits: units.toString() });
      } else if (result.kind === "existing" && result.reference) {
        const display = result.recipient?.handle ? `@${result.recipient.handle}` : value;
        setReview(mode === "stream"
          ? { kind: "stream", reference: result.reference, recipient: display, amountUnits: units.toString(), durationSeconds: duration }
          : { kind: "direct", reference: result.reference, recipient: display, amountUnits: units.toString() });
      } else if (result.kind === "unregistered" && mode === "stream") {
        throw new Error("Streams can only be sent to an existing TEA member.");
      } else throw new Error("Recipient could not be verified.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recipient could not be verified.");
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!review || review.kind !== "direct" || !balance || busy) return;
    setBusy(true);
    setError("");
    try {
      const intent = await authFetch("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ recipientReference: review.reference, amountUnits: review.amountUnits }),
      }) as PaymentIntent;
      const plan = checkedTransferPlan(intent, address, balance.token, chainId, review.amountUnits);
      const record: Pending = { id: intent.id, submitKey: crypto.randomUUID(), hash: null };
      sessionStorage.setItem(storageKey, JSON.stringify(record));
      setPending(record);
      const sent = await sendTransaction({ to: plan.to as Hex, data: plan.data, value: BigInt(0), chainId }, {
        address,
        sponsor: chainId !== 31337,
      });
      const submitted = { ...record, hash: sent.hash };
      sessionStorage.setItem(storageKey, JSON.stringify(submitted));
      setPending(submitted);
      await reconcile(submitted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the payment.");
    } finally { setBusy(false); }
  }

  return <>
    {review?.kind === "claim" ? <ClaimSend apiOrigin={apiOrigin} userId={userId} email={review.email} amountUnits={review.amountUnits} address={address} chainId={chainId} balance={balance!} onBack={() => setReview(null)} onSettled={onSettled} /> : review?.kind === "stream" ? <StreamSend apiOrigin={apiOrigin} userId={userId} reference={review.reference} recipient={review.recipient} amountUnits={review.amountUnits} durationSeconds={review.durationSeconds} address={address} chainId={chainId} token={balance!.token} decimals={balance!.decimals} symbol={balance!.symbol} onBack={() => setReview(null)} onSettled={onSettled} /> : <>
    <button type="button" onClick={onBack} className="mb-5 self-start text-sm font-semibold text-orange-700">← Back</button>
    <h1 className="text-4xl font-semibold tracking-tight">Send money</h1>
    {done ? <div className="mt-8 rounded-2xl bg-emerald-50 p-5"><p className="font-semibold text-emerald-900">Payment confirmed.</p><button type="button" onClick={onBack} className={`${button} mt-5`}>Done</button></div>
      : pending ? <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-5"><p className="font-semibold">{pending.hash ? "Checking your payment" : "Wallet submission is uncertain"}</p><p className="mt-2 text-sm text-stone-600">{pending.hash ? "Your transaction is saved. You can leave this screen; it will be checked when you return." : "Do not send again until you have checked whether your wallet submitted the transaction."}</p>{pending.hash && <button type="button" onClick={() => void reconcile(pending)} className="mt-5 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold">Check status</button>}</div>
      : review ? <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-5"><p className="text-sm text-stone-500">To</p><p className="mt-1 text-xl font-semibold">{review.recipient}</p><p className="mt-5 text-sm text-stone-500">Amount</p><p className="mt-1 text-3xl font-semibold">{formatUnits(BigInt(review.amountUnits), balance?.decimals ?? 6)} {balance?.symbol}</p><p className="mt-5 text-sm text-stone-600">Review the wallet confirmation before signing.</p><button type="button" disabled={busy} onClick={() => void submit()} className={`${button} mt-6 w-full`}>{busy ? "Sending…" : "Confirm and send"}</button><button type="button" disabled={busy} onClick={() => setReview(null)} className="mt-3 min-h-11 w-full text-sm font-semibold">Edit payment</button></div>
      : <form onSubmit={(event) => void continueToReview(event)} className="mt-8 flex flex-col gap-4"><fieldset><legend className="font-medium">When</legend><div className="mt-2 grid grid-cols-2 gap-2">{([['now', 'Send now'], ['stream', 'Over time']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`min-h-12 rounded-xl border px-3 font-semibold ${mode === value ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white"}`}>{label}</button>)}</div></fieldset><label htmlFor="recipient" className="font-medium">TEA name or email</label><input id="recipient" autoCapitalize="none" autoComplete="off" spellCheck={false} value={recipient} onChange={(event) => setRecipient(event.target.value)} required className="min-h-14 rounded-2xl border border-stone-300 bg-white px-4" placeholder="friend_name or friend@example.com" /><label htmlFor="amount" className="font-medium">Amount in {balance?.symbol ?? "test USD"}</label><input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} required className="min-h-14 rounded-2xl border border-stone-300 bg-white px-4" placeholder="0.00" />{mode === "stream" && <><label htmlFor="duration" className="font-medium">Duration</label><select id="duration" value={duration} onChange={(event) => setDuration(event.target.value)} className="min-h-14 rounded-2xl border border-stone-300 bg-white px-4">{chainId === 31337 && <option value="300">5 minutes (local)</option>}<option value="3600">1 hour</option><option value="86400">1 day</option><option value="604800">7 days</option><option value="2592000">30 days</option></select></>}<p className="text-sm text-stone-600">Balance: {balance ? `${formatUnits(BigInt(balance.balanceUnits), balance.decimals)} ${balance.symbol}` : "Loading…"}</p><button type="submit" disabled={busy || !balance} className={button}>{busy ? "Checking…" : "Review payment"}</button></form>}
    {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    </>}
  </>;
}
