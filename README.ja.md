# Open Personal Agent Platform

[English](README.md)

Open Personal Agent Platformは、Cloudflareを常時稼働する制御基盤として使う、本人専用のオープンソース・パーソナルエージェント基盤です。

一つの配置は、一人のOwnerだけに属します。
外部サイトの利用者はDelegated Principalとして分離され、Ownerの個人秘書を共同利用しません。

> [!WARNING]
> 現在の開発版は`v0.1.0-beta.1`を対象としています。
> Cloud Baseはベータ対象です。Dynamic Plugin、Sandbox Preview、Docker版Discord Gateway Bridgeは実験機能です。

## 現在利用できる機能

- Cloudflare Access JWTを再検証するOwner専用Web UI
- Conversation、Task、Structured Memory、Approval、Audit
- D1、SQLite-backed Durable Objects、Service BindingによるPrivate Control Plane
- OwnerとDelegated Principalを分離するIdentityとACL
- Information Policy、Capability、Execution Lease、Provenance、Audit Hash Chain
- 非AI資源のReservationと包含量80%の既定Hard Limit
- Workers AIの月5 USD超過予算、AI Gateway、Neuron Reservation
- Mock Local ProviderとWorkers AI Provider
- AI Gateway経由の`@cf/google/gemma-4-26b-a4b-it`
- Public WorkerからPrivate Bindingを排除するCI契約試験
- Cloudflare契約や実資格情報を必要としないContributor CI
- 日本語と英語のUI、設定を保持するライトテーマとダークテーマ
- Gmail、Calendar、Driveを扱うGoogle Personal Connector
- Repository読取、承認付きIssue作成、承認付きComment投稿を行うGitHub App Connector
- DiscordのSlash Command、Owner Link、Task Scheduling、Approval、通知、実験的DM Gateway Bridge
- CredentialとResource Allowlistを分離した読取専用Delegated Source Gatekeeper
- Modelを使わない検索と引用付き回答を提供するPublicおよびDelegatedの`POST /v1/query`
- Fixture、静的Index、AI Search、Google Drive、GitHubのKnowledge Adapter
- OpenAPI 3.1、型付き`@opap/sdk`、stateless Streamable HTTP MCP
- 実際の`okidev-web` AI Search Bindingとstaging専用のPublic Endpoint互換Transport
- Conversation Registry、Owner Export、削除の伝播、日次Audit Checkpoint、Retention Job
- Build時に検証するStatic Plugin RegistryとOwner専用Dynamic Plugin Runtime
- `local-dev`、`minimal`、`cloud-base`、実験的な`cloud-base-dynamic`の配置Profile
- 実験的Discord Gateway Bridgeを実行するクロスOS対応Docker Compose

Ownerは招待や他者の承認なしで初回設定を開始します。
Delegated Principalは明示的に公開されたSourceだけを読み取れます。

## 対象外

GitHubコード変更、決済、複数Owner、複数Tenantはv0.1の対象外です。
Gmail送信は、正確な内容をOwnerが承認した場合に限り利用できます。
Local AI Router、公開Plugin Registry、Pluginの任意Internet接続はbeta.1へ含めません。

## セキュリティ境界

```mermaid
flowchart LR
  OWNER["Owner"] --> ACCESS["Access保護UI"]
  ACCESS --> ASSISTANT["Assistant Worker"]
  ASSISTANT --> AGENT["Conversation Durable Object"]
  ASSISTANT --> CONTROL["非公開Policy Control"]
  ASSISTANT --> MODEL["Model Router"]
  PUBLIC["匿名利用者"] --> PUBLICAPI["Public API Plane"]
  DELEGATED["Delegated Principal"] --> DELEGATEDAPI["Delegated API Plane"]
  PUBLICAPI -. "Private Bindingなし" .-> PUBLICSOURCE["Public Source"]
  DELEGATEDAPI -. "読取Grantのみ" .-> CONTROL
```

Public WorkerはControl D1、OAuth Gatekeeper、Owner Memory、Private R2、Local Providerへ到達できません。
Ownerデータは送信先が明示的に許可された場合だけCloud Providerへ送信され、`secret`データはすべてのModel利用を拒否します。

## 開発

Node.js 24とpnpm 11が必要です。

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`はLint、strict TypeScript、TestとCoverage基準、全Workerのdry-run buildを実行します。
通常のCIはMockだけを使います。

## 配置

標準配置先はCloudflare Workers Paidです。
配置固有のResource ID、Owner Email、Access Audience、Gateway IDは、Gitが無視する`.wrangler/`配下の生成ファイルへ設定します。

`pnpm opap setup --profile cloud-base`を実行すると、配置計画と事前確認を表示します。
確認後に`--apply`を付けると、D1とR2の作成または再利用、既存D1のBackup、Migration、設定済みSecretの登録、配置、配置状態の確認まで実行します。

案内付きInstallerは、Windowsでは`./install.ps1`、macOSとLinuxでは`sh ./install.sh`を実行します。
対象Cloudflare Accountを変更する準備ができた場合だけ`--apply`を付けます。
Resource ID、Secret、Migration Backupを確認した後だけ`--apply`を付けます。
このコマンドは既存のAccess Team Domain、Tunnel、Application、Policyを変更しません。

## 費用とプライバシー

- 非AI資源は包含量の60%で警告し、80%で既定停止します。
- Workers AIは日次無料Neuronを先に使い、月5 USDまでの超過を既定で許可します。
- AI GatewayのSpend Limitを二次防壁として使います。
- Gateway Payload Loggingは無効です。
- AI予算到達後も、Modelを使わない検索は継続します。
- 無許可のCloud Providerへ自動Fallbackしません。
- 外部Telemetryは既定で無効です。

アプリケーションのHard Limitは、Workerコード実行前に計上される要求と、同じCloudflareアカウント内にある別Workerの利用量を制御できません。
詳細は[利用量と費用予算](docs/ja/operations/resource-budgets.md)を参照してください。

## 文書

- [OPAPセットアップウィザードの監査](docs/ja/operations/installer-security.md)
- [アーキテクチャ](docs/ja/architecture/overview.md)
- [脅威モデル](docs/ja/security/threat-model.md)
- [データ処理方針](docs/ja/security/data-handling.md)
- [Identity設定](docs/ja/operations/identity-configuration.md)
- [Owner操作面](docs/ja/operations/owner-surface.md)
- [Phase 3 Connector](docs/ja/operations/phase-3-connectors.md)
- [Phase 4 Knowledge API](docs/ja/operations/phase-4-knowledge.md)
- [Google・GitHub Provider設定](docs/ja/operations/connector-provider-setup.md)
- [Phase 5の運用とPlugin](docs/ja/operations/phase-5-beta.md)
- [多言語対応](docs/ja/contributing/localization.md)

## セキュリティとライセンス

脆弱性は公開Issueではなく、非公開のGitHub Security Advisoryから報告してください。
[SECURITY.ja.md](SECURITY.ja.md)を参照してください。

Apache License 2.0
