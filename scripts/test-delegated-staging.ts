// Runs the real delegated REST, SDK, MCP, authorization, and optional answer acceptance checks.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDelegatedClient } from "../packages/sdk/src/index.ts";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
const records = (value: unknown): JsonRecord[] => Array.isArray(value)
  ? value.flatMap((item) => record(item) ? [record(item) as JsonRecord] : []) : [];
const problemTitle = (value: JsonRecord | undefined): string =>
  typeof value?.["title"] === "string" ? value["title"] : "unknown";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key && value) args.set(key, value);
}

const baseUrl = args.get("--base-url") ?? "https://opap-delegated-staging.lfantian708.workers.dev";
const sourceId = args.get("--source-id") ?? "source:delegated-github-test";
const query = args.get("--query") ?? "README";
const includeAnswer = args.get("--answer") === "true";

const variables = new Map<string, string>();
for (const line of (await readFile(resolve(".dev.vars"), "utf8")).split(/\r?\n/u)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/u.exec(line);
  const key = match?.[1];
  const value = match?.[2];
  if (key && value !== undefined) variables.set(key, value.replace(/^(["'])(.*)\1$/u, "$2"));
}
const token = variables.get("DELEGATED_TEST_JWT");
if (!token) throw new Error("DELEGATED_TEST_JWT is not configured in .dev.vars");

const post = async (path: string, body: unknown): Promise<{ status: number; value: unknown }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  return { status: response.status, value };
};

const search = await post("/v1/query", { sourceId, query, mode: "search", maxSources: 5 });
const searchBody = record(search.value);
const searchResults = records(searchBody?.["results"]);
if (search.status !== 200 || searchBody?.["mode"] !== "search" || searchResults.length < 1) {
  throw new Error(`Delegated REST search failed or returned no results (status ${search.status}, code ${problemTitle(searchBody)})`);
}

const sdkResult = await createDelegatedClient({
  baseUrl,
  getAccessToken: () => Promise.resolve(token),
}).query({ sourceId, query, mode: "search", maxSources: 5 });
if (sdkResult.mode !== "search" || sdkResult.results.length < 1) {
  throw new Error("Delegated TypeScript SDK search returned no results");
}

const mcp = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
  name: "search_knowledge", arguments: { sourceId, query, maxSources: 5 },
} });
const mcpBody = record(mcp.value);
const mcpResult = record(mcpBody?.["result"]);
const mcpStructuredContent = record(mcpResult?.["structuredContent"]);
const mcpResults = records(mcpStructuredContent?.["results"]);
if (mcp.status !== 200 || mcpResults.length < 1) {
  throw new Error(`Delegated MCP search failed or returned no results (status ${mcp.status})`);
}

const denied = await post("/v1/query", {
  sourceId: "source:not-authorized", query, mode: "search", maxSources: 5,
});
const deniedBody = record(denied.value);
if (denied.status !== 403 || deniedBody?.["title"] !== "DELEGATED_ACL_DENIED") {
  throw new Error(`Unknown or unauthorized source was not denied (status ${denied.status})`);
}

let answerSummary: { status: string; providerId: unknown; citations: number; answerLength: number } | undefined;
if (includeAnswer) {
  const answer = await post("/v1/query", { sourceId, query, mode: "answer", maxSources: 5 });
  const answerBody = record(answer.value);
  const answerText = answerBody?.["answer"];
  const citations = records(answerBody?.["citations"]);
  if (answer.status !== 200 || answerBody?.["mode"] !== "answer" ||
    typeof answerText !== "string" || answerText.length === 0 || citations.length < 1) {
    throw new Error(`Delegated answer failed (status ${answer.status}, code ${problemTitle(answerBody)})`);
  }
  const model = record(answerBody["model"]);
  answerSummary = {
    status: "ok",
    providerId: model?.["providerId"],
    citations: citations.length,
    answerLength: answerText.length,
  };
}

console.log(JSON.stringify({
  sourceId,
  rest: { status: "ok", results: searchResults.length, firstUri: searchResults[0]?.["uri"] },
  sdk: { status: "ok", results: sdkResult.results.length },
  mcp: { status: "ok", results: mcpResults.length },
  unauthorizedSource: "denied",
  ...(answerSummary ? { answer: answerSummary } : {}),
}, null, 2));
