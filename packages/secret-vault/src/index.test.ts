import { describe, expect, it } from "vitest";
import { decryptSecrets, encryptSecrets, generatePlatformSecrets } from "./index";

describe("secret vault", () => {
  it("generates distinct connector KEKs and a matching lease pair", () => {
    const secrets = generatePlatformSecrets();
    const privateJwk = JSON.parse(secrets["EXECUTION_LEASE_PRIVATE_JWK"]!) as Record<string, unknown>;
    const publicJwk = JSON.parse(secrets["EXECUTION_LEASE_PUBLIC_JWK"]!) as Record<string, unknown>;
    expect(secrets["GOOGLE_CREDENTIAL_KEK"]).not.toBe(secrets["GITHUB_CREDENTIAL_KEK"]);
    expect(privateJwk["d"]).toBeTypeOf("string");
    expect(publicJwk["d"]).toBeUndefined();
  });
  it("round trips and authenticates an encrypted recovery file", async () => {
    const encrypted = await encryptSecrets({ TOKEN: "private" }, "correct horse battery staple");
    await expect(decryptSecrets(encrypted, "correct horse battery staple")).resolves.toEqual({ TOKEN: "private" });
    await expect(decryptSecrets(encrypted, "wrong passphrase value")).rejects.toThrow();
    const changed = structuredClone(encrypted);
    changed.cipher.ciphertext = `${changed.cipher.ciphertext[0] === "A" ? "B" : "A"}${changed.cipher.ciphertext.slice(1)}`;
    await expect(decryptSecrets(changed, "correct horse battery staple")).rejects.toThrow();
  });
});
