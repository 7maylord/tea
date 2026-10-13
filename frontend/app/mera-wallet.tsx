"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ensureMeraAccount, meraErrorMessage, readMeraWallet, type StoredMeraWallet } from "./mera";

export default function MeraWallet({ ownerId, did, chainId, handle, email }: { ownerId: string; did: string; chainId: number; handle: string; email?: string }) {
  const [wallet, setWallet] = useState<StoredMeraWallet | null>(() => readMeraWallet(ownerId));
  const [busy, setBusy] = useState<"recover" | "copy" | null>(null);
  const supported = typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;

  async function recover() {
    setBusy("recover");
    toast.loading(wallet ? "Checking your passkey…" : "Creating your passkey account…", { id: "mera-wallet" });
    try {
      const account = await ensureMeraAccount({ ownerId, did, chainId, handle, email });
      setWallet({ credential: account.credential, address: account.address });
      toast.success(wallet ? "Passkey verified." : "Passkey account created.", { id: "mera-wallet" });
    } catch (cause) {
      toast.error(meraErrorMessage(cause), { id: "mera-wallet" });
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!wallet) return;
    setBusy("copy");
    try {
      await navigator.clipboard.writeText(wallet.address);
      toast.success("Wallet address copied.", { id: "mera-copy" });
    } catch {
      toast.error("Could not copy the wallet address.", { id: "mera-copy" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-5 rounded-3xl border border-stone-200 bg-white p-5">
      <p className="text-sm text-stone-500">TEA passkey account</p>
      <p className="mt-2 text-sm leading-6 text-stone-600">Your email gets you in. Your passkey protects every payment.</p>
      {wallet && <p className="mt-4 break-all font-mono text-sm text-stone-800">{wallet.address}</p>}
      {!supported && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Mera needs HTTPS or localhost with passkey support.</p>}
      <button type="button" disabled={!supported || busy !== null} onClick={() => void recover()} className="mt-4 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "recover" ? "Checking passkey…" : wallet ? "Check passkey" : "Create TEA passkey account"}</button>
      {wallet && <button type="button" disabled={busy !== null} onClick={() => void copy()} className="mt-2 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "copy" ? "Copied" : "Copy address"}</button>}
    </section>
  );
}
