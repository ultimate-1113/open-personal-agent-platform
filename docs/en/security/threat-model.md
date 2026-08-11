# Threat model

[日本語](../../ja/security/threat-model.md)

## Protected assets

- OAuth tokens, API keys, and signing keys
- Owner conversations, memory, mail, events, and documents
- Resource scopes for each delegated principal
- Approval records, audit history, and plugin artifacts

## Primary threats

- A Public Worker binding error that exposes a private resource
- Prompt injection causing privilege escalation or a confused deputy
- Input substitution after approval, lease replay, or duplicate external writes
- Cache, quota, or result mixing across delegated principals
- A malicious plugin accessing secrets, network egress, or excessive resources
- Personal data exposure through logs, exceptions, or telemetry

## Defenses

- Physically separate Workers and bindings.
- Revalidate authorization inside the Gatekeeper at tool execution.
- Bind each execution lease to the request digest, principal, capability, expiration, and nonce.
- Include issuer, subject, and source ID in delegated cache keys.
- Disable plugin sandbox internet access and secret injection.
- Never store body content, prompts, or tokens in audit logs.

## Non-goals

The platform cannot guarantee full protection after the Cloudflare account itself is compromised.
The hash chain assists tamper detection but is not independent external notarization.
