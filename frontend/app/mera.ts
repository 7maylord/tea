import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createPasskeyWithPrfOutput, createSecp256k1SigningSession, getEvmAddress, getPasskeyPrfOutput, type PasskeyCredentialMetadata } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type Hex, type TransactionReceipt } from "viem";
import { submitTransactionSequence } from "./transaction-sequence";
import { deriveMeraVaultKey } from "./mera-vault-crypto";

export type StoredMeraWallet = {
  credential: PasskeyCredentialMetadata;
  address: `0x${string}`;
};

type StoredMeraVault = {
  version: 1;
  iv: string;
  ciphertext: string;
};

type MeraAccount = StoredMeraWallet & {
  signature: Hex;
  message: string;
};

type Transaction = { to: Hex; data: Hex; value: bigint; chainId: number };

const path = "m/44'/60'/0'/0/0";
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";

export function meraKey(ownerId: string) {
  return `tea:mera:${ownerId}`;
}

export function readMeraWallet(ownerId: string) {
  if (typeof localStorage === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(meraKey(ownerId)) ?? "null") as StoredMeraWallet | null;
    return parsed?.credential?.credentialId && parsed.address ? parsed : null;
  } catch {
    return null;
  }
}

function saveMeraWallet(ownerId: string, wallet: StoredMeraWallet) {
  localStorage.setItem(meraKey(ownerId), JSON.stringify(wallet));
}

export function copyMeraWallet(fromOwnerId: string, toOwnerId: string) {
  const wallet = readMeraWallet(fromOwnerId);
  if (wallet) saveMeraWallet(toOwnerId, wallet);
}

export function meraSettlementMessage(did: string, address: string, chainId: number) {
  return `TEA Mera settlement account\nPrivy DID: ${did}\nAddress: ${address.toLowerCase()}\nChain ID: ${chainId}`;
}

function derivePrivateKey(prfOutput: Uint8Array) {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const privateKey = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!privateKey) throw new Error("Mera could not derive an EVM account.");
  return privateKey;
}

function vaultStorageKey(ownerId: string) {
  return `tea:mera-vault:${ownerId}`;
}

function vaultContext(ownerId: string) {
  return new TextEncoder().encode(`tea:private-payment-vault:v1:${ownerId}`);
}

function encodeBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function chainFor(chainId: number): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 10143 ? "Monad Testnet" : `Chain ${chainId}`,
    nativeCurrency: { name: chainId === 10143 ? "MON" : "Native token", symbol: chainId === 10143 ? "MON" : "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function withMeraPrf<T>(ownerId: string, run: (prfOutput: Uint8Array, wallet: StoredMeraWallet) => Promise<T>) {
  const stored = readMeraWallet(ownerId);
  if (!stored) throw new Error("Create your TEA passkey account first.");
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: location.hostname, credential: stored.credential });
  try {
    return await run(prfOutput, stored);
  } finally {
    prfOutput.fill(0);
  }
}

async function withMeraSession<T>(ownerId: string, run: (privateKey: Uint8Array, wallet: StoredMeraWallet) => Promise<T>) {
  return withMeraPrf(ownerId, async (prfOutput, stored) => {
    const privateKey = derivePrivateKey(prfOutput);
    try {
      return await run(privateKey, stored);
    } finally {
      privateKey.fill(0);
    }
  });
}

export function hasMeraVault(ownerId: string) {
  return typeof localStorage !== "undefined" && localStorage.getItem(vaultStorageKey(ownerId)) !== null;
}

export async function unlockMeraVault(ownerId: string) {
  return withMeraPrf(ownerId, async (prfOutput) => {
    const key = await deriveMeraVaultKey(prfOutput);
    const raw = localStorage.getItem(vaultStorageKey(ownerId));
    if (!raw) return { key, note: "" };
    try {
      const stored = JSON.parse(raw) as StoredMeraVault;
      if (stored.version !== 1 || typeof stored.iv !== "string" || typeof stored.ciphertext !== "string") throw new Error();
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64(stored.iv), additionalData: vaultContext(ownerId) },
        key,
        decodeBase64(stored.ciphertext),
      );
      return { key, note: new TextDecoder().decode(plaintext) };
    } catch {
      throw new Error("This passkey cannot open the private vault.");
    }
  });
}

export async function saveMeraVault(ownerId: string, key: CryptoKey, note: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: vaultContext(ownerId) },
    key,
    new TextEncoder().encode(note),
  );
  const stored: StoredMeraVault = {
    version: 1,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  localStorage.setItem(vaultStorageKey(ownerId), JSON.stringify(stored));
}

