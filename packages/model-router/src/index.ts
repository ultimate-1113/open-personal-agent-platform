import type { InformationPolicy, JsonValue } from "@opap/contracts";

export type ProviderLocation = "local" | "cloud";
export type ProviderHealth = "healthy" | "degraded" | "unavailable";

export type ModelProviderDescriptor = {
  id: string;
  location: ProviderLocation;
  capabilities: readonly ("generate" | "embed" | "transcribe" | "tools")[];
  retainsInputs: boolean;
  trainsOnInputs: boolean;
  region?: string;
  estimatedInputCostPerMillion?: number;
  estimatedOutputCostPerMillion?: number;
};

export type ModelToolDefinition = {
  name: string;
  description: string;
  parameters: Readonly<Record<string, JsonValue>>;
};

export type ModelToolCall = {
  name: string;
  arguments: Readonly<Record<string, JsonValue>>;
};

export type ModelRequest = {
  messages: readonly {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
  }[];
  informationPolicy: InformationPolicy;
  approvedSensitiveCloudTransfer?: boolean;
  taskId?: string;
  audience?: "owner" | "public" | "delegated";
  maxOutputTokens?: number;
  tools?: readonly ModelToolDefinition[];
};

export type ModelResponse = {
  providerId: string;
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: JsonValue;
  toolCalls?: readonly ModelToolCall[];
};

export interface ModelProvider {
  readonly descriptor: ModelProviderDescriptor;
  healthCheck(): Promise<ProviderHealth>;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export const ABSOLUTE_MAX_OUTPUT_TOKENS = 4_096;
export const OWNER_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
export const EXTERNAL_DEFAULT_MAX_OUTPUT_TOKENS = 1_024;

// @cf/google/gemma-4-26b-a4b-it, Cloudflare price catalog verified 2026-08.
export const DEFAULT_WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const DEFAULT_WORKERS_AI_NEURONS_PER_MILLION = {
  input: 9_091,
  output: 27_273,
} as const;

export const estimateTextTokens = (text: string): number =>
  Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 3));

export function estimateWorkersAiNeurons(
  request: ModelRequest,
  outputText?: string,
): number {
  const inputTokens = request.messages.reduce(
    (total, message) => total + estimateTextTokens(message.content) + 4,
    0,
  ) + (request.tools ? estimateTextTokens(JSON.stringify(request.tools)) : 0);
  const outputTokens = outputText === undefined
    ? resolveMaxOutputTokens(request)
    : Math.min(resolveMaxOutputTokens(request), estimateTextTokens(outputText));
  return Math.max(1, Math.ceil(
    (inputTokens * DEFAULT_WORKERS_AI_NEURONS_PER_MILLION.input +
      outputTokens * DEFAULT_WORKERS_AI_NEURONS_PER_MILLION.output) / 1_000_000,
  ));
}

export function resolveMaxOutputTokens(request: ModelRequest): number {
  const defaultValue =
    request.audience === "public" || request.audience === "delegated"
      ? EXTERNAL_DEFAULT_MAX_OUTPUT_TOKENS
      : OWNER_DEFAULT_MAX_OUTPUT_TOKENS;
  const requested = request.maxOutputTokens ?? defaultValue;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ModelRoutingError("MODEL_OUTPUT_LIMIT_INVALID", "Output token limit is invalid");
  }
  if (requested > ABSOLUTE_MAX_OUTPUT_TOKENS) {
    throw new ModelRoutingError(
      "MODEL_OUTPUT_LIMIT_EXCEEDED",
      "Output token limit exceeds the platform safety maximum",
    );
  }
  return requested;
}

export class ModelRoutingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRoutingError";
    this.code = code;
  }
}

export class ModelRouter {
  readonly #providers: readonly ModelProvider[];

  constructor(providers: readonly ModelProvider[]) {
    this.#providers = providers;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.informationPolicy.sensitivity === "secret") {
      throw new ModelRoutingError(
        "MODEL_SECRET_DENIED",
        "Secret information cannot be sent to a model",
      );
    }
    resolveMaxOutputTokens(request);

