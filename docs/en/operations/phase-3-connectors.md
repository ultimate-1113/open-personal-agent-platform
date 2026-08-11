# Phase 3 connectors

[日本語](../../ja/operations/phase-3-connectors.md)

Phase 3 adds Google, GitHub, and Discord without weakening the worker boundaries established in Phase 2.

## Implementation order

1. Shared OAuth state, S256 PKCE, token rotation, revocation, and credential envelope encryption
2. Google Personal and Delegated Source Gatekeepers with separate credentials
3. GitHub Personal and Delegated Source Gatekeepers with separate GitHub App installations
4. Always-approved Gmail send, Calendar event, GitHub issue, and GitHub comment writes
5. Discord one-time owner linking, conversation replies, and approval notifications
6. Reconciliation UI for external writes with an `unknown` result

The shared OAuth foundation, Google Personal Gatekeeper, and GitHub Personal Gatekeeper are implemented.
Gmail messages are sent only after the owner approves the exact recipient, subject, and body.
Recipient addresses are not restricted by a deployment allowlist.
GitHub reads notifications, repositories, issues, pull requests, and issue or pull-request comments.
Creating an issue or posting a comment runs only after owner approval.
GitHub code changes and pull-request creation are not implemented.
Discord and Delegated Source Gatekeepers remain in progress.

## GitHub App staging configuration

Configure the GitHub App with these values:

- **Callback URL**: `https://opap-assistant-staging.lfantian708.workers.dev/v1/connections/github/callback`
- **Webhook**: disabled initially
- **User authorization callback**: enabled
- **User-to-server token expiration**: recommended

Grant the GitHub App these minimum permissions:

- **Account permissions / Notifications**: Read-only
- **Repository permissions / Contents**: Read-only
- **Repository permissions / Issues**: Read and write
- **Repository permissions / Pull requests**: Read-only
- **Repository permissions / Metadata**: Read-only (automatically granted by GitHub)

Install the App only on required repositories.
A user token can access only the intersection of the user's permissions and the App installation's repository selection.

Unread notifications are fetched on owner request.
v0.1 does not poll continuously because polling consumes Workers requests and GitHub API rate limits.
Automatic webhook ingestion will be enabled only after adding a dedicated public worker for signature verification.

## Security requirements

- A Gatekeeper credential encryption key is a 32-byte Worker Secret and never a plaintext variable.
- OAuth transactions expire after ten minutes, store only a state digest, and are consumed once.
- Authorization Code flows use S256 PKCE and exact HTTPS redirect URIs.
- Provider errors record status and operation only, never response bodies or tokens.
- GitHub Apps request no OAuth scopes; App permissions and installation selection constrain access.
- A refresh rejection marks the connection for reconsent and never falls back to broader credentials.
- Personal and Delegated Source connections use different credentials, scopes, databases, and entrypoints.

Provider registration and real-credential tests run only in a manual staging workflow.
Contributor CI uses fake OAuth and API servers.
