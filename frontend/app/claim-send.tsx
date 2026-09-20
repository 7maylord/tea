"use client";

import { getIdentityToken, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { createPublicClient, custom, formatUnits, type Hex } from "viem";
import { useCallback, useEffect, useState } from "react";
import { checkedClaimPlan, type ClaimIntent } from "./claim-plan";

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
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const [saved, setSaved] = useState<SavedClaim | null>(null);
  const [draft, setDraft] = useState<ClaimDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const storageKey = `tea:claim:${userId}`;
  const draftKey = `tea:claim-draft:${userId}`;

  const auth = useCallback(async (path: string, options: RequestInit = {}) => {
    const token = await getIdentityToken();
    if (!token) throw new Error("Your session expired. Sign in again.");
    const response = await fetch(`${apiOrigin}${path}`, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", "privy-id-token": token, ...options.headers },
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
    const wallet = wallets.find((candidate) => candidate.address.toLowerCase() === address.toLowerCase());
    if (!wallet) throw new Error("Settlement wallet unavailable.");
    const provider = await wallet.getEthereumProvider();
    const receipt = await createPublicClient({ transport: custom(provider) }).waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error("Transaction failed.");
  }, [address, wallets]);

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
        setError("");
        onSettled();
      }
    } catch {
      setError("The deposit was submitted. Confirmation is still being checked.");
    }
  }, [auth, onSettled, storageKey]);

  useEffect(() => {
    if (!saved) return;
    if (saved.stage === "APPROVAL_SUBMITTED" && saved.approvalHash) {
      const initial = window.setTimeout(() => void waitFor(saved.approvalHash!).then(() => save({ ...saved, stage: "READY_DEPOSIT" })).catch(() => setError("Approval is still being checked.")), 0);
      return () => window.clearTimeout(initial);
    }
    if (saved.stage === "DEPOSIT_SUBMITTED" && saved.depositHash) {
      const initial = window.setTimeout(() => void reconcile(saved), 0);
      const poll = window.setInterval(() => void reconcile(saved), 5000);
      return () => { window.clearTimeout(initial); window.clearInterval(poll); };
    }
  }, [reconcile, save, saved, waitFor]);

  async function approve() {
    setBusy(true);
    setError("");
    try {
      const request = draft ?? { createKey: crypto.randomUUID(), email, amountUnits };
      if (!draft) {
        sessionStorage.setItem(draftKey, JSON.stringify(request));
        setDraft(request);
      }
      const claim = await auth("/v1/claims", {
        method: "POST", headers: { "Idempotency-Key": request.createKey },
        body: JSON.stringify({ recipientEmail: request.email, amountUnits: request.amountUnits }),
      });
      const plan = checkedClaimPlan(claim, address, balance.token, chainId, amountUnits);
      const record: SavedClaim = { id: claim.id, email, amountUnits, depositKey: crypto.randomUUID(), stage: "APPROVAL_REQUESTED" };
      save(record);
      sessionStorage.removeItem(draftKey);
      setDraft(null);
      const sent = await sendTransaction({ to: plan.approve.to as Hex, data: plan.approve.data, value: BigInt(0), chainId }, { address, sponsor: chainId !== 31337 });
      const submitted = { ...record, stage: "APPROVAL_SUBMITTED" as const, approvalHash: sent.hash };
      save(submitted);
      await waitFor(sent.hash);
      save({ ...submitted, stage: "READY_DEPOSIT" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve the escrow deposit.");
    } finally { setBusy(false); }
  }

  async function deposit() {
    if (!saved || saved.stage !== "READY_DEPOSIT") return;
    setBusy(true);
    setError("");
    try {
      const claim = await auth(`/v1/claims/${saved.id}`);
      const plan = checkedClaimPlan(claim, address, balance.token, chainId, saved.amountUnits);
      save({ ...saved, stage: "DEPOSIT_REQUESTED" });
      const sent = await sendTransaction({ to: plan.deposit.to as Hex, data: plan.deposit.data, value: BigInt(0), chainId }, { address, sponsor: chainId !== 31337 });
      const submitted = { ...saved, stage: "DEPOSIT_SUBMITTED" as const, depositHash: sent.hash };
      save(submitted);
      await reconcile(submitted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit the escrow deposit.");
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" onClick={onBack} className="mb-5 self-start text-sm font-semibold text-orange-700">← {done ? "Back" : "Edit payment"}</button>
    <h1 className="text-4xl font-semibold tracking-tight">Send by email</h1>
    <div className="mt-8 rounded-3xl border border-stone-200 bg-white p-6">
      <p className="text-sm text-stone-500">Recipient</p><p className="mt-1 break-all font-semibold">{email}</p>
      <p className="mt-5 text-sm text-stone-500">Amount</p><p className="mt-1 text-3xl font-semibold">{formatUnits(BigInt(amountUnits), balance.decimals)} {balance.symbol}</p>
      <p className="mt-5 text-sm leading-6 text-stone-600">The full amount is locked for 14 days. The recipient must verify this email to collect it. After expiry, unclaimed funds return to you.</p>
      {done ? <p className="mt-6 font-semibold text-emerald-800">Deposit confirmed. The invitation is queued.</p>
        : !saved ? <button type="button" disabled={busy} onClick={() => void approve()} className={`${button} mt-7 w-full`}>{busy ? "Approving…" : draft ? "Retry setup" : "Approve escrow deposit"}</button>
        : saved.stage === "READY_DEPOSIT" ? <button type="button" disabled={busy} onClick={() => void deposit()} className={`${button} mt-7 w-full`}>{busy ? "Depositing…" : "Deposit and send invite"}</button>
        : saved.stage === "APPROVAL_REQUESTED" || saved.stage === "DEPOSIT_REQUESTED" ? <p className="mt-6 text-sm font-semibold text-amber-800">Wallet submission is uncertain. Check wallet activity before trying again.</p>
        : <div className="mt-6"><p role="status" className="text-sm text-stone-600">{saved.stage === "APPROVAL_SUBMITTED" ? "Checking approval…" : "Checking deposit confirmation…"}</p>{saved.stage === "APPROVAL_SUBMITTED" && saved.approvalHash && <button type="button" onClick={() => void waitFor(saved.approvalHash!).then(() => save({ ...saved, stage: "READY_DEPOSIT" })).catch(() => setError("Approval is still being checked."))} className="mt-4 min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold">Check approval</button>}</div>}
    </div>
    {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
  </>;
}
