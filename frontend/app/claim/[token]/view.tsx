"use client";

import { usePrivy } from "@privy-io/react-auth";
import { authHeaders } from "../../auth";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { formatUnits, hashTypedData, type Hex } from "viem";
import { useOnlineStatus } from "../../pwa";
import { ensureMeraAccount, meraErrorMessage, signMeraTypedData } from "../../mera";

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
type Session = { id: string; account: { chainId: number; address: string } };

const button = "min-h-12 rounded-2xl bg-stone-900 px-6 font-semibold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900";

export default function ClaimView({ token, apiOrigin, chainId }: { token: string; apiOrigin: string; chainId: number }) {
  const online = useOnlineStatus();
  const { ready, authenticated, user, login } = usePrivy();
  const [session, setSession] = useState<Session | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const did = user?.id;
  const address = session?.account.address ?? null;

  const post = useCallback(async (path: string, body: object, key?: string) => {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", ...await authHeaders(), ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(response.status === 404 ? "This invitation is not available for your verified email." : "Could not check this invitation. Try again.");
    return response.json() as Promise<unknown>;
  }, [apiOrigin]);

  const syncMera = useCallback(async () => {
    if (!did) return null;
    const [headers, mera] = await Promise.all([authHeaders(), ensureMeraAccount({ ownerId: did, did, chainId, email: user?.email?.address })]);
    const response = await fetch(`${apiOrigin}/v1/session/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ accountAddress: mera.address, signature: mera.signature }),
    });
    if (!response.ok) throw new Error("Could not prepare your passkey account.");
    const next = await response.json() as Session;
    setSession(next);
    return next;
  }, [apiOrigin, chainId, did, user?.email?.address]);

  const refresh = useCallback(async () => {
    try {
      if (!session) await syncMera();
      const result = await post("/v1/claims/resolve-link", { token }) as Invitation;
      setInvitation(result);
      setError("");
      toast.dismiss("claim-invitation");
    } catch (cause) {
      const message = meraErrorMessage(cause);
      setError(message);
      toast.error(message, { id: "claim-invitation" });
    }
  }, [post, session, syncMera, token]);

  useEffect(() => {
    if (!online || !ready || !authenticated || !did || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [online, ready, authenticated, did, token, refresh]);

  async function collect() {
    if (!online) { toast.error("Reconnect before collecting this payment.", { id: "claim-collect" }); return; }
    if (!invitation || invitation.state !== "OPEN" || !address || busy || !did) return;
    setBusy(true);
    setError("");
    toast.loading("Confirm this claim with your passkey…", { id: "claim-collect" });
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
      const signature = await signMeraTypedData(did, address, typed as Parameters<typeof signMeraTypedData>[2]);
      await post(`/v1/claims/${invitation.id}/submit`, {
        inviteToken: token,
        authorizationDigest: proof.authorizationDigest,
        recipientSignature: signature,
      }, crypto.randomUUID());
      setSubmitted(true);
      toast.success("Claim submitted. Checking confirmation…", { id: "claim-collect" });
      await refresh();
    } catch (cause) {
      toast.error(meraErrorMessage(cause), { id: "claim-collect" });
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
        : !address ? <p role="status" className="mt-6 text-stone-600">Preparing your passkey account…</p>
        : invitation ? <div className="mt-8 rounded-3xl border border-stone-200 bg-white p-6"><p className="text-sm text-stone-500">From {invitation.payerHandle ? `@${invitation.payerHandle}` : "a TEA member"}</p><p className="mt-3 text-4xl font-semibold">{formatUnits(BigInt(invitation.amountUnits), 6)} test USD</p><p className="mt-5 text-sm text-stone-600">{invitation.state === "OPEN" ? `Claim before ${invitation.expiry ? new Date(invitation.expiry).toLocaleString() : "expiry"}. You will sign with your TEA passkey.` : invitation.state === "CLAIMED" ? "Claimed. The funds are in your wallet." : invitation.state === "REFUNDABLE" ? "This invitation has expired and the sender can request a refund." : "The sender was refunded."}</p>{invitation.state === "OPEN" && <button type="button" disabled={busy || submitted || !online} onClick={() => void collect()} className={`${button} mt-7 w-full`}>{busy ? "Submitting…" : submitted ? "Claim submitted" : "Collect money"}</button>}{submitted && invitation.state === "OPEN" && <p role="status" className="mt-4 text-sm text-stone-600">Claim sent. Checking confirmation…</p>}</div>
        : <p role="status" className="mt-6 text-stone-600">Verifying your email and invitation…</p>}
      {error && authenticated && address && <button type="button" disabled={!online} onClick={() => void refresh()} className="mt-5 min-h-11 px-2 font-semibold text-red-800 underline disabled:opacity-50">Retry invitation check</button>}
    </section>
    <footer className="text-sm text-stone-500">Test funds only</footer>
  </main>;
}
