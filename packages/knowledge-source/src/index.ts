import { z } from "zod";
import {
  informationPolicySchema,
  type InformationPolicy,
  type KnowledgeRetrievalPolicy,
  type KnowledgeSourceKind,
  type SearchResult,
} from "@opap/contracts";
import { sha256Hex } from "@opap/security";

export const MAX_EXCERPT_BYTES = 2_048;
export const MAX_SOURCE_RESPONSE_BYTES = 1_048_576;
export const MAX_STATIC_DOCUMENTS = 1_000;

export type KnowledgeSourceSearchInput = {
  sourceId: string;
  query: string;
  maxResults: number;
  authorizedResourceIds: readonly string[];
  principalId?: string;
  informationPolicy: InformationPolicy;
};

export const DEFAULT_KNOWLEDGE_RETRIEVAL_POLICY: KnowledgeRetrievalPolicy = {
  retrievalType: "keyword",
  candidateResults: 10,
  matchThreshold: 0.4,
  contextExpansion: 0,
  answerContextCharacters: 4_000,
  answerMaxOutputTokens: 1_024,
  answerReasoningEffort: "low",
};

export type KnowledgeChunk = {
  sourceId: string;
  resourceId: string;
  title: string;
  uri: string;
  excerpt: string;
  content?: string;
  contentDigest: string;
  observedAt: string;
  informationPolicy: InformationPolicy;
};

export interface KnowledgeSource {
  readonly kind: KnowledgeSourceKind;
  search(input: KnowledgeSourceSearchInput): Promise<readonly KnowledgeChunk[]>;
}

export class KnowledgeSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KnowledgeSourceError";
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const isPrivateHostname = (hostname: string): boolean => {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") ||
    value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:")) return true;
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 ||
    octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31;
};

const validatePublicHttpsUrl = (value: string, label: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new KnowledgeSourceError("SOURCE_CONFIGURATION_INVALID", `${label} must be a public HTTPS URL`);
  }
  return url;
};

export const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (byteLength(value) <= maximumBytes) return value;
  const bytes = new TextEncoder().encode(value).slice(0, maximumBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\uFFFD$/u, "");
};

export const toSearchResult = (chunk: KnowledgeChunk): SearchResult => ({
  sourceId: chunk.sourceId,
  resourceId: chunk.resourceId,
  title: chunk.title,
  uri: chunk.uri,
  observedAt: chunk.observedAt,
  excerpt: truncateUtf8(chunk.excerpt, MAX_EXCERPT_BYTES),
  observationId: `observation:${chunk.contentDigest}`,
});

const staticDocumentSchema = z.object({
  id: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  uri: z.string().url(),
  text: z.string().max(MAX_SOURCE_RESPONSE_BYTES),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export const staticSiteIndexSchema = z.object({
  apiVersion: z.literal("opap.dev/static-index/v1"),
  revision: z.string().min(1).max(200),
  generatedAt: z.iso.datetime({ offset: true }),
  documents: z.array(staticDocumentSchema).max(MAX_STATIC_DOCUMENTS),
});

export type StaticSiteIndex = z.infer<typeof staticSiteIndexSchema>;

const terms = (query: string): string[] => query.normalize("NFKC").toLocaleLowerCase()
  .split(/[\s\p{P}\p{S}]+/u).filter(Boolean).slice(0, 32);

const rankDocument = (queryTerms: readonly string[], title: string, text: string): number => {
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase();
  const normalizedText = text.normalize("NFKC").toLocaleLowerCase();
  return queryTerms.reduce((score, term) =>
    score + (normalizedTitle.includes(term) ? 10 : 0) + (normalizedText.includes(term) ? 1 : 0), 0);
};

const excerptAroundMatch = (text: string, queryTerms: readonly string[]): string => {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const positions = queryTerms.map((term) => normalized.indexOf(term)).filter((position) => position >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 240);
  return truncateUtf8(text.slice(start, start + 2_500).trim(), MAX_EXCERPT_BYTES);
};

export class FixtureKnowledgeSource implements KnowledgeSource {
  readonly kind = "fixture" as const;

  async search(input: KnowledgeSourceSearchInput): Promise<readonly KnowledgeChunk[]> {
    const content = `Fixture result for: ${input.query}`;
    const digest = await sha256Hex(content);
    return [{
      sourceId: input.sourceId,
      resourceId: "document:getting-started",
      title: "Getting started",
      uri: "https://example.invalid/docs/getting-started",
      excerpt: content,
      content,
      contentDigest: digest,
      observedAt: new Date().toISOString(),
      informationPolicy: input.informationPolicy,
    }];
  }
}

export type StaticSiteKnowledgeSourceOptions = {
  indexUrl: string;
  fetcher?: typeof fetch;
};

export class StaticSiteKnowledgeSource implements KnowledgeSource {
  readonly kind = "static-site" as const;
  readonly #url: URL;
  readonly #fetcher: typeof fetch;

  constructor(options: StaticSiteKnowledgeSourceOptions) {
    this.#url = validatePublicHttpsUrl(options.indexUrl, "Static index URL");
    this.#fetcher = options.fetcher ?? fetch;
  }

  async search(input: KnowledgeSourceSearchInput): Promise<readonly KnowledgeChunk[]> {
    let response: Response;
    try {
      response = await this.#fetcher(this.#url, { redirect: "manual", headers: { Accept: "application/json" } });
    } catch {
      throw new KnowledgeSourceError("SOURCE_UNAVAILABLE", "Static index request failed");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new KnowledgeSourceError("SOURCE_SCOPE_DENIED", "Static index redirects are not allowed");
    }
    if (!response.ok) throw new KnowledgeSourceError("SOURCE_UNAVAILABLE", "Static index is unavailable");
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_SOURCE_RESPONSE_BYTES) {
      throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "Static index exceeds 1 MiB");
    }
    const text = await response.text();
    if (byteLength(text) > MAX_SOURCE_RESPONSE_BYTES) {
      throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "Static index exceeds 1 MiB");
    }
    let value: unknown;
    try { value = JSON.parse(text) as unknown; }
    catch { throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "Static index JSON is invalid"); }
    const parsed = staticSiteIndexSchema.safeParse(value);
    if (!parsed.success) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "Static index schema is invalid");
    const queryTerms = terms(input.query);
    const ranked = parsed.data.documents.map((document) => ({
      document,
      score: rankDocument(queryTerms, document.title, document.text),
    })).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score)
      .slice(0, input.maxResults);
    return Promise.all(ranked.map(async ({ document }) => ({
      sourceId: input.sourceId,
      resourceId: document.id,
      title: document.title,
      uri: document.uri,
      excerpt: excerptAroundMatch(document.text, queryTerms),
      content: truncateUtf8(document.text, 32_768),
      contentDigest: await sha256Hex(document.text),
      observedAt: document.updatedAt ?? parsed.data.generatedAt,
      informationPolicy: input.informationPolicy,
    })));
  }
}

