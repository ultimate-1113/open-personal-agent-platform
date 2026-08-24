# Phase 5の運用とPlugin

依存関係は2026年8月20日時点で更新しています。現行の安定版`typescript-eslint`はTypeScript 6.1未満を対応範囲としているため、TypeScript 7ではなく対応範囲内の最新5.xを固定しています。`@types/node`も、未採用のNode最新版ではなく、最低実行環境であるNode.js 24 LTSに合わせています。

## 安定性の区分

`cloud-base`を正式なベータProfileとします。
このProfileにはOwner専用Plane、Connector、Knowledge API、MCP、Private R2を使うMaintenance、Export、Retention、Static Pluginが含まれます。

`cloud-base-dynamic`、Sandbox Runtime、Docker版Discord Gateway Bridgeは実験機能です。
これらを無効にしても、Web Chat、Connector、Knowledge API、SDK、MCPは動作を継続します。

## 配置

通常配置では`pnpm opap setup --target production`、隔離試験では`pnpm opap setup --target test`を実行すると、読取だけの事前確認と配置順を表示します。
名前付きTargetは配置名、環境、Profile、全Resource名の唯一の参照元であり、Command Lineや環境変数による上書きを拒否します。
`--apply`を付けると、必要なD1と非公開R2を再利用または作成し、解決したBindingをGit管理外の`.opap.wrangler.jsonc`だけへ保存します。
CLIはRootの`.env`と`.dev.vars`を読み込みます。
`OPAP_ENVIRONMENT`でResource名の環境Suffixを分離し、`OPAP_DEPLOYMENT_ID`で更新後も同じ配置Identityを維持します。
既存D1についてTime Travel BookmarkとSQL Exportを保存した後、Migration、Secret登録、依存順の配置、配置状態の確認を実行します。
`OPAP_ASSISTANT_URL`、`OPAP_PUBLIC_URL`、`OPAP_DISCORD_URL`を設定した場合はHTTP Health Checkも実行します。
Cloudflare AccessのApplication、Team Domain、Tunnel、Policyは変更しません。
`--apply`を付ける前に、D1 Time Travel BookmarkとローカルSQL Exportを作成し、仮のResource IDを実値へ置き換え、Worker Secretを登録します。

Setup Toolは既存のCloudflare Access Team Domain、Tunnel、Access Application、Access Policyを変更しません。
Account TokenにAccess Applicationの作成権限がない場合は、Setup Toolが示す値をDashboardへ入力します。

十分な長さの`PLUGIN_INVOCATION_SIGNING_KEY`を一つ生成し、Assistant WorkerとPlugin Runtime Workerへ同じ値をWorker Secretとして登録します。
この値を`wrangler.jsonc`へ書きません。
`.dev.vars.example`にはLocal開発で使うSecret名だけを記載しています。

## Export、削除、保持期間

Owner Exportは`opap-export/v1`を使用し、JSON ManifestとNDJSONで構成します。
OAuth Token、Worker Secret、Platform Token Hash、Execution Leaseの秘密情報、Connectorから取得した本文、`secret`のMessage本文は含めません。

Conversationを削除すると、Durable Objectの状態を消去し、Registryを削除済みに更新します。
Audit Eventは削除せず、対象のDigestと処理結果を保持します。
一度も再アクセスされないalpha版ConversationはNamespaceから列挙できないため、完全削除ではなくBest Effortの対象です。

Audit Ledgerは日次Segmentを閉じ、CheckpointをPrivate R2へ保存します。
Checkpointが存在しないClosed SegmentはRetentionで削除できません。
ExportとInspection成果物は24時間、Plugin実行Metadataは7日保持します。

## Plugin

Static PluginはBuild時に検証します。
Plugin IDとTool IDの重複、Schemaの欠落がある場合はBuildを失敗させます。

Dynamic Pluginは、`plugin.json`、単一ESM Bundle、CycloneDX 1.5または1.6のSBOMを含む`.tgz`を受け付けます。
InspectorはPath Traversal、Link、特殊File、Native Addon、Install Script、上限を超えるArchive、Digest不一致を拒否します。

Dynamic Pluginは、一般のInternet接続とSecret直接参照を禁止した`lite` Sandboxで実行します。
実行には短時間だけ有効なScope付きInvocation Tokenが必要です。
Capability呼出しは非公開Brokerを通し、書込操作には既存のOwner ApprovalとExecution Leaseを適用します。

## Docker版Gateway Bridge

`deployments/local/.env.example`を`.env`へコピーし、Discord用の四つの値を設定します。
同じDirectoryで次を実行します。

```bash
docker compose --profile discord-bridge up -d --build
```

WindowsとmacOSではDocker Desktop、LinuxではDocker Engineを使います。
Imageは`linux/amd64`と`linux/arm64`を対象にします。

OllamaはこのContainerへ含めません。
将来のLocal AI RouterはOllamaを外部Endpointとして扱い、Host上のOllamaには`host.docker.internal`、LAN上のEngineにはOwnerが許可したPrivate Network URLを使います。
