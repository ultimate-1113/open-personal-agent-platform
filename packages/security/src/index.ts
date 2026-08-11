import type { JsonValue } from "@opap/contracts";

const textEncoder = new TextEncoder();

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

function assertJsonNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError("Canonical JSON does not support non-finite numbers");
  }
}

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    assertJsonNumber(value);
    return JSON.stringify(value);
  }

  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  const objectValue: Readonly<Record<string, JsonValue>> = value;
  const entries = Object.entries(objectValue).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalizeJson(item)}`,
    )
    .join(",")}}`;
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> =
    typeof value === "string" ? textEncoder.encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function digestJson(value: JsonValue): Promise<string> {
  return sha256Hex(canonicalizeJson(value));
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
