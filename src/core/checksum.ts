export function normalizeSha256Hex(checksum: string): string {
  const normalized = checksum.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Expected a lowercase or uppercase SHA-256 hex digest");
  }
  return normalized;
}

export function sha256HexToBase64(checksum: string): string {
  return Buffer.from(normalizeSha256Hex(checksum), "hex").toString("base64");
}
