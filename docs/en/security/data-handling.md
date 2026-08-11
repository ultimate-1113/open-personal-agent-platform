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
