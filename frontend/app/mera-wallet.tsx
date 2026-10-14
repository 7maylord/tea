"use client";

import { useState } from "react";
import { toast } from "sonner";
import { authHeaders } from "./auth";
import { ensureMeraAccount, hasMeraVault, meraErrorMessage, readMeraWallet, saveMeraVault, unlockMeraVault, type StoredMeraWallet } from "./mera";

export default function MeraWallet({ apiOrigin, ownerId, did, chainId, accountAddress, handle, email, onAccountChanged }: { apiOrigin: string; ownerId: string; did: string; chainId: number; accountAddress: string; handle: string; email?: string; onAccountChanged: (address: string) => void }) {
  const [wallet, setWallet] = useState<StoredMeraWallet | null>(() => readMeraWallet(ownerId));
  const [busy, setBusy] = useState<"recover" | "copy" | "unlock" | "save" | null>(null);
  const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null);
  const [vaultNote, setVaultNote] = useState("");
  const [vaultSaved, setVaultSaved] = useState(() => hasMeraVault(ownerId));
  const supported = typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;
  const mismatch = wallet !== null && wallet.address.toLowerCase() !== accountAddress.toLowerCase();

  async function recover() {
    setBusy("recover");
    toast.loading(wallet ? "Checking your passkey…" : "Creating your passkey account…", { id: "mera-wallet" });
    try {
      const account = await ensureMeraAccount({ ownerId, did, chainId, handle, email });
      const response = await fetch(`${apiOrigin}/v1/session/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...await authHeaders() },
        body: JSON.stringify({ accountAddress: account.address, signature: account.signature }),
      });
      if (!response.ok) throw new Error("Could not connect this passkey account. Try again.");
      const session = await response.json() as { account?: { address?: string } };
      if (session.account?.address?.toLowerCase() !== account.address.toLowerCase()) throw new Error("Could not connect this passkey account. Try again.");
      setWallet({ credential: account.credential, address: account.address });
      onAccountChanged(account.address);
      toast.success(mismatch ? "Passkey account reconnected." : wallet ? "Passkey verified." : "Passkey account created.", { id: "mera-wallet" });
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

  async function unlockVault() {
    if (vaultKey) {
      setVaultKey(null);
      setVaultNote("");
      return;
    }
    setBusy("unlock");
    toast.loading("Unlocking your private vault…", { id: "mera-vault" });
    try {
      const vault = await unlockMeraVault(ownerId);
      setVaultKey(vault.key);
      setVaultNote(vault.note);
      toast.success("Private vault unlocked.", { id: "mera-vault" });
    } catch (cause) {
      toast.error(meraErrorMessage(cause), { id: "mera-vault" });
    } finally {
      setBusy(null);
    }
  }

  async function saveVault() {
    if (!vaultKey) return;
    setBusy("save");
    try {
      await saveMeraVault(ownerId, vaultKey, vaultNote);
      setVaultSaved(true);
      toast.success("Private note encrypted and saved.", { id: "mera-vault" });
    } catch {
      toast.error("Could not save the private note.", { id: "mera-vault" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-5 rounded-3xl border border-stone-200 bg-white p-5">
      <p className="text-sm text-stone-500">TEA passkey account</p>
      <p className="mt-2 text-sm leading-6 text-stone-600">Your email gets you in. Your passkey protects every payment.</p>
      {wallet && <p className="mt-4 break-all font-mono text-sm text-stone-800">{wallet.address}</p>}
      {mismatch && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">This browser’s passkey account differs from your TEA settlement wallet. Reconnect it before signing. Funds at the previous address will not move automatically.</p>}
      {!supported && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Mera needs HTTPS or localhost with passkey support.</p>}
      <button type="button" disabled={!supported || busy !== null} onClick={() => void recover()} className="mt-4 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "recover" ? "Checking passkey…" : mismatch ? "Reconnect this passkey account" : wallet ? "Check passkey" : "Create and connect passkey account"}</button>
      {wallet && <button type="button" disabled={busy !== null} onClick={() => void copy()} className="mt-2 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "copy" ? "Copied" : "Copy address"}</button>}
      {wallet && <div className="mt-5 border-t border-stone-200 pt-5">
        <p className="text-sm font-semibold text-stone-900">Private payment vault</p>
        <p className="mt-2 text-sm leading-6 text-stone-600">The same passkey derives a separate encryption key that never signs blockchain transactions. Only encrypted text is stored.</p>
        <button type="button" disabled={busy !== null} onClick={() => void unlockVault()} className="mt-4 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50">{busy === "unlock" ? "Unlocking…" : vaultKey ? "Lock private vault" : vaultSaved ? "Unlock private vault" : "Create private vault"}</button>
        {vaultKey && <div className="mt-3">
          <label htmlFor="private-payment-note" className="text-sm font-medium text-stone-700">Private note</label>
          <textarea id="private-payment-note" value={vaultNote} onChange={(event) => setVaultNote(event.target.value)} maxLength={1000} rows={4} className="mt-2 w-full rounded-xl border border-stone-300 p-3 text-base outline-none focus:border-stone-900" placeholder="Recovery instructions or a private payment reminder" />
          <button type="button" disabled={busy !== null} onClick={() => void saveVault()} className="mt-2 min-h-11 w-full rounded-xl bg-stone-900 px-3 text-sm font-semibold text-white disabled:opacity-50">{busy === "save" ? "Encrypting…" : "Encrypt and save"}</button>
        </div>}
      </div>}
    </section>
  );
}
