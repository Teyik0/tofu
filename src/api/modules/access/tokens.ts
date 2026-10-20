/** SHA-256 of a secret; only this digest is stored. */
export function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** URL-safe random secret. */
export function randomToken(bytes: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}
