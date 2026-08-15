# Phase 4 Knowledge API

[English](../../en/operations/phase-4-knowledge.md)

## Public検索

Public Workerは、配置時に検証した`PUBLIC_SOURCES_JSON`からSource Registryを読み取ります。
Control D1、OAuth Gatekeeper、Conversation、Private R2、Local ProviderへのBindingは持ちません。

stagingでは、同じ`okidev-web` AI Search Instanceへ複数のSource IDで接続します。

- `source:public-ai-search`：Workers Instance Bindingを使う既定経路です。
- `source:public-ai-search-rules`：同じBindingを使い、規約検索向けに一致閾値を下げた経路です。
- `source:public-ai-search-endpoint`：互換試験に限り`https://search.wplaceoki.com/search`を呼び出します。

productionのManifestにはPublic Endpoint Sourceを含めません。
`ENVIRONMENT=production`の場合、WorkerもPublic Endpoint Transportを拒否します。

SourceごとにRetrieval種別、候補件数、一致閾値、Context Expansion、回答Context量、最大出力Token、Reasoning Effortを設定できます。
OkiDev stagingはVector Retrieval、候補10件、通常閾値0.4、規約閾値0.3、Context Expansion 1を使います。
Query Rewrite、Rerank、AI Search Generationは無効なため、`search`は回答生成予算を消費しません。

## Delegated検索

Ownerはナレッジ画面でGoogle DriveまたはGitHubの専用Credentialを接続し、OAuth開始前にResource Allowlistを入力します。
続いてIssuer、Audience、Claim Rule、Information Policy、任意のCache Policyを指定してSourceを公開します。

Delegated APIは、最初にPolicy ControlへJWT Claimの評価を要求します。
読取専用GatekeeperはProviderを呼ぶ前に、Credentialへ保存したResource Allowlistを再検証します。
どちらか一方が拒否した場合は検索を実行しません。

Delegated Cacheは既定で無効です。
有効にした場合も最大60秒だけ保持し、Issuer Digest、Principal ID、Source ID、Source Version、Query、結果数でEntryを分離します。

## Answer Modeと費用

Public Answerと、送信を許可した`normal`のDelegated Dataは、AI Gateway経由の`@cf/google/gemma-4-26b-a4b-it`を使います。
Modelへ渡すSourceは上位5件、合計32 KiBまでです。
出力上限はSourceごとに128から4,096 Tokenの範囲で設定でき、既定は1,024 Token、OkiDev stagingは4,096 Tokenです。
開始前は最大量を予約し、完了後は実際の回答量で精算して未使用分を解放します。

`sensitive`のDelegated Dataとすべての`secret`は`MODEL_DESTINATION_DENIED`を返します。
AI予算が処理を拒否した場合は`AI_SPEND_LIMIT_REACHED`を返し、別Providerへ切り替えません。
この場合も検索は継続できます。

すべてのPlaneは、Deployment名から導出した同一のQuota Durable ObjectへAI利用量を予約します。
alpha stagingから更新した場合は、Ownerが`POST /v1/usage/migrate`を一度呼び出すと、旧`owner`と`public`Shardを集約できます。
Import Markerが再実行時の二重加算を防ぎます。

## OpenAPI、SDK、MCP

Public WorkerとDelegated Workerは、`GET /openapi.json`でOpenAPI 3.1文書を返します。
生成済み文書は`openapi/`へ保存し、`pnpm openapi:check`が差分を検出します。

`@opap/sdk`は`createPublicClient`と`createDelegatedClient`を公開します。
Delegated Clientは、指定されたCallbackから要求ごとにBearer Tokenを取得します。

`POST /mcp`は、旧SSE Transportを使わないstateless Streamable HTTPです。
公開するToolは`list_knowledge_sources`、`search_knowledge`、`answer_knowledge`だけです。
Delegated MCPはRESTと同じJWT、ACL、Quota、Cache、Application Serviceを使います。

## staging検証

1. Control D1へ`0006_knowledge_sources.sql`を適用します。
2. Quota、Policy Control、Delegated Source Gatekeeper、Assistant、Public API、Delegated APIの順に配置します。
3. 二つのAI Search Source IDへ同じQueryを送り、正規化後の結果項目を比較します。
4. `answer`を呼び出し、Gemma 4 26Bの回答と引用を確認します。
5. 二つのDelegated Subject間でQuotaとCache Entryが共有されないことを確認します。
6. 同じSourceをREST、SDK、MCPの利用例から呼び出します。

実資格情報の受入試験では、`.dev.vars`へ`DELEGATED_TEST_JWT`を設定してから次を実行します。

```powershell
node --experimental-strip-types scripts/test-delegated-staging.ts `
  --source-id source:delegated-drive-test `
  --query "OPAP delegated Drive staging verification" `
  --answer true
```

スクリプトはJWTを表示せず、REST、TypeScript SDK、MCP、許可外Source拒否、任意の回答生成を検証します。

AI SearchはOpen Betaへ依存します。
課金変更後にPrice Catalogが古くなった場合、OPAPはAI Search Adapterだけを`PRICING_CATALOG_STALE`で停止します。
