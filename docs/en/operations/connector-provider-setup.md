# Google and GitHub provider setup

[日本語](../../ja/operations/connector-provider-setup.md)

This document defines the external-console configuration required to run the Google Personal Connector and GitHub Personal Connector.
The settings match the implementation and official specifications verified on August 11, 2026.
Replace `<ASSISTANT_ORIGIN>` with the origin of the Assistant Worker that serves the owner UI.
Use separate OAuth clients, GitHub Apps, credentials, and callback URLs for staging and production.

## Shared requirements

Gatekeeper Workers have no public URL and are called from the Assistant Worker through Service Bindings.
Only the Assistant Worker receives OAuth callbacks and passes verified authorization codes to a Gatekeeper.
Callback URLs must match exactly, including their path.

| Setting | Storage | Secret | Purpose |
| --- | --- | --- | --- |
| Provider client ID | Regular Gatekeeper variable | No | Public OAuth client identifier |
| Provider client secret | Gatekeeper Worker Secret | Yes | Authorization-code and token exchange |
| `CREDENTIAL_KEK` | Gatekeeper Worker Secret | Yes | 32-byte key-encryption key that wraps OAuth tokens |
| `CREDENTIAL_KEY_ID` | Regular Gatekeeper variable | No | Token-encryption key version identifier |
| `EXECUTION_LEASE_PUBLIC_JWK` | Regular Gatekeeper variable | No | Verification of execution leases signed by Policy Control |

Never store `CREDENTIAL_KEK` or a provider client secret in the repository, a version-controlled `.dev.vars`, or a plaintext variable.
`EXECUTION_LEASE_PUBLIC_JWK` must correspond to the signing private key used by the Policy Control Worker.

## Google Cloud setup

### 1. Prepare the project and APIs

A separate Google Cloud project for each environment is recommended.
Enable these APIs under APIs & Services in Google Cloud Console:

- Gmail API
- Google Calendar API
- Google Drive API

### 2. Configure OAuth consent

Configure Branding, Audience, and Data Access in Google Auth Platform.
Choose `Internal` only when every account belongs to the same Google Workspace organization.
Choose `External` for personal Google Accounts or users outside that organization, and add the owner's Google Account as a test user while the app is in Testing.
External Testing authorizations expire after seven days, so review the publishing status and Google's verification requirements before long-term operation.

