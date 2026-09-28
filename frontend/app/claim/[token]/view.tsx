"use client";

import { useCreateWallet, usePrivy, useSignTypedData, useUser } from "@privy-io/react-auth";
import { authHeaders } from "../../auth";
import { useCallback, useEffect, useState } from "react";
import { formatUnits, hashTypedData, type Hex } from "viem";
import { useOnlineStatus } from "../../pwa";

type Invitation = {
  id: string;
  chainId: number;
  escrow: string;
  payerHandle: string | null;
  amountUnits: string;
  token: string;
  expiry: string | null;
  state: "OPEN" | "REFUNDABLE" | "CLAIMED" | "REFUNDED";
};
type Proof = {
  authorization: { claimId: string; amount: string; recipient: string; token: string };
  authorizationDigest: Hex;
  acceptanceDigest: Hex;
  acceptanceTypedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: string };
    primaryType: string;
    types: { ClaimAcceptance: { name: string; type: string }[] };
    message: { authorizationDigest: Hex };
  };
};

const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";

export default function ClaimView({ token, apiOrigin, chainId }: { token: string; apiOrigin: string; chainId: number }) {
  const online = useOnlineStatus();
  const { ready, authenticated, user, login } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { refreshUser } = useUser();
  const { signTypedData } = useSignTypedData();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const wallet = user?.linkedAccounts.find((account) => account.type === "wallet" && account.chainType === "ethereum" &&
    (account.walletClientType === "privy" || account.walletClientType === "privy-v2"));
  const address = wallet?.type === "wallet" ? wallet.address : null;

  const post = useCallback(async (path: string, body: object, key?: string) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", ...await authHeaders(), ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(response.status === 404 ? "This invitation is not available for your verified email." : "Could not check this invitation. Try again.");
    return response.json() as Promise<unknown>;
  }, [apiOrigin]);

  const refresh = useCallback(async () => {
    try {
      const result = await post("/v1/claims/resolve-link", { token }) as Invitation;
      setInvitation(result);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invitation unavailable.");
    }
  }, [post, token]);

  useEffect(() => {
    if (!online || !ready || !authenticated || !address || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [online, ready, authenticated, address, token, refresh]);

  async function finishWallet() {
    if (!online) { setError("Reconnect before creating your wallet."); return; }
    setBusy(true);
    try { await createWallet(); await refreshUser(); }
    catch { setError("Could not create your wallet. Try again."); }
    finally { setBusy(false); }
  }

  async function collect() {
    if (!online) { setError("Reconnect before collecting this payment."); return; }
    if (!invitation || invitation.state !== "OPEN" || !address || busy) return;
    setBusy(true);
    setError("");
    try {
      const proof = await post(`/v1/claims/${invitation.id}/authorize`, { inviteToken: token }, crypto.randomUUID()) as Proof;
      const typed = proof.acceptanceTypedData;
      if (proof.authorization.claimId !== invitation.id ||
        proof.authorization.amount !== invitation.amountUnits ||
        proof.authorization.token.toLowerCase() !== invitation.token.toLowerCase() ||
        proof.authorization.recipient.toLowerCase() !== address.toLowerCase() ||
        invitation.chainId !== chainId || typed.domain.chainId !== chainId ||
        typed.domain.verifyingContract.toLowerCase() !== invitation.escrow.toLowerCase() ||
        typed.domain.name !== "TeaClaimEscrow" ||
        typed.domain.version !== "1" || typed.primaryType !== "ClaimAcceptance" ||
        typed.message.authorizationDigest !== proof.authorizationDigest ||
        hashTypedData(typed as Parameters<typeof hashTypedData>[0]) !== proof.acceptanceDigest) {
        throw new Error("Claim details changed. Try again.");
      }
      const { signature } = await signTypedData(typed as Parameters<typeof signTypedData>[0], { address });
      await post(`/v1/claims/${invitation.id}/submit`, {
        inviteToken: token,
        authorizationDigest: proof.authorizationDigest,
        recipientSignature: signature,
      }, crypto.randomUUID());
      setSubmitted(true);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit claim.");
    } finally { setBusy(false); }
  }

  return <main className="mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(28px,env(safe-area-inset-top))]">
    <header className="text-3xl font-semibold tracking-tight">tea.</header>
    <section className="flex flex-1 flex-col justify-center py-12">
      <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-orange-700">Your invitation</p>
      <h1 className="text-4xl font-semibold tracking-tight">Money is waiting for you.</h1>
      {!/^[A-Za-z0-9_-]{43}$/.test(token) ? <p className="mt-6 text-stone-600">This invitation link is invalid.</p>
        : !ready ? <p role="status" className="mt-6 text-stone-600">Checking your invitation…</p>
        : !authenticated ? <><p className="mt-4 text-stone-600">Continue with the email address that received this invitation. Details appear after verification.</p><button type="button" disabled={!online} onClick={() => login()} className={`${button} mt-8`}>Continue with email</button></>
        : !address ? <><p className="mt-4 text-stone-600">Your wallet is needed to receive the funds.</p><button type="button" disabled={busy || !online} onClick={() => void finishWallet()} className={`${button} mt-8`}>Finish wallet setup</button></>
        : invitation ? <div className="mt-8 rounded-3xl border border-stone-200 bg-white p-6"><p className="text-sm text-stone-500">From {invitation.payerHandle ? `@${invitation.payerHandle}` : "a TEA member"}</p><p className="mt-3 text-4xl font-semibold">{formatUnits(BigInt(invitation.amountUnits), 6)} test USD</p><p className="mt-5 text-sm text-stone-600">{invitation.state === "OPEN" ? `Claim before ${invitation.expiry ? new Date(invitation.expiry).toLocaleString() : "expiry"}. You will sign an authorization; the funds move after chain confirmation.` : invitation.state === "CLAIMED" ? "Claimed. The funds are in your wallet." : invitation.state === "REFUNDABLE" ? "This invitation has expired and the sender can request a refund." : "The sender was refunded."}</p>{invitation.state === "OPEN" && <button type="button" disabled={busy || submitted || !online} onClick={() => void collect()} className={`${button} mt-7 w-full`}>{busy ? "Submitting…" : submitted ? "Claim submitted" : "Collect money"}</button>}{submitted && invitation.state === "OPEN" && <p role="status" className="mt-4 text-sm text-stone-600">Your claim is queued. This page checks for confirmation automatically.</p>}</div>
        : <p role="status" className="mt-6 text-stone-600">Verifying your email and invitation…</p>}
      {error && <div role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error} {authenticated && address && <button type="button" disabled={!online} onClick={() => void refresh()} className="min-h-11 px-2 font-semibold underline disabled:opacity-50">Retry</button>}</div>}
    </section>
    <footer className="text-sm text-stone-500">Test funds only</footer>
  </main>;
}
