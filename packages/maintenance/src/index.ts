export const EXPORT_FORMAT = "opap-export/v1" as const;
export const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1_000;

const forbiddenKey = /(?:access|refresh|interaction|bot|oauth|api)[_-]?token|secret|private[_-]?key|argon2|execution[_-]?lease/iu;

export function sanitizeExportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey.test(key)) continue;
    if (key === "informationPolicy" && typeof item === "object" && item !== null &&
      (item as Record<string, unknown>)["sensitivity"] === "secret") {
      output[key] = { ...item as Record<string, unknown>, redacted: true };
      continue;
    }
    output[key] = sanitizeExportValue(item);
  }
  return output;
}

export type ExportFileRecord = {
  name: string;
  bytes: number;
  sha256: string;
};

export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  deploymentId: string;
  exportId: string;
  createdAt: string;
  expiresAt: string;
  files: ExportFileRecord[];
};

export async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
