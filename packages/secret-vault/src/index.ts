import { generateKeyPairSync, randomBytes, webcrypto } from "node:crypto";
import { argon2id } from "hash-wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type EncryptedSecretFile = {
  apiVersion: "opap.dev/encrypted-secrets/v1alpha1";
  kdf: { name: "argon2id"; iterations: number; memorySize: number; parallelism: number; salt: string };
  cipher: { name: "AES-256-GCM"; nonce: string; ciphertext: string };
};

const base64url = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"));

export function generatePlatformSecrets(): Record<string, string> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    GOOGLE_CREDENTIAL_KEK: base64url(randomBytes(32)),
    GITHUB_CREDENTIAL_KEK: base64url(randomBytes(32)),
    DELEGATED_CREDENTIAL_KEK: base64url(randomBytes(32)),
    PLUGIN_INVOCATION_SIGNING_KEY: base64url(randomBytes(32)),
    DISCORD_BRIDGE_SIGNING_KEY: base64url(randomBytes(32)),
    OAUTH_STATE_SIGNING_KEY: base64url(randomBytes(32)),
    EXPORT_SIGNING_KEY: base64url(randomBytes(32)),
    EXECUTION_LEASE_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
    EXECUTION_LEASE_PUBLIC_JWK: JSON.stringify(publicKey.export({ format: "jwk" })),
  };
}

export async function encryptSecrets(secrets: Record<string, string>, passphrase: string): Promise<EncryptedSecretFile> {
  if (passphrase.length < 12) throw new Error("Recovery passphrase must be at least 12 characters");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const iterations = 3;
  const memorySize = 65_536;
  const parallelism = 1;
  const derived = await argon2id({ password: passphrase, salt, iterations, memorySize,
    parallelism, hashLength: 32, outputType: "binary" });
  const key = await webcrypto.subtle.importKey("raw", derived, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key,
    encoder.encode(JSON.stringify(secrets)));
  return { apiVersion: "opap.dev/encrypted-secrets/v1alpha1",
    kdf: { name: "argon2id", iterations, memorySize, parallelism, salt: base64url(salt) },
    cipher: { name: "AES-256-GCM", nonce: base64url(nonce), ciphertext: base64url(new Uint8Array(ciphertext)) } };
}

export async function decryptSecrets(file: EncryptedSecretFile, passphrase: string): Promise<Record<string, string>> {
  const derived = await argon2id({ password: passphrase, salt: bytes(file.kdf.salt),
    iterations: file.kdf.iterations, memorySize: file.kdf.memorySize,
    parallelism: file.kdf.parallelism, hashLength: 32, outputType: "binary" });
  const key = await webcrypto.subtle.importKey("raw", derived, "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(file.cipher.nonce) },
    key, bytes(file.cipher.ciphertext));
  const value: unknown = JSON.parse(decoder.decode(plaintext));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid secret payload");
  if (!Object.values(value).every((item) => typeof item === "string")) throw new Error("Invalid secret payload");
  return value as Record<string, string>;
}