export type AiSearchInstanceBinding = {
  search(input: {
    messages: readonly { role: "user"; content: string }[];
    ai_search_options: { retrieval: {
      retrieval_type: "keyword" | "vector" | "hybrid";
      max_num_results: number;
      match_threshold: number;
      context_expansion: number;
    }; query_rewrite: { enabled: boolean }; reranking: { enabled: boolean } };
  }): Promise<unknown>;
};

export type AiSearchTransport =
  | { kind: "workers-binding"; binding: AiSearchInstanceBinding }
  | { kind: "public-endpoint"; endpoint: string; fetcher?: typeof fetch };

const aiSearchChunkSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  url: z.string().url().optional(),
  uri: z.string().url().optional(),
  text: z.string().optional(),
  content: z.string().optional(),
  filename: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  item: z.object({
    key: z.string().url(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
}).passthrough();

const extractAiSearchChunks = (value: unknown): z.infer<typeof aiSearchChunkSchema>[] => {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const candidates = Array.isArray(value) ? value
    : Array.isArray(record?.["chunks"]) ? record["chunks"]
    : Array.isArray(record?.["data"]) ? record["data"]
    : typeof record?.["result"] === "object" && record["result"] !== null &&
      Array.isArray((record["result"] as Record<string, unknown>)["chunks"])
      ? (record["result"] as Record<string, unknown>)["chunks"] : undefined;
  if (!candidates) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "AI Search response has no chunks");
  const parsed = z.array(aiSearchChunkSchema).safeParse(candidates);
  if (!parsed.success) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "AI Search chunks are invalid");
  return parsed.data;
};

export class AISearchKnowledgeSource implements KnowledgeSource {
  readonly kind = "ai-search" as const;
  readonly #transport: AiSearchTransport;
  readonly #retrievalPolicy: KnowledgeRetrievalPolicy;

  constructor(transport: AiSearchTransport, retrievalPolicy: KnowledgeRetrievalPolicy =
    DEFAULT_KNOWLEDGE_RETRIEVAL_POLICY) {
    if (transport.kind === "public-endpoint") {
      validatePublicHttpsUrl(transport.endpoint, "AI Search endpoint");
    }
    this.#transport = transport;
    this.#retrievalPolicy = retrievalPolicy;
  }

