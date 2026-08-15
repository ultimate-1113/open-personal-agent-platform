# Phase 4 knowledge APIs

[日本語](../../ja/operations/phase-4-knowledge.md)

## Public search

The Public Worker reads its source registry from the validated `PUBLIC_SOURCES_JSON` deployment manifest.
It has no Control D1, OAuth Gatekeeper, Conversation, Private R2, or Local Provider binding.

The staging manifest exposes multiple IDs for the same `okidev-web` AI Search instance:

- `source:public-ai-search` uses the Workers instance binding and is the default route.
- `source:public-ai-search-rules` uses the same binding with a lower match threshold for rules queries.
- `source:public-ai-search-endpoint` calls `https://search.wplaceoki.com/search` for compatibility tests only.

Production must omit the endpoint source.
The Worker rejects the public-endpoint transport when `ENVIRONMENT=production`.

Each source configures its retrieval type, candidate count, match threshold, context expansion, answer context size, maximum output tokens, and reasoning effort independently.
OkiDev staging uses vector retrieval, ten candidates, a normal threshold of 0.4, a rules threshold of 0.3, and context expansion of one.
Query rewrite, reranking, and AI Search generation remain disabled, so `search` does not consume the answer-generation budget.

## Delegated search

The owner connects a separate Google Drive or GitHub credential in the Knowledge screen and enters the resource allowlist before OAuth starts.
The owner then publishes a source with its issuer, audience, claim rules, Information Policy, and optional cache policy.

The Delegated API first asks Policy Control to evaluate the JWT claims.
The read-only Gatekeeper validates the credential's resource allowlist again before calling the provider.
Either rejection stops the request.

Delegated caching is off by default.
When enabled, it stores search results for at most 60 seconds and separates entries by issuer digest, principal ID, source ID, source version, query, and result count.

## Answer mode and cost

Public answers and permitted normal delegated data use `@cf/google/gemma-4-26b-a4b-it` through AI Gateway.
The model receives at most five chunks and 32 KiB of source text.
The maximum output is configurable per source from 128 through 4,096 tokens; the default is 1,024 and OkiDev staging uses 4,096.
The quota service reserves the maximum before generation, then settles against the actual answer and releases the unused amount.

Sensitive delegated data and every secret value return `MODEL_DESTINATION_DENIED`.
An AI budget rejection returns `AI_SPEND_LIMIT_REACHED`; it never selects another provider.
Search remains available after that rejection.

All planes reserve AI usage in the same deployment-named Quota Durable Object.
After upgrading an alpha staging deployment, the owner may call `POST /v1/usage/migrate` once to import the legacy `owner` and `public` shards.
Import markers make the operation idempotent.

## OpenAPI, SDK, and MCP

The Public and Delegated Workers serve their OpenAPI 3.1 document at `GET /openapi.json`.
Committed copies live under `openapi/`, and `pnpm openapi:check` rejects stale files.

`@opap/sdk` exports `createPublicClient` and `createDelegatedClient`.
The delegated client requests a fresh bearer token through the supplied callback.

`POST /mcp` implements stateless Streamable HTTP without the legacy SSE transport.
It exposes only `list_knowledge_sources`, `search_knowledge`, and `answer_knowledge`.
Delegated MCP uses the same JWT, ACL, quota, cache, and application service as REST.

## Staging validation

1. Apply Control D1 migration `0006_knowledge_sources.sql`.
2. Deploy Quota, Policy Control, Delegated Source Gatekeeper, Assistant, Public API, and Delegated API in dependency order.
3. Call both AI Search source IDs with the same query and compare the normalized result fields.
4. Call `answer` and verify cited output from Gemma 4 26B.
5. Verify that a second delegated subject cannot reuse the first subject's quota or cache entry.
6. Run the REST, SDK, and MCP examples against the same source.

For a real-credential acceptance test, set `DELEGATED_TEST_JWT` in `.dev.vars` and run:

```powershell
node --experimental-strip-types scripts/test-delegated-staging.ts `
  --source-id source:delegated-drive-test `
  --query "OPAP delegated Drive staging verification" `
  --answer true
```

The script does not print the JWT. It checks REST, the TypeScript SDK, MCP, denial of an unauthorized source, and optional answer generation.

AI Search is an Open Beta dependency.
If its catalog entry becomes stale after pricing changes, OPAP stops only that adapter with `PRICING_CATALOG_STALE`.
