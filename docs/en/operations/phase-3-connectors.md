# Phase 3 connectors

[日本語](../../ja/operations/phase-3-connectors.md)

Phase 3 adds Google, GitHub, and Discord without weakening the worker boundaries established in Phase 2.
See [Google and GitHub provider setup](connector-provider-setup.md) for external-console steps, scope and permission mappings, secrets, and the change checklist.

## Implementation order

1. Shared OAuth state, S256 PKCE, token rotation, revocation, and credential envelope encryption
2. Google Personal and Delegated Source Gatekeepers with separate credentials
3. GitHub Personal and Delegated Source Gatekeepers with separate GitHub App installations
4. Gmail send, Calendar event, GitHub issue, and GitHub comment writes that always require approval
5. Discord one-time owner linking, conversation replies, and approval notifications
6. Reconciliation UI for external writes with an `unknown` result

The shared OAuth foundation, Google Personal Gatekeeper, GitHub Personal Gatekeeper, and the physically separate Delegated Source Gatekeeper are implemented.
Gmail messages are sent only after the owner approves the exact recipient, subject, and body.
Recipient addresses are not restricted by a deployment allowlist.
GitHub reads repositories, code, subscribed issues, pull requests, and issue or pull-request comments.
Creating an issue or posting a comment runs only after owner approval.
GitHub code changes and pull-request creation are not implemented.
Discord HTTP Interactions, owner linking, commands, notification destinations, and the experimental Gateway Bridge are implemented.
See [Discord Connector](discord-connector.md) for deployment instructions.
The Delegated Source Gatekeeper has its own D1 database, OAuth credentials, read-only endpoints, and explicit Drive file/folder or GitHub repository allowlists.
It cannot call Gmail, Calendar, or write capabilities.
Phase 4 connects this internal contract to Source ACL evaluation and the Delegated Knowledge API.
External writes that end in `unknown` can be reconciled by the owner as executed or not executed without automatically retrying the external operation.

## Delegated Source deployment boundary

Deploy `apps/delegated-source-gatekeeper` with its own D1 database and its own `CREDENTIAL_KEK`.
Set `GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_SECRET` as Worker Secrets, not regular variables.
The Google OAuth client and GitHub App installation must be separate from the Personal Gatekeepers.
An OAuth start request must contain at least one Drive file/folder ID or `owner/repository` identifier.
Folder document reads verify the returned Google Drive parent ID before returning at most 1 MiB of supported text content.
Do not bind this Worker to the Assistant Worker or Public Agent API.
Phase 4 binds it only to the Delegated API through a named internal service binding.

## GitHub App staging configuration

Configure the GitHub App with these values:

- **Callback URL**: `https://opap-assistant-staging.lfantian708.workers.dev/v1/connections/github/callback`
- **Webhook**: disabled initially
- **User authorization callback**: enabled
- **User-to-server token expiration**: recommended

Grant the GitHub App these minimum permissions:

- **Repository permissions / Contents**: Read-only
- **Repository permissions / Issues**: Read and write
- **Repository permissions / Pull requests**: Read-only
- **Repository permissions / Metadata**: Read-only (automatically granted by GitHub)

Install the App only on required repositories.
A user token can access only the intersection of the user's permissions and the App installation's repository selection.

The GitHub notifications endpoint is not used because it does not support GitHub App user access tokens.
On owner request, the inbox lists subscribed issues and pull requests by most recent update.
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
- Run `pnpm verify:execution-lease-keys` before deployment to reject mismatched Gatekeeper verification keys.

Provider registration and real-credential tests run only in a manual staging workflow.
Contributor CI uses fake OAuth and API servers.
