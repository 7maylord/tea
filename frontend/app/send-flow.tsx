"use client";

import { getIdentityToken, useSendTransaction } from "@privy-io/react-auth";
import { formatUnits, parseUnits, type Hex } from "viem";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { checkedTransferPlan, type PaymentIntent } from "./payment-plan";

type Balance = { token: string; decimals: number; balanceUnits: string; symbol: string };
type Pending = { id: string; submitKey: string; hash: Hex | null };
type Review = { reference: string; handle: string; amountUnits: string };

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
  const [handle, setHandle] = useState("");
  const [amount, setAmount] = useState("");
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
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) { setError("Enter an exact TEA name."); return; }
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
        body: JSON.stringify({ kind: "handle", value: handle }),
      }) as { kind: string; reference: string; recipient: { handle: string } };
      if (result.kind !== "existing" || result.recipient.handle !== handle) throw new Error("Recipient could not be verified.");
      setReview({ reference: result.reference, handle, amountUnits: units.toString() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recipient could not be verified.");
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!review || !balance || busy) return;
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
    <button type="button" onClick={onBack} className="mb-5 self-start text-sm font-semibold text-orange-700">← Back</button>
    <h1 className="text-4xl font-semibold tracking-tight">Send money</h1>
    {done ? <div className="mt-8 rounded-2xl bg-emerald-50 p-5"><p className="font-semibold text-emerald-900">Payment confirmed.</p><button type="button" onClick={onBack} className={`${button} mt-5`}>Done</button></div>
      : pending ? <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-5"><p className="font-semibold">{pending.hash ? "Checking your payment" : "Wallet submission is uncertain"}</p><p className="mt-2 text-sm text-stone-600">{pending.hash ? "Your transaction is saved. You can leave this screen; it will be checked when you return." : "Do not send again until you have checked whether your wallet submitted the transaction."}</p>{pending.hash && <button type="button" onClick={() => void reconcile(pending)} className="mt-5 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold">Check status</button>}</div>
      : review ? <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-5"><p className="text-sm text-stone-500">To</p><p className="mt-1 text-xl font-semibold">@{review.handle}</p><p className="mt-5 text-sm text-stone-500">Amount</p><p className="mt-1 text-3xl font-semibold">{formatUnits(BigInt(review.amountUnits), balance?.decimals ?? 6)} {balance?.symbol}</p><p className="mt-5 text-sm text-stone-600">Review the wallet confirmation before signing.</p><button type="button" disabled={busy} onClick={() => void submit()} className={`${button} mt-6 w-full`}>{busy ? "Sending…" : "Confirm and send"}</button><button type="button" disabled={busy} onClick={() => setReview(null)} className="mt-3 min-h-11 w-full text-sm font-semibold">Edit payment</button></div>
      : <form onSubmit={(event) => void continueToReview(event)} className="mt-8 flex flex-col gap-4"><label htmlFor="recipient" className="font-medium">TEA name</label><input id="recipient" autoCapitalize="none" autoComplete="off" spellCheck={false} value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} required className="min-h-14 rounded-2xl border border-stone-300 bg-white px-4" placeholder="friend_name" /><label htmlFor="amount" className="font-medium">Amount in {balance?.symbol ?? "test USD"}</label><input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} required className="min-h-14 rounded-2xl border border-stone-300 bg-white px-4" placeholder="0.00" /><p className="text-sm text-stone-600">Balance: {balance ? `${formatUnits(BigInt(balance.balanceUnits), balance.decimals)} ${balance.symbol}` : "Loading…"}</p><button type="submit" disabled={busy || !balance} className={button}>{busy ? "Checking…" : "Review payment"}</button></form>}
    {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
  </>;
}