Register these scopes under Data Access:

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.owned
https://www.googleapis.com/auth/drive.readonly
```

Gmail `gmail.readonly` and `gmail.compose`, and Drive `drive.readonly`, are restricted scopes.
Public operation or server-side storage or transmission of Google user data may require OAuth app verification and an additional security assessment.

### 3. Create the OAuth client

Choose `Web application` as the application type.
Register this authorized redirect URI:

```text
<ASSISTANT_ORIGIN>/v1/connections/google/callback
```

Authorized JavaScript origins are unnecessary because the current implementation does not call Google APIs directly from the browser.
The redirect URI scheme, host, path, and trailing-slash behavior must exactly match the callback.

### 4. Configure the Workers

Set the client ID as the regular `GOOGLE_CLIENT_ID` variable on the Google Gatekeeper.
Store the client secret and key-encryption key as secrets:

```sh
wrangler secret put GOOGLE_CLIENT_SECRET --config <google-gatekeeper-config>
wrangler secret put CREDENTIAL_KEK --config <google-gatekeeper-config>
```

Deploy the Gatekeeper and Assistant Worker, then connect Google from the owner UI.
Disconnect and reauthorize the connection after changing scopes.

### Google capabilities and scopes

| Capability | Google API operation | Required scope | Approval before execution |
| --- | --- | --- | --- |
| Identify owner | OpenID Connect and UserInfo email | `openid`, `userinfo.email` | No |
| Search or list Gmail | `users.messages.list` | `gmail.readonly` | Only before cloud transfer |
| Read a Gmail message | `users.messages.get` | `gmail.readonly` | Only before cloud transfer |
| Create a Gmail draft | `users.drafts.create` | `gmail.compose` | Always |
| Send Gmail | `users.messages.send` | `gmail.compose` | Always |
| List Calendar events | `events.list` | `calendar.readonly` | Only before cloud transfer |
| Create a Calendar event | `events.insert` | `calendar.events.owned` | Always |
| Search or list Drive files | `files.list` | `drive.readonly` | Only before cloud transfer |

Read results sent only to a local provider require no external-write approval.
Sending read results to Workers AI requires approval for that transfer or the owner's automatic read-approval setting.
Information classified as `secret` is never sent to a model, regardless of approval.

The current Drive implementation uses `files.list` and returns metadata only.
`drive.metadata.readonly` may be sufficient for the current operation, but the connector requests `drive.readonly` because Drive content retrieval is planned.
Consider narrowing the scope in releases that do not implement Drive content retrieval.

## GitHub App setup

### 1. Create the GitHub App

Create a GitHub App from Developer settings on the owner's account or an organization the owner administers.
Choose a globally unique GitHub App name.
Set Homepage URL to the public repository or project URL.
Register this callback URL:

```text
<ASSISTANT_ORIGIN>/v1/connections/github/callback
```

Disable `Request user authorization (OAuth) during installation`, and start authorization from the owner UI so it creates the required state and PKCE transaction.
Keep `Expire user authorization tokens` enabled.
The current implementation does not use Device Flow, a Setup URL, or webhooks.
Disable webhook `Active`, and leave the webhook URL and secret unset.

### 2. Configure repository permissions

Grant these repository permissions:

- Contents: Read-only
- Issues: Read and write
- Pull requests: Read-only
- Metadata: Read-only, which GitHub grants automatically

No account, organization, or enterprise permissions are required.
Install the App only on the repositories the agent must use.
Effective access is the intersection of the owner's permissions, GitHub App permissions, and repositories selected for the installation.

### 3. Configure OAuth credentials

Set the GitHub App client ID as the regular `GITHUB_CLIENT_ID` variable on the GitHub Gatekeeper.
Generate a client secret and store the secrets as follows:

```sh
wrangler secret put GITHUB_CLIENT_SECRET --config <github-gatekeeper-config>
wrangler secret put CREDENTIAL_KEK --config <github-gatekeeper-config>
```

The current user-access-token implementation does not use the GitHub App ID or a private key.
Deploy the Gatekeeper and Assistant Worker, then connect GitHub from the owner UI.

### GitHub capabilities and permissions

| Capability | GitHub API operation | Required permission | Approval before execution |
| --- | --- | --- | --- |
| Identify owner | `GET /user` | User authorization | No |
| List repositories | `GET /user/repos` | Metadata: Read | Only before cloud transfer |
| Search code | `GET /search/code` | Contents: Read | Only before cloud transfer |
| Search issues or read inbox | `GET /search/issues`, `GET /issues` | Issues: Read | Only before cloud transfer |
| List pull requests | `GET /repos/{owner}/{repo}/pulls` | Pull requests: Read | Only before cloud transfer |
| Read issue or pull-request comments | `GET /repos/{owner}/{repo}/issues/{number}/comments` | Issues: Read | Only before cloud transfer |
| Create an issue | `POST /repos/{owner}/{repo}/issues` | Issues: Write | Always |
| Post an issue or pull-request comment | `POST /repos/{owner}/{repo}/issues/{number}/comments` | Issues: Write | Always |

GitHub App OAuth requests intentionally leave `scope` empty.
App permissions and installation selection constrain the user access token instead of OAuth scopes.
An organization that enforces SAML SSO may require the owner to establish an active SAML session before reconnecting.

## Change checklist

When the callback host changes, update the Google OAuth client, GitHub App, Cloudflare Access application, and Worker configuration together.
Verify connections on the new callback before removing the old callback.

Treat the following items as one change whenever a connector capability is added or removed:

1. Gatekeeper scopes or GitHub App permissions
2. Provider-console configuration
3. Capability definition and approval class
4. Contract tests against fake servers
5. The capability mapping in this document
6. Reauthorization or installation-permission approval for existing connections

When adding a Google scope, update Data Access and the consent screen, then require existing connections to reauthorize.
Increasing GitHub App permissions requires additional approval by each existing installation owner.
Do not advertise the new capability as available until that approval completes.

When rotating a client secret, deploy the new secret and verify it before revoking the old secret.
When rotating an OAuth token encryption key, re-encrypt existing tokens or require connections to reauthorize.

Review the official specifications and console behavior for every release and monthly.
Update this document's verification date, scopes, permissions, token lifetimes, and verification requirements after each review.

## Acceptance checklist

- Reconnecting the same Google or GitHub account does not create duplicate connections.
- Gmail lists and messages, Calendar events, and Drive files can be read.
- Gmail drafts and sends, and Calendar event creation, never run before approval.
- Installed GitHub repositories, code, issues, pull requests, and comments can be read.
- GitHub issue creation and comment posting never run before approval.
- Reads and writes to repositories outside the installation selection are rejected.
- Missing scopes or permissions produce an error that asks for reconnection.
- Provider errors, audits, and logs never store tokens or response bodies.

## References

The implementation sources of truth are the [Google Gatekeeper](../../../apps/google-gatekeeper/src/index.ts), [Google Connector](../../../packages/google-connector/src/index.ts), [GitHub Gatekeeper](../../../apps/github-gatekeeper/src/index.ts), and [GitHub Connector](../../../packages/github-connector/src/index.ts).

- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)
- [Google OAuth Web Server Flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth Policy](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google OAuth App Verification](https://support.google.com/cloud/answer/13461325?hl=en)
- [Google OAuth Audience and Test Users](https://support.google.com/cloud/answer/15549945?hl=en)
- [Gmail OAuth Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Calendar Authorization](https://developers.google.com/workspace/calendar/api/auth)
- [Google Drive OAuth Scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Choosing GitHub App Permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Generating a GitHub App User Access Token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing GitHub App User Access Tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub App REST Permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
