import { queryRequestSchema, queryResponseSchema, type QueryRequest, type QueryResponse } from "@opap/contracts";
import { z } from "zod";

export type KnowledgeSourceSummary = { sourceId: string; kind: string; title?: string };
export type KnowledgeApplicationService = {
  listSources(): Promise<readonly KnowledgeSourceSummary[]>;
  query(input: QueryRequest): Promise<QueryResponse>;
};

const querySchema = z.toJSONSchema(queryRequestSchema, { target: "draft-2020-12" });
const responseSchema = z.toJSONSchema(queryResponseSchema, { target: "draft-2020-12" });
const problemSchema = { type: "object", required: ["type", "title", "status", "requestId"], properties: {
  type: { type: "string", format: "uri" }, title: { type: "string" }, status: { type: "integer" },
  requestId: { type: "string" }, errors: {},
} } as const;
const problemResponse = (description: string) => ({ description, content: {
  "application/problem+json": { schema: problemSchema },
} });

const utf8Size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const truncateUtf8 = (value: string, maximumBytes: number): string =>
  new TextDecoder().decode(new TextEncoder().encode(value).slice(0, maximumBytes));

/** Enforces the public 64 KiB response contract without splitting UTF-8 code points. */
export const boundQueryResponse = (response: QueryResponse, maximumBytes = 65_536): QueryResponse => {
  let bounded = response;
  while (utf8Size(bounded) > maximumBytes) {
    if (bounded.mode === "search" && bounded.results.length > 0) {
      bounded = { ...bounded, results: bounded.results.slice(0, -1) };
      continue;
    }
    if (bounded.mode === "answer" && bounded.citations.length > 0) {
      bounded = { ...bounded, citations: bounded.citations.slice(0, -1) };
      continue;
    }
    if (bounded.mode === "answer" && bounded.answer.length > 0) {
      const excess = utf8Size(bounded) - maximumBytes;
      bounded = { ...bounded, answer: truncateUtf8(bounded.answer,
        Math.max(new TextEncoder().encode(bounded.answer).byteLength - excess - 16, 0)) };
      continue;
    }
    throw new Error("QUERY_RESPONSE_TOO_LARGE");
  }
  return bounded;
};

export const createOpenApiDocument = (plane: "public" | "delegated") => ({
  openapi: "3.1.0", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: { title: `OPAP ${plane === "public" ? "Public" : "Delegated"} Knowledge API`, version: "0.1.0-alpha.2" },
  paths: {
    "/v1/query": { post: { operationId: "queryKnowledge",
      ...(plane === "delegated" ? { security: [{ bearerAuth: [] }] } : {}),
      requestBody: { required: true, content: { "application/json": { schema: querySchema } } },
      responses: { "200": { description: "Knowledge results", content: {
        "application/json": { schema: responseSchema },
      } }, "400": problemResponse("Invalid request"), "403": problemResponse("Policy denied"),
      "404": problemResponse("Source not found"), "429": problemResponse("Budget limit"),
      "502": problemResponse("Invalid source result"),
      "503": problemResponse("Source or metering unavailable") } } },
    "/v1/capabilities": { get: { operationId: "listCapabilities",
      ...(plane === "delegated" ? { security: [{ bearerAuth: [] }] } : {}),
      responses: { "200": { description: "Capabilities" } } } },
    "/mcp": { post: { operationId: "mcp", ...(plane === "delegated" ? { security: [{ bearerAuth: [] }] } : {}),
      responses: { "200": { description: "Stateless Streamable HTTP MCP response" } } } },
  },
  components: plane === "delegated" ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } } : {},
});

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
const rpc = (id: RpcRequest["id"], result: unknown) => Response.json({ jsonrpc: "2.0", id: id ?? null, result },
  { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
const rpcError = (id: RpcRequest["id"], code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status: 200,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });

const tools = [
  { name: "list_knowledge_sources", description: "List knowledge sources available to the current principal",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "search_knowledge", description: "Search one authorized knowledge source without model generation",
    inputSchema: { ...querySchema, properties: { ...querySchema.properties, mode: { const: "search" } } } },
  { name: "answer_knowledge", description: "Answer from one authorized knowledge source with citations",
    inputSchema: { ...querySchema, properties: { ...querySchema.properties, mode: { const: "answer" } } } },
] as const;

export const handleMcp = async (request: Request, service: KnowledgeApplicationService): Promise<Response> => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return new Response("Content-Type must be application/json", { status: 415 });
  }
  const value: unknown = await request.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return rpcError(null, -32700, "Parse error");
  const call = value as Partial<RpcRequest>;
  if (call.jsonrpc !== "2.0" || typeof call.method !== "string") return rpcError(call.id, -32600, "Invalid Request");
  if (call.method === "initialize") return rpc(call.id, { protocolVersion: "2025-03-26",
    capabilities: { tools: {} }, serverInfo: { name: "opap-knowledge", version: "0.1.0-alpha.2" } });
  if (call.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (call.method === "tools/list") return rpc(call.id, { tools });
  if (call.method !== "tools/call") return rpcError(call.id, -32601, "Method not found");
  const params = typeof call.params === "object" && call.params !== null && !Array.isArray(call.params)
    ? call.params as Record<string, unknown> : {};
  if (params["name"] === "list_knowledge_sources") {
    try {
      return rpc(call.id, { content: [{ type: "text", text: JSON.stringify(await service.listSources()) }] });
    } catch (error) {
      return rpc(call.id, { isError: true, content: [{ type: "text",
        text: error instanceof Error ? error.message : "SOURCE_UNAVAILABLE" }] });
    }
  }
  if (params["name"] !== "search_knowledge" && params["name"] !== "answer_knowledge") {
    return rpcError(call.id, -32602, "Unknown tool");
  }
  const args = typeof params["arguments"] === "object" && params["arguments"] !== null
    ? params["arguments"] as Record<string, unknown> : {};
  const parsed = queryRequestSchema.safeParse({ ...args,
    mode: params["name"] === "search_knowledge" ? "search" : "answer" });
  if (!parsed.success) return rpcError(call.id, -32602, "Invalid tool arguments");
  try {
    const result = boundQueryResponse(await service.query(parsed.data));
    return rpc(call.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  } catch (error) {
    return rpc(call.id, { isError: true, content: [{ type: "text",
      text: error instanceof Error ? error.message : "SOURCE_UNAVAILABLE" }] });
  }
};