  async search(input: KnowledgeSourceSearchInput): Promise<readonly KnowledgeChunk[]> {
    const request = {
      messages: [{ role: "user" as const, content: input.query }],
      ai_search_options: { retrieval: {
        retrieval_type: this.#retrievalPolicy.retrievalType,
        max_num_results: Math.min(Math.max(input.maxResults,
          this.#retrievalPolicy.candidateResults), 50),
        match_threshold: this.#retrievalPolicy.matchThreshold,
        context_expansion: this.#retrievalPolicy.contextExpansion,
      }, query_rewrite: { enabled: false }, reranking: { enabled: false } },
    };
    let raw: unknown;
    try {
      if (this.#transport.kind === "workers-binding") {
        raw = await this.#transport.binding.search(request);
      } else {
        const response = await (this.#transport.fetcher ?? fetch)(this.#transport.endpoint, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength > MAX_SOURCE_RESPONSE_BYTES) {
          throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "AI Search response exceeds 1 MiB");
        }
        const text = await response.text();
        if (byteLength(text) > MAX_SOURCE_RESPONSE_BYTES) {
          throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "AI Search response exceeds 1 MiB");
        }
        try { raw = JSON.parse(text) as unknown; }
        catch { throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "AI Search JSON is invalid"); }
      }
    } catch (error) {
      if (error instanceof KnowledgeSourceError) throw error;
      throw new KnowledgeSourceError("SOURCE_UNAVAILABLE", "AI Search request failed");
    }
    const chunks = extractAiSearchChunks(raw).slice(0, input.maxResults);
    return Promise.all(chunks.map(async (chunk, index) => {
      const metadata = { ...(chunk.item?.metadata ?? {}), ...(chunk.metadata ?? {}) };
      const content = chunk.text ?? chunk.content ?? "";
      const uri = chunk.url ?? chunk.uri ?? chunk.item?.key ??
        (typeof metadata["url"] === "string" ? metadata["url"] : undefined);
      if (!uri) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "AI Search chunk has no URL");
      const rawResourceId = chunk.id ?? metadata["id"];
      const resourceId = typeof rawResourceId === "string" || typeof rawResourceId === "number"
        ? String(rawResourceId) : uri;
      const digest = await sha256Hex(content || resourceId);
      const timestamp = chunk.timestamp ?? chunk.item?.timestamp;
      const observedAt = typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))
        ? new Date(timestamp).toISOString()
        : typeof timestamp === "number" ? new Date(timestamp).toISOString()
        : new Date().toISOString();
      return {
        sourceId: input.sourceId,
        resourceId,
        title: chunk.title ?? chunk.filename ?? (chunk.item?.key ? new URL(chunk.item.key).pathname.split("/").at(-1) : undefined) ??
          (typeof metadata["title"] === "string" ? metadata["title"] : `Result ${index + 1}`),
        uri,
        excerpt: truncateUtf8(content, MAX_EXCERPT_BYTES),
        content: truncateUtf8(content, 32_768),
        contentDigest: digest,
        observedAt,
        informationPolicy: input.informationPolicy,
      };
    }));
  }
}

export type DelegatedSourceReadRequest = {
  connectionId: string;
  resourceId: string;
  operation: string;
  query?: string;
  maxResults?: number;
  path?: string;
};

export interface DelegatedSourceReader {
  read(request: DelegatedSourceReadRequest): Promise<unknown>;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const arrayRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.flatMap((item) => {
    const record = recordValue(item);
    return record ? [record] : [];
  }) : [];
const matchesQuery = (query: string, ...values: unknown[]): boolean => {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  return values.some((value) => typeof value === "string" &&
    value.normalize("NFKC").toLocaleLowerCase().includes(normalized));
};

export class GoogleDriveKnowledgeSource implements KnowledgeSource {
  readonly kind = "google-drive" as const;
  constructor(readonly connectionId: string, readonly reader: DelegatedSourceReader) {}

