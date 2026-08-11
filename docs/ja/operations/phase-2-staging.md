# Phase 2 staging検証

[English](../../en/operations/phase-2-staging.md)

Phase 2のstaging検証はMock CIの成功後にCloudflare Workers Paidで実行します。
実Credentialと生成済みResource IDはCommitしません。

## 前提条件

```bash
pnpm install --frozen-lockfile
pnpm check
```

staging専用のD1 Database、Durable Object Namespace、AI Gateway、Access Applicationを使います。
Control D1へ`migrations/control`を適用します。

## 配置時の設定値

- `OWNER_EMAIL`: 配置するOwnerのEmail Address
- `ACCESS_ISSUER`: Cloudflare AccessのIssuer
- `ACCESS_AUDIENCE`: Access ApplicationのAudience Tag
- `ACCESS_JWKS_URI`: Access JWKS Endpoint
- `AI_GATEWAY_ID`: Payload Loggingを無効にしたstaging Gateway
- `WORKERS_AI_MODEL`: Price Catalogへ登録したWorkers AI Model ID

`OWNER_EMAIL`は最初のBootstrap照合だけに使います。
以降の認可はJWTのIssuerとSubjectを使います。

## Owner縦断試験

1. Accessで認証し、Owner以外のJWTが`403`になることを確認します。
2. Mock Local ProviderでConversationを作成し、Message、Task、Memoryを保存します。
3. Workers AIを選択し、通常Dataの送信を明示的に許可します。
4. Workers AIのResponseを保存し、Neuronと超過利用量を確認します。
5. AI Budgetを`0 USD`へ変更し、無料利用量を使い切った後に`AI_SPEND_LIMIT_REACHED`になることを確認します。
6. 同じ`Idempotency-Key`を再送し、Modelが再実行されないことを確認します。
7. AI Gateway Spend Limitの拒否時にProviderが切り替わらないことを確認します。
8. 日本語と英語、ライトテーマとダークテーマを切り替え、再読込後も選択が保持されることを確認します。

## 証跡

Secretを含まないCI結果、Worker Binding一覧、Owner UIのScreenshot、拒否試験の結果を証跡にできます。
Access JWT、Message本文、Prompt、OAuth Token、Cloudflare API Tokenは含めません。

## 費用保証の境界

Application Reservationは、この配置が開始するAI処理を制限します。
別Workerが消費した無料Neuronと、Worker Code実行前に計上されるRequestは制御できません。
AI Gateway Spend LimitとCloudflare Account Budget Alertを二次制御として併用します。