export async function ensureMeraAccount({ ownerId, did, chainId, email, handle }: { ownerId: string; did: string; chainId: number; email?: string; handle?: string | null }): Promise<MeraAccount> {
  let stored = readMeraWallet(ownerId);
  let prfOutput: Uint8Array;
  if (stored) {
    const recovered = await getPasskeyPrfOutput({ rpId: location.hostname, credential: stored.credential });
    prfOutput = recovered.prfOutput;
  } else {
    const created = await createPasskeyWithPrfOutput({
      rp: { id: location.hostname, name: "TEA" },
      user: { name: email ?? handle ?? "tea-user", displayName: handle ?? email ?? "TEA user" },
    });
    prfOutput = created.prfOutput;
    const privateKey = derivePrivateKey(prfOutput);
    const session = createSecp256k1SigningSession({ privateKey });
    try {
      stored = { credential: { credentialId: created.credentialId, transports: created.transports }, address: getEvmAddress(session.publicKey) };
      saveMeraWallet(ownerId, stored);
    } finally {
      session.end();
      privateKey.fill(0);
    }
  }
  const privateKey = derivePrivateKey(prfOutput);
  const session = createSecp256k1SigningSession({ privateKey });
  try {
    const account = toViemAccount(session);
    if (!stored || account.address.toLowerCase() !== stored.address.toLowerCase()) throw new Error("Mera account changed.");
    const message = meraSettlementMessage(did, stored.address, chainId);
    const signature = await account.signMessage({ message });
    return { ...stored, message, signature };
  } finally {
    session.end();
    privateKey.fill(0);
  }
}

export async function sendMeraTransaction(ownerId: string, input: Transaction, expectedAddress: string) {
  return withMeraSession(ownerId, async (privateKey, stored) => {
    if (stored.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("TEA passkey account changed.");
    const session = createSecp256k1SigningSession({ privateKey });
    try {
      const wallet = createWalletClient({ account: toViemAccount(session), chain: chainFor(input.chainId), transport: http(rpcUrl) });
      return { hash: await wallet.sendTransaction({ to: input.to, data: input.data, value: input.value }) };
    } finally {
      session.end();
    }
  });
}

export async function sendMeraTransactions(
  ownerId: string,
  inputs: readonly Transaction[],
  expectedAddress: string,
  onSubmitted?: (index: number, hash: Hex) => void | Promise<void>,
) {
  if (inputs.length === 0 || inputs.some((input) => input.chainId !== inputs[0].chainId)) {
    throw new Error("Transaction batch is invalid.");
  }
  return withMeraSession(ownerId, async (privateKey, stored) => {
    if (stored.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("TEA passkey account changed.");
    const session = createSecp256k1SigningSession({ privateKey });
    try {
      const chain = chainFor(inputs[0].chainId);
      const wallet = createWalletClient({ account: toViemAccount(session), chain, transport: http(rpcUrl) });
      const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
      return submitTransactionSequence(
        inputs,
        (input) => wallet.sendTransaction({ to: input.to, data: input.data, value: input.value }),
        async (hash) => {
          const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
          if (receipt.status !== "success") throw new Error("Transaction failed.");
        },
        onSubmitted,
      );
    } finally {
      session.end();
    }
  });
}

export async function waitForMeraReceipt(chainId: number, hash: Hex): Promise<TransactionReceipt> {
  const client = createPublicClient({ chain: chainFor(chainId), transport: http(rpcUrl) });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("Transaction failed.");
  return receipt;
}

export async function signMeraTypedData(ownerId: string, expectedAddress: string, typedData: Parameters<ReturnType<typeof toViemAccount>["signTypedData"]>[0]) {
  return withMeraSession(ownerId, async (privateKey, stored) => {
    if (stored.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("TEA passkey account changed.");
    const session = createSecp256k1SigningSession({ privateKey });
    try {
      return toViemAccount(session).signTypedData(typedData);
    } finally {
      session.end();
    }
  });
}

export function meraErrorMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "PRF_UNAVAILABLE") return "This passkey provider does not support Mera. Try iCloud Keychain, 1Password, or Google Password Manager.";
  if (code === "PASSKEY_OPERATION_FAILED") return "The passkey prompt was cancelled or failed. Try again.";
  if (code === "CRYPTO_UNAVAILABLE") return "Mera needs HTTPS or localhost.";
  return error instanceof Error ? error.message : "Mera setup failed.";
}
