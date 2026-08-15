# Data handling

[日本語](../../ja/security/data-handling.md)

External services remain the source of truth, and body content is not permanently duplicated by default.
An observation stores only its source ID, content digest, information policy, and derivation links.

Owner observations are stored in the Conversation Durable Object.
Public searches do not persist an observation per request, and delegated searches do not write one D1 row per result.
Only necessary denial events and aggregate usage are recorded.

Conversations and structured memory remain until the owner deletes them.
Approval and audit metadata is retained for 180 days by default, plugin logs for 7 days, and temporary artifacts for 24 hours.

OAuth tokens use envelope encryption inside a Gatekeeper and are never passed to models, plugins, or general logs.

Public knowledge responses contain only sources declared in the deployment manifest.
Delegated search results are isolated by issuer, principal, source, and source version when the owner enables the short-lived cache.
The cache never stores JWTs, credentials, connector tokens, or source document bodies beyond the returned excerpt.

Answer mode sends at most five retrieved documents and 32 KiB of source text to a model.
Public data may use Workers AI.
Delegated data may use Workers AI only when its policy explicitly allows that destination and its sensitivity is `normal`.
`sensitive` and `secret` delegated data is not sent to a model in v0.1.
