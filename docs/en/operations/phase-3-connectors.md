# Phase 3 connectors

[日本語](../../ja/operations/phase-3-connectors.md)

Phase 3 adds Google, GitHub, and Discord without weakening the worker boundaries established in Phase 2.

## Implementation order

1. Shared OAuth state, S256 PKCE, token rotation, revocation, and credential envelope encryption
2. Google Personal and Delegated Source Gatekeepers with separate credentials
3. GitHub Personal and Delegated Source Gatekeepers with separate GitHub App installations
4. Always-approved Gmail draft, Calendar event, GitHub issue, and GitHub comment writes
5. Discord one-time owner linking, conversation replies, and approval notifications
6. Reconciliation UI for external writes with an `unknown` result

The shared OAuth foundation is implemented.
Provider Gatekeepers and their owner-facing connection API remain in progress.

## Security requirements

- A Gatekeeper credential encryption key is a 32-byte Worker Secret and never a plaintext variable.
- OAuth transactions expire after ten minutes, store only a state digest, and are consumed once.
- Authorization Code flows use S256 PKCE and exact HTTPS redirect URIs.
- Provider errors record status and operation only, never response bodies or tokens.
- A refresh rejection marks the connection for reconsent and never falls back to broader credentials.
- Personal and Delegated Source connections use different credentials, scopes, databases, and entrypoints.

Provider registration and real-credential tests run only in a manual staging workflow.
Contributor CI uses fake OAuth and API servers.
