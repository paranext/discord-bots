import { describe, expect, it, vi } from "vitest";
import { verifyDiscordRequest } from "../../src/discord/verify.js";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signed(body: string, timestamp: string) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  return { publicKeyHex: toHex(raw), signatureHex: toHex(signature) };
}

describe("verifyDiscordRequest", () => {
  const body = '{"type":1}';
  const timestamp = "1756000000";

  it("accepts a correctly signed request", async () => {
    const { publicKeyHex, signatureHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, signatureHex, timestamp, publicKeyHex)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const { publicKeyHex, signatureHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest('{"type":2}', signatureHex, timestamp, publicKeyHex)).toBe(false);
  });

  it("rejects a replayed signature against a different timestamp", async () => {
    const { publicKeyHex, signatureHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, signatureHex, "1756000001", publicKeyHex)).toBe(false);
  });

  it("rejects missing headers rather than throwing", async () => {
    const { publicKeyHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, null, timestamp, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest(body, "ab".repeat(64), null, publicKeyHex)).toBe(false);
  });

  it("rejects a malformed signature without throwing", async () => {
    const { publicKeyHex } = await signed(body, timestamp);
    expect(await verifyDiscordRequest(body, "not-hex", timestamp, publicKeyHex)).toBe(false);
    expect(await verifyDiscordRequest(body, "abcd", timestamp, publicKeyHex)).toBe(false);
  });

  it("rejects a malformed signature via the hex/length guard, never reaching crypto.subtle", async () => {
    // Without this guard, "not-hex" and "abcd" would still return false, but via
    // hexToBytes throwing (caught by the outer try/catch) or a genuine failed verify —
    // both indistinguishable from the guard actually running. Spy on importKey to prove
    // the guard, not the catch-all, is what rejects these inputs.
    const { publicKeyHex } = await signed(body, timestamp);
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    await verifyDiscordRequest(body, "abcd", timestamp, publicKeyHex);
    expect(importKey).not.toHaveBeenCalled();
    importKey.mockRestore();
  });
});
