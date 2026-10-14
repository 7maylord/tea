import type { PasskeyCredentialMetadata } from "@category-labs/mera";

export type StoredMeraWallet = {
  credential: PasskeyCredentialMetadata;
  address: `0x${string}`;
};

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

export function saveMeraWallet(ownerId: string, wallet: StoredMeraWallet) {
  localStorage.setItem(meraKey(ownerId), JSON.stringify(wallet));
}

export function copyMeraWallet(fromOwnerId: string, toOwnerId: string) {
  const wallet = readMeraWallet(fromOwnerId);
  if (wallet && !readMeraWallet(toOwnerId)) saveMeraWallet(toOwnerId, wallet);
}
