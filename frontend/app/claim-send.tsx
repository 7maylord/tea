"use client";

import { authHeaders } from "./auth";
import { formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { checkedClaimPlan, type ClaimIntent } from "./claim-plan";
import { sendWithSponsorFallback } from "./send-transaction";
import { waitForMeraReceipt } from "./mera";
import { useOnlineStatus } from "./pwa";

type Balance = { token: string; decimals: number; symbol: string };
type SavedClaim = {
  id: Hex;
  email: string;
  amountUnits: string;
  depositKey: string;
  stage: "APPROVAL_REQUESTED" | "APPROVAL_SUBMITTED" | "READY_DEPOSIT" | "DEPOSIT_REQUESTED" | "DEPOSIT_SUBMITTED";
  approvalHash?: Hex;
  depositHash?: Hex;
};
type ClaimDraft = { createKey: string; email: string; amountUnits: string };
const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";

export default function ClaimSend({ apiOrigin, userId, email, amountUnits, address, chainId, balance, onBack, onSettled }: {
  apiOrigin: string;
  userId: string;
  email: string;
  amountUnits: string;
  address: string;
  chainId: number;
  balance: Balance;
  onBack: () => void;
  onSettled: () => void;
}) {
  const online = useOnlineStatus();
  const [saved, setSaved] = useState<SavedClaim | null>(null);
  const [draft, setDraft] = useState<ClaimDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const storageKey = `tea:claim:${userId}:${balance.token}`;
  const draftKey = `tea:claim-draft:${userId}:${balance.token}`;

  const auth = useCallback(async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...await authHeaders(), ...options.headers },
    });
    if (!response.ok) throw new Error(response.status === 422 ? "Not enough available funds." : "Could not prepare this email payment.");
    return response.json() as Promise<ClaimIntent>;
  }, [apiOrigin]);

  const save = useCallback((record: SavedClaim) => {
    sessionStorage.setItem(storageKey, JSON.stringify(record));
    setSaved(record);
  }, [storageKey]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      try {
        const record = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as SavedClaim | null;
        if (record?.email === email && record.amountUnits === amountUnits && /^0x[0-9a-f]{64}$/.test(record.id)) setSaved(record);
      } catch { /* Ignore unusable local recovery data. */ }
      try {
        const record = JSON.parse(sessionStorage.getItem(draftKey) ?? "null") as ClaimDraft | null;
        if (record?.email === email && record.amountUnits === amountUnits && /^[0-9a-f-]{36}$/.test(record.createKey)) setDraft(record);
      } catch { /* Ignore unusable intent recovery data. */ }
    }, 0);
    return () => window.clearTimeout(initial);
  }, [amountUnits, draftKey, email, storageKey]);

  const waitFor = useCallback(async (hash: Hex) => {
    await waitForMeraReceipt(chainId, hash);
  }, [chainId]);

  const reconcile = useCallback(async (record: SavedClaim) => {
    if (!record.depositHash) return;
    try {
      const claim = await auth(`/v1/claims/${record.id}/deposit`, {
        method: "POST",
        headers: { "Idempotency-Key": record.depositKey },
        body: JSON.stringify({ txHash: record.depositHash }),
      });
      if (claim.state === "OPEN") {
        sessionStorage.removeItem(storageKey);
        setSaved(null);
        setDone(true);
        if (claim.inviteSent) toast.success("Invite sent.", { id: `email-payment:${userId}` });
        else toast.error("Payment deposited, but the invite could not be sent. Retry from Activity.", { id: `email-payment:${userId}` });
        onSettled();
      }
    } catch {
      toast.loading("Deposit submitted. Checking confirmation…", { id: `email-payment:${userId}` });
    }
  }, [auth, onSettled, storageKey, userId]);

  useEffect(() => {
    if (!online || !saved) return;
    if (saved.stage === "APPROVAL_SUBMITTED" && saved.approvalHash) {
      const initial = window.setTimeout(() => void waitFor(saved.approvalHash!).then(() => {
        save({ ...saved, stage: "READY_DEPOSIT" });
        toast.success("Funding approved. Complete the deposit to send the invitation.", { id: `email-payment:${userId}` });
      }).catch(() => toast.loading("Approval submitted. Checking confirmation…", { id: `email-payment:${userId}` })), 0);
      return () => window.clearTimeout(initial);
    }
    if (saved.stage === "DEPOSIT_SUBMITTED" && saved.depositHash) {
      const initial = window.setTimeout(() => void reconcile(saved), 0);
      const poll = window.setInterval(() => void reconcile(saved), 5000);
      return () => { window.clearTimeout(initial); window.clearInterval(poll); };
    }
  }, [online, reconcile, save, saved, userId, waitFor]);

  async function approve() {
    if (!online) { toast.error("Reconnect before approving this payment.", { id: `email-payment:${userId}` }); return; }
    setBusy(true);
    toast.loading("Confirm funding approval in your wallet…", { id: `email-payment:${userId}` });
    try {
      let record = saved?.stage === "APPROVAL_REQUESTED" ? saved : null;
      const claim = record ? await auth(`/v1/claims/${record.id}`) : await (async () => {
        const request = draft ?? { createKey: crypto.randomUUID(), email, amountUnits };
        if (!draft) {
          sessionStorage.setItem(draftKey, JSON.stringify(request));
          setDraft(request);
        }
        return auth("/v1/claims", {
          method: "POST", headers: { "Idempotency-Key": request.createKey },
          body: JSON.stringify({ recipientEmail: request.email, amountUnits: request.amountUnits, token: balance.token }),
        });
      })();
      const plan = checkedClaimPlan(claim, address, balance.token, chainId, amountUnits);
      record ??= { id: claim.id, email, amountUnits, depositKey: crypto.randomUUID(), stage: "APPROVAL_REQUESTED" };
      save(record);
      sessionStorage.removeItem(draftKey);
      setDraft(null);
      const sent = await sendWithSponsorFallback(userId, { to: plan.approve.to as Hex, data: plan.approve.data, value: BigInt(0), chainId }, address);
      const submitted = { ...record, stage: "APPROVAL_SUBMITTED" as const, approvalHash: sent.hash };
      save(submitted);
      await waitFor(sent.hash);
      save({ ...submitted, stage: "READY_DEPOSIT" });
      toast.success("Funding approved. Complete the deposit to send the invitation.", { id: `email-payment:${userId}` });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not approve the escrow deposit.", { id: `email-payment:${userId}` });
    } finally { setBusy(false); }
  }

  async function deposit() {
    if (!online) { toast.error("Reconnect before depositing this payment.", { id: `email-payment:${userId}` }); return; }
    if (!saved || (saved.stage !== "READY_DEPOSIT" && saved.stage !== "DEPOSIT_REQUESTED")) return;
    setBusy(true);
    toast.loading("Confirm the escrow deposit in your wallet…", { id: `email-payment:${userId}` });
    try {
      const claim = await auth(`/v1/claims/${saved.id}`);
      const plan = checkedClaimPlan(claim, address, balance.token, chainId, saved.amountUnits);
      save({ ...saved, stage: "DEPOSIT_REQUESTED" });
      const sent = await sendWithSponsorFallback(userId, { to: plan.deposit.to as Hex, data: plan.deposit.data, value: BigInt(0), chainId }, address);
      const submitted = { ...saved, stage: "DEPOSIT_SUBMITTED" as const, depositHash: sent.hash };
      save(submitted);
      await reconcile(submitted);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not submit the escrow deposit.", { id: `email-payment:${userId}` });
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" onClick={onBack} className="mb-5 min-h-11 self-start text-sm font-semibold text-orange-700">← {done ? "Back" : "Edit payment"}</button>
    <h1 className="text-4xl font-semibold tracking-tight">Send by email</h1>
    <div className="mt-8 rounded-3xl border border-stone-200 bg-white p-6">
      <p className="text-sm text-stone-500">Recipient</p><p className="mt-1 break-all font-semibold">{email}</p>
      <p className="mt-5 text-sm text-stone-500">Amount</p><p className="mt-1 text-3xl font-semibold">{formatUnits(BigInt(amountUnits), balance.decimals)} {balance.symbol}</p>
      <p className="mt-5 text-sm leading-6 text-stone-600">The full amount is locked for 14 days. The recipient must verify this email to collect it. After expiry, unclaimed funds return to you.</p>
      {done ? null
        : !saved ? <button type="button" disabled={busy || !online} onClick={() => void approve()} className={`${button} mt-7 w-full`}>{busy ? "Approving…" : draft ? "Retry setup" : "Approve escrow deposit"}</button>
        : saved.stage === "READY_DEPOSIT" ? <button type="button" disabled={busy || !online} onClick={() => void deposit()} className={`${button} mt-7 w-full`}>{busy ? "Depositing…" : "Deposit and send invite"}</button>
        : saved.stage === "APPROVAL_REQUESTED" ? <div className="mt-6"><p className="text-sm font-semibold text-amber-800">Approval was not submitted.</p><button type="button" disabled={busy || !online} onClick={() => void approve()} className={`${button} mt-4 w-full`}>{busy ? "Approving…" : "Retry approval"}</button></div>
        : saved.stage === "DEPOSIT_REQUESTED" ? <div className="mt-6"><p className="text-sm font-semibold text-amber-800">Deposit was not submitted.</p><button type="button" disabled={busy || !online} onClick={() => void deposit()} className={`${button} mt-4 w-full`}>{busy ? "Depositing…" : "Retry deposit"}</button></div>
        : <div className="mt-6"><p role="status" className="text-sm text-stone-600">{saved.stage === "APPROVAL_SUBMITTED" ? "Checking approval…" : "Checking deposit confirmation…"}</p>{saved.stage === "APPROVAL_SUBMITTED" && saved.approvalHash && <button type="button" disabled={!online} onClick={() => void waitFor(saved.approvalHash!).then(() => save({ ...saved, stage: "READY_DEPOSIT" })).catch(() => toast.loading("Approval submitted. Checking confirmation…", { id: `email-payment:${userId}` }))} className="mt-4 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">Check approval</button>}</div>}
    </div>
  </>;
}
