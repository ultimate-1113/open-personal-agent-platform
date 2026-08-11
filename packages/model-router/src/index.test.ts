import { describe, expect, it } from "vitest";
import type { InformationPolicy } from "@opap/contracts";
import {
  AiGatewayProvider,
  MockModelProvider,
  ModelRouter,
  WorkersAiProvider,
  estimateWorkersAiNeurons,
  resolveMaxOutputTokens,
} from "./index.js";

const policy = (overrides: Partial<InformationPolicy> = {}): InformationPolicy => ({
  deploymentId: "deployment:fixture",
  subjectPrincipalIds: ["principal:owner"],
  visibility: "owner",
  sensitivity: "normal",
  trust: "trusted",
  allowedAudienceIds: ["principal:owner"],
  allowedDestinationIds: ["model:local"],
  retention: { mode: "until-deleted" },
  ...overrides,
});

describe("ModelRouter", () => {
  it("uses a permitted healthy provider", async () => {
    const router = new ModelRouter([
      new MockModelProvider({ id: "model:local", response: "ok" }),
    ]);
    await expect(
      router.generate({
        messages: [{ role: "user", content: "hello" }],
        informationPolicy: policy(),
      }),
    ).resolves.toMatchObject({ providerId: "model:local", text: "ok" });
  });

  it("fails closed instead of falling back to an unapproved cloud model", async () => {
    const router = new ModelRouter([
      new MockModelProvider({ id: "model:local", health: "unavailable" }),
      new MockModelProvider({ id: "model:cloud", location: "cloud" }),
    ]);
    await expect(
      router.generate({
        messages: [{ role: "user", content: "private" }],
        informationPolicy: policy(),
      }),
    ).rejects.toMatchObject({
      code: "MODEL_PROVIDER_UNAVAILABLE",
    });
  });

  it("always rejects secret data", async () => {
    const router = new ModelRouter([
      new MockModelProvider({ id: "model:local" }),
    ]);
    await expect(
      router.generate({
        messages: [{ role: "user", content: "secret" }],
        informationPolicy: policy({ sensitivity: "secret" }),
      }),
    ).rejects.toMatchObject({
      code: "MODEL_SECRET_DENIED",
    });
  });

  it("uses smaller defaults for public and delegated answers", () => {
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      informationPolicy: policy(),
    };
    expect(resolveMaxOutputTokens({ ...request, audience: "owner" })).toBe(2_048);
    expect(resolveMaxOutputTokens({ ...request, audience: "public" })).toBe(1_024);
    expect(() => resolveMaxOutputTokens({ ...request, maxOutputTokens: 4_097 })).toThrow(
      "safety maximum",
    );
  });

  it("routes cloud requests through AI Gateway without payload logging", async () => {
    const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
    const provider = new AiGatewayProvider({
      id: "model:workers-ai",
      endpoint: "https://gateway.example.test/chat/completions",
      authorizationToken: "fixture-token",
      model: "workers-ai/@cf/meta/llama",
      fetcher: (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) });
        return Promise.resolve(
          Response.json({
            choices: [{ message: { content: "answer" } }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
        );
      },
    });
    const router = new ModelRouter([provider]);
    await expect(
      router.generate({
        messages: [{ role: "user", content: "hello" }],
        informationPolicy: policy({ allowedDestinationIds: [provider.descriptor.id] }),
        taskId: "task:fixture",
      }),
    ).resolves.toMatchObject({ text: "answer" });
    expect(new Headers(calls[0]?.init?.headers).get("cf-aig-collect-log-payload")).toBe(
      "false",
    );
  });

  it("does not fall back after AI Gateway spend rejection", async () => {
    let fallbackCalls = 0;
    const gateway = new AiGatewayProvider({
      id: "model:gateway",
      endpoint: "https://gateway.example.test/chat/completions",
      authorizationToken: "fixture-token",
      model: "workers-ai/model",
      fetcher: () => Promise.resolve(new Response(null, { status: 429 })),
    });
    const fallback: typeof gateway = new AiGatewayProvider({
      id: "model:fallback",
      endpoint: "https://fallback.example.test/chat/completions",
      authorizationToken: "fixture-token",
      model: "workers-ai/fallback",
      fetcher: () => {
        fallbackCalls += 1;
        return Promise.resolve(Response.json({ choices: [{ message: { content: "no" } }] }));
      },
    });
    const router = new ModelRouter([gateway, fallback]);
    await expect(
      router.generate({
        messages: [{ role: "user", content: "hello" }],
        informationPolicy: policy({
          allowedDestinationIds: [gateway.descriptor.id, fallback.descriptor.id],
        }),
      }),
    ).rejects.toMatchObject({ code: "AI_SPEND_LIMIT_REACHED" });
    expect(fallbackCalls).toBe(0);
  });

  it("routes Workers AI through the configured Gateway", async () => {
    const calls: {
      input: { messages: readonly unknown[]; max_tokens: number };
      options?: { gateway?: { id: string; collectLog?: boolean; metadata?: Readonly<Record<string, string>> } };
    }[] = [];
    const provider = new WorkersAiProvider({
      run: (_model, input, options) => {
        calls.push({ input, ...(options === undefined ? {} : { options }) });
        return Promise.resolve({ response: "workers response" });
      },
    }, "@cf/meta/llama", "opap-gateway");
    await expect(provider.generate({
      messages: [{ role: "user", content: "hello" }],
      informationPolicy: policy({ allowedDestinationIds: ["provider:workers-ai"] }),
      audience: "owner",
    })).resolves.toMatchObject({ text: "workers response" });
    expect(calls[0]?.input.max_tokens).toBe(2_048);
    expect(calls[0]?.options).toEqual({ gateway: {
      id: "opap-gateway",
      collectLog: false,
      metadata: {
        application: "opap",
        task_id: "unscoped",
        payload_logging: "disabled",
      },
    } });
  });

  it("accepts an OpenAI-compatible response returned by Workers AI", async () => {
    const provider = new WorkersAiProvider({
      run: () => Promise.resolve({
        choices: [{ message: { content: "gemma response" } }],
        usage: { prompt_tokens: 73, completion_tokens: 12 },
      }),
    }, "@cf/google/gemma-4-26b-a4b-it", "opap-gateway");

    await expect(provider.generate({
      messages: [{ role: "user", content: "hello" }],
      informationPolicy: policy({ allowedDestinationIds: ["provider:workers-ai"] }),
      audience: "owner",
    })).resolves.toEqual({
      providerId: "provider:workers-ai",
      text: "gemma response",
      usage: { inputTokens: 73, outputTokens: 12 },
    });
  });

  it("returns structured Gemma tool calls", async () => {
    const provider = new WorkersAiProvider({
      run: () => Promise.resolve({
        tool_calls: [{ name: "google_gmail_search", arguments: { query: "is:unread" } }],
      }),
    }, "@cf/google/gemma-4-26b-a4b-it", "opap-gateway");
    await expect(provider.generate({
      messages: [{ role: "user", content: "未読メールを探して" }],
      tools: [{
        name: "google_gmail_search",
        description: "Search Gmail",
        parameters: { type: "object", properties: {} },
      }],
      informationPolicy: policy({ allowedDestinationIds: ["provider:workers-ai"] }),
    })).resolves.toMatchObject({
      text: "",
      toolCalls: [{ name: "google_gmail_search", arguments: { query: "is:unread" } }],
    });
  });

  it("reserves a conservative Workers AI neuron maximum", () => {
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      informationPolicy: policy(),
      audience: "owner" as const,
    };
    expect(estimateWorkersAiNeurons(request)).toBeGreaterThan(
      estimateWorkersAiNeurons(request, "short answer"),
    );
  });

  it("maps a Workers AI Gateway 429 without trying another provider", async () => {
    const provider = new WorkersAiProvider({
      run: () => Promise.reject(Object.assign(new Error("gateway 429"), { status: 429 })),
    }, "@cf/google/gemma-4-26b-a4b-it", "opap-gateway");
    await expect(provider.generate({
      messages: [{ role: "user", content: "hello" }],
      informationPolicy: policy({ allowedDestinationIds: ["provider:workers-ai"] }),
    })).rejects.toMatchObject({ code: "AI_SPEND_LIMIT_REACHED" });
  });
});
