# Phase 5 beta operations

Dependencies were refreshed on 2026-08-20. TypeScript 7 is not used because the current stable `typescript-eslint` declares support below TypeScript 6.1; the workspace therefore pins the newest supported TypeScript 5.x release. `@types/node` follows the supported Node.js 24 LTS runtime rather than the unrelated newest Node major.

## Stability boundaries

`cloud-base` is the supported beta profile. It includes the private owner plane, connectors, Knowledge API, MCP, Private R2 maintenance, export, retention, and Static Plugins.

`cloud-base-dynamic`, the Sandbox runtime, and the Docker Discord Gateway Bridge are experimental. Disabling them does not disable Web Chat, connectors, Knowledge API, SDK, or MCP.

## Deployment

Run `pnpm opap setup --target production` for the normal deployment or `pnpm opap setup --target test` for the isolated test deployment to print the read-only preflight and deployment order.
A named target is the sole source of truth for the deployment name, environment, profile, and every resource name; command-line and environment overrides are rejected.
With `--apply`, the CLI reuses or creates the required D1 databases and private R2 bucket, writes resolved bindings only to ignored `.opap.wrangler.jsonc` files, records a Time Travel bookmark and SQL export for existing databases, applies migrations, registers available secrets, deploys in dependency order, and checks deployment status.
The CLI loads ignored root `.env` and `.dev.vars` files. Use `OPAP_ENVIRONMENT` to select an isolated resource suffix and `OPAP_DEPLOYMENT_ID` to retain the deployment identity across updates.
Set `OPAP_ASSISTANT_URL`, `OPAP_PUBLIC_URL`, or `OPAP_DISCORD_URL` to include HTTP health checks.
The generated configuration and backups remain under ignored local paths and do not change Access applications, team domains, Tunnels, or policies.

The setup tool does not modify an existing Cloudflare Access team domain, Tunnel, Access application, or Access policy. If the account token cannot create an Access application, configure it in the dashboard with the values printed by the setup flow.

Generate one high-entropy `PLUGIN_INVOCATION_SIGNING_KEY` and register the same value as a Worker secret on the Assistant Worker and Plugin Runtime Worker. Do not place it in `wrangler.jsonc`. `.dev.vars.example` lists local secret names without values.

## Export, deletion, and retention

Owner exports use `opap-export/v1`, with a JSON manifest and NDJSON data. OAuth tokens, Worker secrets, Platform Token hashes, Execution Lease secrets, Connector source bodies, and `secret` message content are excluded.

Conversation deletion removes the Durable Object state and marks its registry entry deleted. Audit events remain as digests and outcomes. Alpha conversations that are never accessed again cannot be discovered by namespace enumeration and are therefore covered by best-effort cleanup only.

The Audit Ledger closes daily segments and saves their checkpoint to Private R2. Retention cannot delete a closed segment until its checkpoint exists. Exports and inspection artifacts expire after 24 hours; Plugin execution metadata expires after 7 days.

## Plugins

Static Plugins are validated during the build. Duplicate Plugin IDs, Tool IDs, and missing schemas fail validation.

Dynamic Plugin uploads accept a single `.tgz` containing `plugin.json`, one ESM bundle, and a CycloneDX 1.5 or 1.6 SBOM. The inspector rejects traversal, links, special files, native addons, install scripts, oversized archives, and digest mismatches.

Dynamic Plugins run in a `lite` Sandbox with no general internet access or direct secrets. A short-lived scoped invocation token is required. Capability calls are routed through the private broker; write operations retain the existing owner approval and Execution Lease controls.

## Docker Gateway Bridge

Copy `deployments/local/.env.example` to `.env`, set the four Discord values, then run:

```bash
docker compose --profile discord-bridge up -d --build
```

Run the command from `deployments/local`. Docker Desktop is used on Windows and macOS; Docker Engine is used on Linux. The image supports `linux/amd64` and `linux/arm64`.

Ollama is not part of this container. A future Local AI Router will treat Ollama as an external endpoint, using `host.docker.internal` for the host or an owner-approved private network URL.