  async search(input: KnowledgeSourceSearchInput): Promise<readonly KnowledgeChunk[]> {
    const chunks: KnowledgeChunk[] = [];
    for (const resourceId of input.authorizedResourceIds.slice(0, 5)) {
      const metadata = recordValue(await this.reader.read({
        connectionId: this.connectionId, resourceId, operation: "file.get",
      }));
      if (!metadata) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "Drive metadata is invalid");
      if (metadata["mimeType"] === "application/vnd.google-apps.folder") {
        const listed = recordValue(await this.reader.read({ connectionId: this.connectionId,
          resourceId, operation: "folder.search", query: input.query,
          maxResults: input.maxResults - chunks.length }));
        for (const file of arrayRecords(listed?.["files"])) {
          if (chunks.length >= input.maxResults) break;
          const id = typeof file["id"] === "string" ? file["id"] : undefined;
          const title = typeof file["name"] === "string" ? file["name"] : undefined;
          const uri = typeof file["webViewLink"] === "string" ? file["webViewLink"] : undefined;
          if (!id || !title || !uri) continue;
          const excerpt = typeof file["description"] === "string" ? file["description"] : title;
          chunks.push({ sourceId: input.sourceId, resourceId: id, title, uri,
            excerpt: truncateUtf8(excerpt, MAX_EXCERPT_BYTES), contentDigest: await sha256Hex(excerpt),
            observedAt: typeof file["modifiedTime"] === "string" && Number.isFinite(Date.parse(file["modifiedTime"]))
              ? new Date(file["modifiedTime"]).toISOString() : new Date().toISOString(),
            informationPolicy: input.informationPolicy });
        }
      } else {
        const value = recordValue(await this.reader.read({ connectionId: this.connectionId,
          resourceId, operation: "file.content" }));
        if (!value) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "Drive content is invalid");
        if (!matchesQuery(input.query, value["title"], value["content"])) continue;
        const title = typeof value["title"] === "string" ? value["title"] : resourceId;
        const content = typeof value["content"] === "string" ? value["content"] : "";
        const uri = typeof value["uri"] === "string" ? value["uri"] : `https://drive.google.com/open?id=${encodeURIComponent(resourceId)}`;
        chunks.push({ sourceId: input.sourceId, resourceId, title, uri,
          excerpt: excerptAroundMatch(content, terms(input.query)), content: truncateUtf8(content, 32_768),
          contentDigest: await sha256Hex(content || resourceId),
          observedAt: typeof value["modifiedTime"] === "string" && Number.isFinite(Date.parse(value["modifiedTime"]))
            ? new Date(value["modifiedTime"]).toISOString() : new Date().toISOString(),
          informationPolicy: input.informationPolicy });
      }
      if (chunks.length >= input.maxResults) break;
    }
    return chunks.slice(0, input.maxResults);
  }
}

export class GitHubKnowledgeSource implements KnowledgeSource {
  readonly kind = "github" as const;
  constructor(readonly connectionId: string, readonly reader: DelegatedSourceReader) {}

  async search(input: KnowledgeSourceSearchInput): Promise<readonly KnowledgeChunk[]> {
    const chunks: KnowledgeChunk[] = [];
    for (const repository of input.authorizedResourceIds.slice(0, 5)) {
      const value = recordValue(await this.reader.read({ connectionId: this.connectionId,
        resourceId: repository, operation: "repository.search", query: input.query,
        maxResults: input.maxResults - chunks.length }));
      if (!value) throw new KnowledgeSourceError("SOURCE_RESULT_INVALID", "GitHub search result is invalid");
      const code = recordValue(value["code"]);
      for (const item of arrayRecords(code?.["items"])) {
        if (chunks.length >= input.maxResults) break;
        const path = typeof item["path"] === "string" ? item["path"] : undefined;
        const uri = typeof item["html_url"] === "string" ? item["html_url"] : undefined;
        if (!path || !uri) continue;
        const fragments = arrayRecords(item["text_matches"]).map((match) =>
          typeof match["fragment"] === "string" ? match["fragment"] : "").filter(Boolean).join("\n");
        const excerpt = fragments || path;
        chunks.push({ sourceId: input.sourceId, resourceId: `${repository}:${path}`,
          title: `${repository}/${path}`, uri, excerpt: truncateUtf8(excerpt, MAX_EXCERPT_BYTES),
          ...(fragments ? { content: fragments } : {}), contentDigest: await sha256Hex(excerpt),
          observedAt: new Date().toISOString(), informationPolicy: input.informationPolicy });
      }
      const issues = recordValue(value["issues"]);
      for (const item of arrayRecords(issues?.["items"])) {
        if (chunks.length >= input.maxResults) break;
        const number = typeof item["number"] === "number" ? item["number"] : undefined;
        const title = typeof item["title"] === "string" ? item["title"] : undefined;
        const uri = typeof item["html_url"] === "string" ? item["html_url"] : undefined;
        if (number === undefined || !title || !uri) continue;
        const content = typeof item["body"] === "string" ? item["body"] : title;
        chunks.push({ sourceId: input.sourceId, resourceId: `${repository}#${number}`,
          title, uri, excerpt: truncateUtf8(content, MAX_EXCERPT_BYTES),
          content: truncateUtf8(content, 32_768), contentDigest: await sha256Hex(content),
          observedAt: typeof item["updated_at"] === "string" && Number.isFinite(Date.parse(item["updated_at"]))
            ? new Date(item["updated_at"]).toISOString() : new Date().toISOString(),
          informationPolicy: input.informationPolicy });
      }
      if (chunks.length >= input.maxResults) break;
    }
    return chunks.slice(0, input.maxResults);
  }
}

export const parseInformationPolicy = (value: unknown): InformationPolicy => {
  const parsed = informationPolicySchema.safeParse(value);
  if (!parsed.success) throw new KnowledgeSourceError("SOURCE_CONFIGURATION_INVALID", "Information policy is invalid");
  return parsed.data;
};
