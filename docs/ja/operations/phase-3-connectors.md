# Phase 3 Connector

[English](../../en/operations/phase-3-connectors.md)

Phase 3では、Phase 2で確立したWorker境界を緩めずにGoogle、GitHub、Discordを追加します。
外部管理画面の作成手順、ScopeとPermissionの対応、Secret、変更時の確認事項は[Google・GitHub Provider設定](connector-provider-setup.md)に記載します。

## 実装順序

1. 共通OAuth State、S256 PKCE、Token Rotation、Revocation、Credential Envelope Encryption
2. Credentialを分離したGoogle Personal GatekeeperとDelegated Source Gatekeeper
3. GitHub App Installationを分離したGitHub Personal GatekeeperとDelegated Source Gatekeeper
4. 常に承認が必要なGmail送信、Calendar Event、GitHub Issue、GitHub Commentの書込
5. Discordの一回限りOwner Link、Conversation Reply、Approval Notification
6. 外部書込が`unknown`になった場合の照合UI

共通OAuth基盤、Google Personal Gatekeeper、GitHub Personal Gatekeeper、物理的に分離したDelegated Source Gatekeeperは実装済みです。
Gmailは、正確な宛先、件名、本文をOwnerが承認した後にだけ送信します。
送信先を配置時のAllowlistで制限しません。
GitHubはRepository、Code、購読中のIssue、Pull Request、IssueまたはPull Requestのコメントを読み取ります。
Issue作成とコメント投稿は、Ownerが内容を承認した後にだけ実行します。
GitHubのコード変更とPull Request作成は実装しません。
DiscordのHTTP Interaction、Owner Link、Command、通知先、実験的Gateway Bridgeは実装済みです。
配置手順は[Discord Connector](discord-connector.md)に記載します。
Delegated Source Gatekeeperは専用D1、専用OAuth Credential、読取専用Endpoint、Drive File・FolderまたはGitHub Repositoryの明示Allowlistを持ちます。
Gmail、Calendar、書込Capabilityは呼び出せません。
Phase 4で、この内部契約をSource ACL評価とDelegated Knowledge APIへ接続します。
外部書込が`unknown`になった場合、Ownerは外部操作を自動再試行せず、実行済みまたは未実行として照合できます。

## Delegated Sourceの配置境界

`apps/delegated-source-gatekeeper`は専用D1と専用`CREDENTIAL_KEK`を使って配置します。
`GOOGLE_CLIENT_SECRET`と`GITHUB_CLIENT_SECRET`は通常VariableではなくWorker Secretへ設定します。
Google OAuth ClientとGitHub App InstallationはPersonal Gatekeeperと分けます。
OAuth開始要求には、一つ以上のDrive File・Folder IDまたは`owner/repository`形式の識別子が必要です。
Folder配下の文書を読む場合はGoogle Driveが返した親Folder IDを再検証し、対応するText Contentを最大1 MiBまで返します。
このWorkerをAssistant WorkerまたはPublic Agent APIへBindingしません。
Phase 4でDelegated APIだけへNamed Internal Service Bindingとして接続します。

## GitHub Appのstaging設定

GitHub Appには次の値を設定します。

- **Callback URL**：`https://opap-assistant-staging.lfantian708.workers.dev/v1/connections/github/callback`
- **Webhook**：初期設定では無効
- **User authorization callback**：有効
- **User-to-server token expiration**：有効を推奨

GitHub Appには次の最小権限を設定します。

- **Repository permissions / Contents**：Read-only
- **Repository permissions / Issues**：Read and write
- **Repository permissions / Pull requests**：Read-only
- **Repository permissions / Metadata**：Read-only（GitHubが自動付与）

Appは必要なRepositoryだけへInstallします。
User Tokenで利用できるRepositoryは、利用者の権限とApp Installationの対象範囲の積集合です。

GitHubの通知一覧APIはGitHub App User Access Tokenに対応しないため使用しません。
Ownerの要求時に、更新日時順の購読中IssueとPull Requestを受信箱として取得します。
常時ポーリングはWorkers要求とGitHub API Rate Limitを消費するため、v0.1では行いません。
Webhookによる自動取込は、署名検証専用の公開Workerを追加してから有効にします。

## セキュリティ要件

- Gatekeeper Credential Encryption Keyは32 byteのWorker Secretとし、平文Variableへ保存しません。
- OAuth Transactionは10分で失効し、State Digestだけを保存して一度だけ消費します。
- Authorization Code FlowはS256 PKCEと完全一致するHTTPS Redirect URIを使います。
- Provider ErrorにはStatusとOperationだけを記録し、Response BodyとTokenを含めません。
- GitHub AppはOAuth Scopeを要求せず、App PermissionとInstallation範囲で権限を制限します。
- Refresh拒否時はConnectionを再同意待ちにし、広い権限のCredentialへFallbackしません。
- Personal ConnectionとDelegated Source ConnectionはCredential、Scope、Database、Entrypointを分離します。
- 配置前に`pnpm verify:execution-lease-keys`を実行し、Gatekeeperの検証鍵不一致を拒否します。

Provider登録と実Credential Testは手動staging Workflowだけで実行します。
Contributor CIはFake OAuth ServerとFake API Serverを使います。