    let hadPermittedProvider = false;
    for (const provider of this.#providers) {
      if (
        !request.informationPolicy.allowedDestinationIds.includes(
          provider.descriptor.id,
        )
      ) {
        continue;
      }
      if (
        provider.descriptor.location === "cloud" &&
        request.informationPolicy.sensitivity === "sensitive" &&
        request.approvedSensitiveCloudTransfer !== true
      ) {
        continue;
      }
      hadPermittedProvider = true;
      if ((await provider.healthCheck()) === "unavailable") continue;
      return provider.generate(request);
    }

    throw new ModelRoutingError(
      hadPermittedProvider ? "MODEL_PROVIDER_UNAVAILABLE" : "MODEL_DESTINATION_DENIED",
      hadPermittedProvider
        ? "Every permitted model provider is unavailable"
        : "No model destination is permitted for this information",
    );
  }
}

export type AiGatewayProviderOptions = {
  id: string;
  endpoint: string;
  authorizationToken: string;
  model: string;
  fetcher?: typeof fetch;
};

type AiGatewayResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class AiGatewayProvider implements ModelProvider {
  readonly descriptor: ModelProviderDescriptor;
  readonly #options: AiGatewayProviderOptions;

  constructor(options: AiGatewayProviderOptions) {
    this.#options = options;
    this.descriptor = {
      id: options.id,
      location: "cloud",
      capabilities: ["generate"],
      retainsInputs: false,
      trainsOnInputs: false,
    };
  }

  healthCheck(): Promise<ProviderHealth> {
    return Promise.resolve("healthy");
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const maxTokens = resolveMaxOutputTokens(request);
    const fetcher = this.#options.fetcher ?? fetch;
    const response = await fetcher(this.#options.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#options.authorizationToken}`,
        "Content-Type": "application/json",
        "cf-aig-collect-log-payload": "false",
        "cf-aig-metadata": JSON.stringify({
          task_id: request.taskId ?? "unscoped",
          application: "opap",
        }),
      },
      body: JSON.stringify({
        model: this.#options.model,
        messages: request.messages,
        max_tokens: maxTokens,
      }),
    });
    if (response.status === 429) {
      throw new ModelRoutingError(
        "AI_SPEND_LIMIT_REACHED",
        "AI Gateway rejected the request because its spend limit was reached",
      );
    }
    if (!response.ok) {
      throw new ModelRoutingError(
        "MODEL_PROVIDER_FAILED",
        `AI Gateway returned HTTP ${response.status}`,
      );
    }
    const result = (await response.json()) as AiGatewayResponse;
    const text = result.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new ModelRoutingError("MODEL_PROVIDER_FAILED", "AI Gateway response is invalid");
    }
    return {
      providerId: this.descriptor.id,
      text,
      ...(result.usage === undefined
        ? {}
        : {
            usage: {
              inputTokens: result.usage.prompt_tokens ?? 0,
              outputTokens: result.usage.completion_tokens ?? 0,
            },
          }),
    };
  }
}

export class MockModelProvider implements ModelProvider {
  readonly descriptor: ModelProviderDescriptor;
  readonly #response: string;
  readonly #health: ProviderHealth;

  constructor(options: {
    id: string;
    location?: ProviderLocation;
    response?: string;
    health?: ProviderHealth;
  }) {
    this.descriptor = {
      id: options.id,
      location: options.location ?? "local",
      capabilities: ["generate"],
      retainsInputs: false,
      trainsOnInputs: false,
    };
    this.#response = options.response ?? "mock response";
    this.#health = options.health ?? "healthy";
  }

