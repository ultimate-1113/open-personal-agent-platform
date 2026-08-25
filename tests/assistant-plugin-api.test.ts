import { describe, expect, it } from "vitest";
import { createAssistantApp } from "../apps/assistant-worker/src/index.js";

describe("owner plugin API", () => {
  it("requires owner authorization for plugin routes", async () => {
    const app = createAssistantApp({
      authorizeOwner: () => Promise.resolve({ outcome: "denied" as const }),
    });

    expect((await app.request("/v1/plugins")).status).toBe(403);
    expect((await app.request("/v1/plugins/inspections", { method: "POST" })).status)
      .toBe(403);
  });

  it("passes the verified owner principal to inspection recording", async () => {
    const recordedBodies: unknown[] = [];
    const app = createAssistantApp({
      authorizeOwner: () => Promise.resolve({
        outcome: "authorized" as const,
        principalId: "principal:owner",
      }),
    });
    const runtime = {
      fetch: () => Promise.resolve(Response.json({
        inspectionId: "inspection:1",
        manifest: {},
        archiveSha256: "a".repeat(64),
        archiveSizeBytes: 1,
        unpackedSizeBytes: 1,
        entryCount: 1,
        inspectedAt: "2026-08-25T00:00:00.000Z",
      })),
    };
    const control = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new TypeError("Expected JSON request body");
        recordedBodies.push(JSON.parse(init.body));
        return Promise.resolve(Response.json({ inspectionId: "inspection:1", status: "accepted" }));
      },
    };

    const response = await app.request("/v1/plugins/inspections", {
      method: "POST",
      headers: {
        "Content-Type": "application/gzip",
        "Idempotency-Key": "inspection:1",
      },
      body: new Uint8Array([1]),
    }, {
      DEPLOYMENT_ID: "deployment:test",
      PLUGIN_RUNTIME: runtime,
      CONTROL: control,
    });

    expect(response.status).toBe(200);
    expect(recordedBodies).toHaveLength(1);
    expect(recordedBodies[0]).toMatchObject({
      deploymentId: "deployment:test",
      principalId: "principal:owner",
      idempotencyKey: "inspection:1",
    });
  });
});
