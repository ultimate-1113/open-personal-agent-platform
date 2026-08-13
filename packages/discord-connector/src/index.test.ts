import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBridgeSignature,
  discordCommandManifest,
  discordInstallUrls,
  flattenCommandOptions,
  verifyBridgeSignature,
  verifyDiscordInteraction,
} from "./index.js";

const bytesToHex = (value: ArrayBuffer): string => Array.from(new Uint8Array(value))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe("Discord interaction security", () => {
  it("accepts an authentic and timely Ed25519 body", async () => {
    const keys = (await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = await webcrypto.subtle.exportKey("raw", keys.publicKey);
    const body = new TextEncoder().encode('{"type":1}');
    const timestamp = "1786579200";
    const signed = new TextEncoder().encode(`${timestamp}{"type":1}`);
    const signature = await webcrypto.subtle.sign("Ed25519", keys.privateKey, signed);
    await expect(verifyDiscordInteraction({ publicKeyHex: bytesToHex(publicKey),
      signatureHex: bytesToHex(signature), timestamp, body,
      now: new Date("2026-08-13T00:00:00.000Z") })).resolves.toBe(true);
  });

  it("rejects modified, malformed, and stale signatures", async () => {
    const body = new TextEncoder().encode("modified");
    await expect(verifyDiscordInteraction({ publicKeyHex: "00".repeat(32),
      signatureHex: "00".repeat(64), timestamp: "1", body,
      now: new Date("2026-08-13T00:00:00.000Z") })).resolves.toBe(false);
    await expect(verifyDiscordInteraction({ publicKeyHex: "zz", signatureHex: "zz",
      timestamp: "invalid", body })).resolves.toBe(false);
  });

  it("authenticates bridge requests and rejects replay-aged requests", async () => {
    const input = { signingKey: "test-signing-key", timestamp: "1786579200",
      nonce: "nonce", bodyDigest: "abc" };
    const signatureHex = await createBridgeSignature(input);
    await expect(verifyBridgeSignature({ ...input, signatureHex,
      now: new Date("2026-08-13T00:00:00.000Z") })).resolves.toBe(true);
    await expect(verifyBridgeSignature({ ...input, signatureHex: `00${signatureHex.slice(2)}`,
      now: new Date("2026-08-13T00:00:00.000Z") })).resolves.toBe(false);
    await expect(verifyBridgeSignature({ ...input, signatureHex,
      now: new Date("2026-08-14T00:00:00.000Z") })).resolves.toBe(false);
  });
});

describe("Discord command contract", () => {
  it("flattens subcommands without trusting nested principal data", () => {
    expect(flattenCommandOptions([{ name: "create", type: 1, options: [
      { name: "title", type: 3, value: "Test" },
      { name: "enabled", type: 5, value: true },
    ] }])).toEqual({ subcommand: "create", title: "Test", enabled: true });
  });

  it("publishes all localized commands and least-privilege install URLs", () => {
    expect(discordCommandManifest.map((command) => command.name)).toEqual([
      "link", "agent", "tasks", "approvals", "audit", "notify-here", "notify-off-here", "unlink", "status", "timezone",
    ]);
    expect(discordCommandManifest.every((command) =>
      command.description_localizations.ja.length > 0)).toBe(true);
    expect(discordCommandManifest[1].options[0]?.max_length).toBe(6_000);
    const tasks = discordCommandManifest.find((command) => command.name === "tasks");
    const once = tasks?.options.find((option) => option.name === "once");
    const repeat = tasks?.options.find((option) => option.name === "repeat");
    expect(tasks?.options.map((option) => String(option.name))).not.toContain("create");
    expect(once?.options?.map((option) => option.name)).toEqual([
      "title", "description", "time", "date",
    ]);
    expect(repeat?.options?.map((option) => option.name)).toEqual(expect.arrayContaining([
      "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    ]));
    expect(repeat?.options?.find((option) => option.name === "frequency")?.required).toBe(true);
    expect(discordInstallUrls("123")).toEqual({
      user: "https://discord.com/oauth2/authorize?client_id=123&scope=applications.commands&integration_type=1",
      guild: "https://discord.com/oauth2/authorize?client_id=123&scope=applications.commands%20bot&permissions=19456&integration_type=0",
    });
  });
});