  healthCheck(): Promise<ProviderHealth> {
    return Promise.resolve(this.#health);
  }

  generate(): Promise<ModelResponse> {
    return Promise.resolve({ providerId: this.descriptor.id, text: this.#response });
  }
}

export class MockLocalProvider extends MockModelProvider {
  constructor(response = "Mock Local Provider response") {
    super({ id: "provider:mock-local", location: "local", response });
  }
}

export type WorkersAiBinding = {
  run(
    model: string,
    input: {
      messages: ModelRequest["messages"];
      max_tokens: number;
      tools?: readonly ModelToolDefinition[];
      tool_choice?: "auto";
    },
    options?: {
      gateway?: {
        id: string;
        collectLog?: boolean;
        metadata?: Readonly<Record<string, string>>;
      };
    },
  ): Promise<unknown>;
};

export class WorkersAiProvider implements ModelProvider {
  readonly descriptor: ModelProviderDescriptor = {
    id: "provider:workers-ai",
    location: "cloud",
    capabilities: ["generate", "tools"],
    retainsInputs: false,
    trainsOnInputs: false,
  };

  constructor(
    readonly binding: WorkersAiBinding,
    readonly model: string,
    readonly gatewayId: string,
  ) {}

  healthCheck(): Promise<ProviderHealth> {
    return Promise.resolve("healthy");
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let result: unknown;
    try {
      result = await this.binding.run(
        this.model,
        {
          messages: request.messages,
          max_tokens: resolveMaxOutputTokens(request),
          ...(request.tools?.length
            ? { tools: request.tools, tool_choice: "auto" as const }
            : {}),
        },
        {
          gateway: {
            id: this.gatewayId,
            // Binding requests cannot currently select metadata-only payload
            // logging. Disable the Gateway log and persist sanitized usage in
            // OPAP's audit ledger instead.
            collectLog: false,
            metadata: {
              application: "opap",
              task_id: request.taskId ?? "unscoped",
              payload_logging: "disabled",
            },
          },
        },
      );
    } catch (error) {
      const status = typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)["status"]
        : undefined;
      if (status === 429 || (error instanceof Error && /\b429\b/u.test(error.message))) {
        throw new ModelRoutingError(
          "AI_SPEND_LIMIT_REACHED",
          "AI Gateway rejected the request because its spend limit was reached",
        );
      }
      throw new ModelRoutingError("MODEL_PROVIDER_FAILED", "Workers AI request failed");
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new ModelRoutingError("MODEL_PROVIDER_FAILED", "Workers AI response is invalid");
    }
    const resultRecord = result as Record<string, unknown>;
    const legacyResponse = resultRecord["response"];
    const choices = resultRecord["choices"];
    const firstChoice: unknown = Array.isArray(choices)
      ? (choices as unknown[])[0]
      : undefined;
    const message = typeof firstChoice === "object" && firstChoice !== null
      ? (firstChoice as Record<string, unknown>)["message"]
      : undefined;
    const openAiContent = typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)["content"]
      : undefined;
    const toolCallsValue = resultRecord["tool_calls"] ??
      (typeof message === "object" && message !== null
        ? (message as Record<string, unknown>)["tool_calls"]
        : undefined);
    const toolCalls = Array.isArray(toolCallsValue)
      ? toolCallsValue.flatMap((item): ModelToolCall[] => {
          if (typeof item !== "object" || item === null) return [];
          const row = item as Record<string, unknown>;
          const functionValue = typeof row["function"] === "object" && row["function"] !== null
            ? row["function"] as Record<string, unknown>
            : row;
          const name = functionValue["name"];
          let args: unknown = functionValue["arguments"];
          if (typeof args === "string") {
            try { args = JSON.parse(args) as unknown; } catch { return []; }
          }
          return typeof name === "string" && typeof args === "object" && args !== null &&
            !Array.isArray(args)
            ? [{ name, arguments: args as Record<string, JsonValue> }]
            : [];
        })
      : [];
    const text = typeof legacyResponse === "string"
      ? legacyResponse
      : typeof openAiContent === "string" ? openAiContent : "";
    if (!text && toolCalls.length === 0) {
      throw new ModelRoutingError("MODEL_PROVIDER_FAILED", "Workers AI response is invalid");
    }
    const usage = resultRecord["usage"];
    const usageRecord = typeof usage === "object" && usage !== null
      ? usage as Record<string, unknown>
      : undefined;
    const inputTokens = usageRecord?.["prompt_tokens"];
    const outputTokens = usageRecord?.["completion_tokens"];
    return {
      providerId: this.descriptor.id,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(typeof inputTokens === "number" && typeof outputTokens === "number"
        ? { usage: { inputTokens, outputTokens } }
        : {}),
    };
  }
}
