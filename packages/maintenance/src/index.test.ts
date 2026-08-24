import { describe, expect, it } from "vitest";
import { sanitizeExportValue, sha256Hex } from "./index.js";

describe("sanitizeExportValue", () => {
  it("removes credentials and nested token material", () => {
    expect(sanitizeExportValue({ message: "ok", accessToken: "no", nested: {
      refresh_token: "no", botSecret: "no", visible: 1,
    } })).toEqual({ message: "ok", nested: { visible: 1 } });
  });

  it("marks secret policy metadata without exporting a secret payload", () => {
    expect(sanitizeExportValue({ informationPolicy: { sensitivity: "secret" } }))
      .toEqual({ informationPolicy: { sensitivity: "secret", redacted: true } });
  });

  it("preserves primitives, nulls and array shape while sanitizing each item", () => {
    expect(sanitizeExportValue([null, "text", 3, { api_token: "no", ok: true }]))
      .toEqual([null, "text", 3, { ok: true }]);
  });

  it("computes the export content digest", async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
