export async function deriveMeraVaultKey(prfOutput: Uint8Array) {
  const secret = new Uint8Array(prfOutput.byteLength);
  secret.set(prfOutput);
  const material = await crypto.subtle.importKey("raw", secret.buffer, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("tea:mera:v1"), info: new TextEncoder().encode("private-payment-vault") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
