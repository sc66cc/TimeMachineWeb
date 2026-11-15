/** Compatibility adapter for DPlanet's public account digest protocol.
 * Source and algorithm provenance are recorded in ../source-manifest.json.
 * This suffix is part of the existing protocol, not a secret or credential.
 */
const ACCOUNT_DIGEST_SUFFIX = "DPlanet-456852";

export async function GetPassword(account: string, password: string): Promise<string> {
  const raw = account + password + ACCOUNT_DIGEST_SUFFIX;
  // CryptoJS rejects lone UTF-16 surrogates; TextEncoder would silently replace them.
  encodeURIComponent(raw);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Retain ordinary HTTP development support without adding legacy MD5 or all
  // of CryptoJS to the initial bundle. Its default string encoding is hex.
  const { default: sha256 } = await import("crypto-js/sha256");
  return sha256(raw).toString();
}
