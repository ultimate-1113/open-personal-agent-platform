import { queryResponseSchema, type QueryRequest, type QueryResponse } from "@opap/contracts";

export class OpapApiError extends Error {
  constructor(readonly status: number, readonly problem: { title: string; requestId?: string }) {
    super(problem.title); this.name = "OpapApiError";
  }
}

type Client = {
  query(input: QueryRequest, options?: { signal?: AbortSignal }): Promise<QueryResponse>;
  capabilities(options?: { signal?: AbortSignal }): Promise<unknown>;
};
type ClientOptions = { baseUrl: string; getAccessToken?: () => Promise<string> };

const createClient = ({ baseUrl, getAccessToken }: ClientOptions): Client => {
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const authorization = getAccessToken ? `Bearer ${await getAccessToken()}` : undefined;
    const response = await fetch(new URL(path, baseUrl), { ...init, headers: {
      Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(authorization ? { Authorization: authorization } : {}), ...init.headers,
    } });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const row = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
      throw new OpapApiError(response.status, { title: typeof row["title"] === "string"
        ? row["title"] : `HTTP_${response.status}`,
        ...(typeof row["requestId"] === "string" ? { requestId: row["requestId"] } : {}) });
    }
    return value;
  };
  return {
    async query(input, options) {
      return queryResponseSchema.parse(await request("/v1/query", { method: "POST",
        body: JSON.stringify(input), ...(options?.signal ? { signal: options.signal } : {}) }));
    },
    capabilities: (options) => request("/v1/capabilities",
      options?.signal ? { signal: options.signal } : {}),
  };
};

export const createPublicClient = (options: { baseUrl: string }): Client => createClient(options);
export const createDelegatedClient = (options: {
  baseUrl: string; getAccessToken: () => Promise<string>;
}): Client => createClient(options);

export type { QueryRequest, QueryResponse } from "@opap/contracts";
export type { paths as PublicApiPaths } from "./generated/public.js";
export type { paths as DelegatedApiPaths } from "./generated/delegated.js";
