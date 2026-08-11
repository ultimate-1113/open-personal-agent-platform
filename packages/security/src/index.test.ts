import { describe, expect, it } from "vitest";
import { canonicalizeJson, digestJson, timingSafeEqualText } from "./index.js";

describe("canonicalizeJson", () => {
  it("sorts object keys recursively", () => {
    expect(
      canonicalizeJson({ z: 1, a: { y: true, b: "value" } }),
    ).toBe('{"a":{"b":"value","y":true},"z":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrow(TypeError);
  });
});

describe("digestJson", () => {
  it("produces the same digest regardless of key order", async () => {
    await expect(digestJson({ b: 2, a: 1 })).resolves.toBe(
      await digestJson({ a: 1, b: 2 }),
    );
  });
});

describe("timingSafeEqualText", () => {
  it("compares equal and unequal strings", () => {
    expect(timingSafeEqualText("same", "same")).toBe(true);
    expect(timingSafeEqualText("same", "other")).toBe(false);
  });
});
