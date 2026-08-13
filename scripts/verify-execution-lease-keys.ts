import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type WranglerConfig = { name?: unknown; vars?: Record<string, unknown> };

const directory = resolve(process.argv[2] ?? ".wrangler/staging");
const files = (await readdir(directory)).filter((file) => file.endsWith("-gatekeeper.jsonc")).sort();
if (files.length === 0) throw new Error(`No Gatekeeper configs found in ${directory}`);

const keys = new Map<string, string[]>();
for (const file of files) {
  const config = JSON.parse(await readFile(resolve(directory, file), "utf8")) as WranglerConfig;
  const raw = config.vars?.["EXECUTION_LEASE_PUBLIC_JWK"];
  if (raw === undefined) continue;
  if (typeof raw !== "string") throw new Error(`${file}: EXECUTION_LEASE_PUBLIC_JWK must be a JSON string`);
  const jwk = JSON.parse(raw) as Record<string, unknown>;
  if (jwk["kty"] !== "OKP" || jwk["crv"] !== "Ed25519" || typeof jwk["x"] !== "string") {
    throw new Error(`${file}: invalid Ed25519 public JWK`);
  }
  const canonical = JSON.stringify({ crv: jwk["crv"], kty: jwk["kty"], x: jwk["x"] });
  const workerName = typeof config.name === "string" ? config.name : file;
  keys.set(canonical, [...(keys.get(canonical) ?? []), workerName]);
}

if (keys.size === 0) throw new Error("No EXECUTION_LEASE_PUBLIC_JWK values were found");
if (keys.size !== 1) {
  const detail = [...keys.values()].map((workers) => workers.join(", ")).join(" | ");
  throw new Error(`Execution Lease public keys do not match: ${detail}`);
}

console.log(`Execution Lease public key matches across ${[...keys.values()][0]?.length ?? 0} Gatekeepers.`);
