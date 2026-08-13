# Changelog

All notable changes to Open Personal Agent Platform are documented here.

## [0.1.0-alpha.1] - 2026-08-13

### Added

- Google Personal Connector for Gmail, Calendar, and Drive, including approval-gated Gmail and Calendar writes.
- GitHub App connector for repository reads, Issue creation, and Issue or Pull Request comments.
- Discord HTTP Interaction adapter, private Gatekeeper, owner linking, slash commands, notification destinations, and an experimental Gateway Bridge for normal DMs.
- One-time and recurring tasks with owner-configurable IANA or UTC-offset time zones.
- Cross-surface chat synchronization between the Owner UI and Discord DM.
- Explicit reconciliation for external writes whose result is `unknown`.
- A physically separate, read-only Delegated Source Gatekeeper with independent OAuth credentials, D1 storage, and resource allowlists.
- Deployment-time Execution Lease public-key consistency verification.

### Changed

- Improved connector tool selection, approval review, result formatting, and conversation ordering.
- Added approval filtering, execution-state feedback, task and memory editing, persistent approval mode, and keyboard sending controls.
- OAuth refresh rejection now marks a connection as requiring reconsent without falling back to broader credentials.
- Updated the English and Japanese documentation to describe the Phase 3 boundary and staging workflow.

### Known limitations

- Delegated Source query and ACL wiring is scheduled for Phase 4.
- The Discord Gateway Bridge is experimental and has not been validated on a physical Mac mini.
- This alpha has no production SLA or long-term API compatibility guarantee.

## [0.1.0-alpha.0] - 2026-08-11

- Initial public alpha with the Phase 2 owner vertical slice and cost controls.
