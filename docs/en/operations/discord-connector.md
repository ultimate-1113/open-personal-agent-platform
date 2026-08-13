# Discord Connector

[日本語](../../ja/operations/discord-connector.md)

The Discord Connector uses Cloudflare-hosted HTTP Interactions as its supported path.
Slash commands do not require an always-on machine such as a Mac mini.
Normal bot direct messages are available only when the experimental Gateway Bridge is enabled.

## Worker boundaries

The public Discord Adapter exposes only `POST /interactions`, `POST /gateway-events`, and `GET /health`.
It verifies Discord signatures, bridge signatures, body size, clock skew, and duplicate identifiers.
It has no direct binding to Control D1, Conversation Durable Objects, connectors, AI, or the Bot Token.
The Assistant Worker's `DiscordEntrypoint` resolves the owner and invokes existing application services.
Discord API writes and the Bot Token remain isolated in the private Discord Gatekeeper.

## Developer Portal

Use these settings in the Developer Portal:

- Public Bot: off
- Requires OAuth2 Code Grant: off
- Presence Intent: off
- Server Members Intent: off
- Message Content Intent: on only when using the Gateway Bridge
- Install Link: None
- User Install and Guild Install: enabled
- Interaction Endpoint URL: `https://opap-discord-staging.lfantian708.workers.dev/interactions`

User Install uses the `applications.commands` scope.
Guild Install uses the `applications.commands bot` scopes.
Guild Bot permissions are limited to View Channels, Send Messages, and Embed Links.
The permission integer is `19456`.

## Staging deployment

Deploy in this order:

1. Apply `migrations/control/0004_discord_links.sql` to Control D1.
2. Apply `migrations/discord-gatekeeper/0001_initial.sql` to the Discord Gatekeeper D1 database.
3. Store `DISCORD_BOT_TOKEN` as a Discord Gatekeeper Worker Secret.
4. Deploy the Discord Gatekeeper, Assistant Worker, and Discord Adapter in that order.
5. Save the Interaction Endpoint URL in the Developer Portal.
6. Synchronize Discord commands from the Owner UI.
7. Complete User Install.
8. Generate a link code in the Owner UI and run `/link code:<code>` in a bot DM.

Never paste the Bot Token into chat, tracked configuration files, or plaintext Worker variables.
Copy `.dev.vars.example` to `.dev.vars` and set `DISCORD_BOT_TOKEN` there.
Git ignores `.dev.vars`.
The following command reads the file and registers a Worker Secret without printing its value:

```powershell
pnpm run secret:discord:staging
```

When enabling the Gateway Bridge, also configure its signing key on the Adapter:

Set `DISCORD_BRIDGE_SIGNING_KEY` in `.dev.vars` and run `scripts/register-discord-staging-secrets.ps1 -IncludeBridge`.

## Commands and approvals

`/agent` writes to the same Conversation Durable Object as the Owner UI.
`/tasks`, `/approvals`, and `/audit` use the same application services as the Owner UI.
Guild responses are ephemeral by default.
`/notify-here` requires approval before registering a new Guild Channel destination.
`/notify-off-here` asks for confirmation and then disables only the current Guild Channel destination.
Automatic notifications expose only a Review button, followed by an ephemeral approval or rejection view.
`secret` information is never delivered to a DM, Guild Channel, or log.

## Gateway Bridge

`apps/discord-gateway-bridge` runs on Node.js 24.
It forwards only normal bot direct messages from the linked owner.
It excludes Guild Messages, Group DMs, attachments, and bot messages.
It uses outbound traffic only and requires neither Cloudflare Tunnel nor Workers VPC.
`deployments/macos/com.opap.discord-gateway-bridge.plist` is a launchd example.
This path is not yet verified on real hardware and is not a v0.1 completion requirement.

## Cost and retention

Interaction IDs, Gateway Message IDs, and bridge nonces remain in a SQLite-backed Durable Object for 24 hours.
Interaction Tokens are never persisted.
Conversation content remains only in the existing Conversation Durable Object.
The notification outbox writes to D1 only after a failure and respects Discord's `retry_after` response.
An indeterminate write is recorded as `unknown` and is not retried unconditionally.
