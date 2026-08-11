# Phase 3 Connector

[English](../../en/operations/phase-3-connectors.md)

Phase 3では、Phase 2で確立したWorker境界を緩めずにGoogle、GitHub、Discordを追加します。

## 実装順序

1. 共通OAuth State、S256 PKCE、Token Rotation、Revocation、Credential Envelope Encryption
2. Credentialを分離したGoogle Personal GatekeeperとDelegated Source Gatekeeper
3. GitHub App Installationを分離したGitHub Personal GatekeeperとDelegated Source Gatekeeper
4. 常に承認が必要なGmail Draft、Calendar Event、GitHub Issue、GitHub Commentの書込
5. Discordの一回限りOwner Link、Conversation Reply、Approval Notification
6. 外部書込が`unknown`になった場合の照合UI

共通OAuth基盤は実装済みです。
Provider GatekeeperとOwner向けConnection APIは実装中です。

## セキュリティ要件

- Gatekeeper Credential Encryption Keyは32 byteのWorker Secretとし、平文Variableへ保存しません。
- OAuth Transactionは10分で失効し、State Digestだけを保存して一度だけ消費します。
- Authorization Code FlowはS256 PKCEと完全一致するHTTPS Redirect URIを使います。
- Provider ErrorにはStatusとOperationだけを記録し、Response BodyとTokenを含めません。
- Refresh拒否時はConnectionを再同意待ちにし、広い権限のCredentialへFallbackしません。
- Personal ConnectionとDelegated Source ConnectionはCredential、Scope、Database、Entrypointを分離します。

Provider登録と実Credential Testは手動staging Workflowだけで実行します。
Contributor CIはFake OAuth ServerとFake API Serverを使います。
