# Phase 2 staging検証

Phase 2のstaging検証は、Mock環境のCIを通過した後にCloudflare Workers Paidアカウントで実行します。

実資格情報と生成されたResource IDはGitへ追加しません。

## 検証前の状態

次のローカル検査が成功していることを確認します。

```bash
pnpm install --frozen-lockfile
pnpm check
```

Cloudflare側では、staging専用のD1 Database、Durable Object namespace、AI Gateway、Access Applicationをproductionと分離します。

Control D1には`migrations/control`を適用します。

## 配置時に設定する値

Assistant Workerには次の値を設定します。

- `OWNER_EMAIL`：配置を所有する本人のメールアドレス。
- `ACCESS_ISSUER`：Cloudflare AccessのIssuer。
- `ACCESS_AUDIENCE`：Access ApplicationのAudience Tag。
- `ACCESS_JWKS_URI`：AccessのJWKS Endpoint。
- `AI_GATEWAY_ID`：Payload Loggingを無効にしたstaging用Gateway ID。
- `WORKERS_AI_MODEL`：Price Catalogへ登録したWorkers AI Model ID。

`OWNER_EMAIL`は初回Bootstrapの照合だけに使います。

Bootstrap後の認可はJWTの`issuer`と`subject`で行います。

## Owner縦断試験

1. Accessで認証し、Owner以外のJWTが`403`になることを確認します。
2. Mock Local ProviderでConversationを作成し、Message、Task、Memoryを保存します。
3. Models画面でWorkers AIを選び、通常データのクラウド送信を明示許可します。
4. Workers AIの応答をConversationへ保存し、Usage画面のNeuronと超過予約が更新されることを確認します。
5. AI予算を`0 USD`に変更し、無料枠超過後の生成が`AI_SPEND_LIMIT_REACHED`になることを確認します。
6. 同じ`Idempotency-Key`を再送し、モデルが再実行されず同じConversation応答が返ることを確認します。
7. Gateway Spend Limitの拒否時に別Providerへ切り替わらないことを確認します。

## 証跡

申請用の証跡には、Secretを含まないCI結果、Worker Binding一覧、Owner UIの画面、拒否系試験の結果を保存します。

Access JWT、メール本文、Prompt、OAuth Token、Cloudflare API Tokenは証跡へ含めません。

## 費用保証の範囲

アプリケーション内Reservationは、この配置が開始するAI処理を制限します。

Cloudflareアカウント内の別Workerが消費した無料Neuronと、Workerコードの実行前に計上される受信要求は制御できません。

その差を補うため、AI Gateway Spend LimitとCloudflare Account Budget Alertを併用します。
