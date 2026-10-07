"use client";

import { useState } from "react";
import type { PasskeyCredentialMetadata } from "@category-labs/mera";

type StoredMeraWallet = {
  credential: PasskeyCredentialMetadata;
  address: `0x${string}`;
};

const path = "m/44'/60'/0'/0/0";

function keyFor(userId: string) {
  return `tea:mera:${userId}`;
}

function readWallet(userId: string) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredMeraWallet;
    return parsed.credential?.credentialId && parsed.address ? parsed : null;
  } catch {
    return null;
  }
}

async function deriveAddress(prfOutput: Uint8Array) {
  const [{ HDKey }, { entropyToMnemonic, mnemonicToSeedSync }, { wordlist }, mera] = await Promise.all([
    import("@scure/bip32"),
    import("@scure/bip39"),
    import("@scure/bip39/wordlists/english.js"),
    import("@category-labs/mera"),
  ]);
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const privateKey = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!privateKey) throw new Error("Mera could not derive an EVM account.");
  const session = mera.createSecp256k1SigningSession({ privateKey });
  try {
    return mera.getEvmAddress(session.publicKey);
  } finally {
    session.end();
    privateKey.fill(0);
  }
}

function errorMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "PRF_UNAVAILABLE") return "This passkey provider does not support Mera. Try iCloud Keychain, 1Password, or Google Password Manager.";
  if (code === "PASSKEY_OPERATION_FAILED") return "The passkey prompt was cancelled or failed. Try again.";
  if (code === "CRYPTO_UNAVAILABLE") return "Mera needs HTTPS or localhost.";
  return error instanceof Error ? error.message : "Mera setup failed.";
}

export default function MeraWallet({ userId, handle, email }: { userId: string; handle: string; email?: string }) {
  const [wallet, setWallet] = useState<StoredMeraWallet | null>(() => readWallet(userId));
  const [busy, setBusy] = useState<"create" | "recover" | "copy" | null>(null);
  const [error, setError] = useState("");
  const supported = typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;


  async function save(credential: PasskeyCredentialMetadata, prfOutput: Uint8Array) {
    const address = await deriveAddress(prfOutput);
    const next = { credential, address } satisfies StoredMeraWallet;
    localStorage.setItem(keyFor(userId), JSON.stringify(next));
    setWallet(next);
    setError("");
  }

  async function create() {
    setBusy("create");
    setError("");
    try {
      const { createPasskeyWithPrfOutput } = await import("@category-labs/mera");
      const created = await createPasskeyWithPrfOutput({
        rp: { id: location.hostname, name: "TEA" },
        user: { name: email ?? handle, displayName: handle },
      });
      await save({ credentialId: created.credentialId, transports: created.transports }, created.prfOutput);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function recover() {
    setBusy("recover");
    setError("");
    try {
      const { getPasskeyPrfOutput } = await import("@category-labs/mera");
      const known = readWallet(userId)?.credential;
      const recovered = await getPasskeyPrfOutput({ rpId: location.hostname, credential: known ?? undefined });
      await save(known?.credentialId === recovered.credentialId ? known : { credentialId: recovered.credentialId }, recovered.prfOutput);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!wallet) return;
    setBusy("copy");
    try {
      await navigator.clipboard.writeText(wallet.address);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-5 rounded-3xl border border-stone-200 bg-white p-5">
      <p className="text-sm text-stone-500">Mera passkey wallet</p>
      <p className="mt-2 text-sm leading-6 text-stone-600">Create or recover a passkey-derived Monad account for wallet recovery demos.</p>
      {wallet && <p className="mt-4 break-all font-mono text-sm text-stone-800">{wallet.address}</p>}
      {!supported && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Mera needs HTTPS or localhost with passkey support.</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" disabled={!supported || busy !== null} onClick={() => void create()} className="min-h-11 rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "create" ? "Creating…" : "Create"}</button>
        <button type="button" disabled={!supported || busy !== null} onClick={() => void recover()} className="min-h-11 rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "recover" ? "Recovering…" : "Recover"}</button>
      </div>
      {wallet && <button type="button" disabled={busy !== null} onClick={() => void copy()} className="mt-2 min-h-11 w-full rounded-xl border border-stone-300 px-3 text-sm font-semibold text-stone-900 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900">{busy === "copy" ? "Copied" : "Copy Mera address"}</button>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    </section>
  );
}
