import { describe, expect, it } from "vitest";
import { accessJwtFromRequest } from "../apps/assistant-worker/src/index.js";

describe("Access JWT source", () => {
  it("prefers the Access assertion header", () => {
    const request = new Request("https://assistant.example/v1/usage", {
      headers: {
        "Cf-Access-Jwt-Assertion": "header.jwt.value",
        Cookie: "CF_Authorization=cookie.jwt.value",
      },
    });
    expect(accessJwtFromRequest(request)).toBe("header.jwt.value");
  });

  it("uses the signed application cookie when the header is absent", () => {
    const request = new Request("https://assistant.example/v1/usage", {
      headers: { Cookie: "other=value; CF_Authorization=cookie.jwt.value" },
    });
    expect(accessJwtFromRequest(request)).toBe("cookie.jwt.value");
  });

  it("rejects missing and empty Access credentials", () => {
    expect(accessJwtFromRequest(new Request("https://assistant.example"))).toBeUndefined();
    expect(accessJwtFromRequest(new Request("https://assistant.example", {
      headers: { Cookie: "CF_Authorization=" },
    }))).toBeUndefined();
  });
});
