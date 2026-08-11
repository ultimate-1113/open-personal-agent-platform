# 利用量・費用予算

単一Ownerの配置を、正常利用時にはWorkers Paid標準料金の包含量内で運用します。

これはCloudflareアカウント全体の請求額に対するHard Capではありません。

Worker要求はアプリケーションコードより前に課金対象となるため、分散攻撃や同じアカウントにある別Workerの利用量は本基盤だけでは制御できません。

## 費用ポリシー

非AI資源の既定Hard Limitは包含量の80%、Soft Limitは60%です。

OwnerはHard Limitを包含量の10%から100%まで変更できます。

`unlimited`は費用上の停止だけを解除し、Capability呼出回数、Plugin実行30秒、出力1 MiB、同時実行数2などの安全上限は解除しません。

AIは日次無料割当を先に使い、超過を月5 USDまで許可します。

Ownerが予算または`unlimited`を選択した操作は、確認画面に費用責任を表示してAudit Eventへ同期記録します。

## 2026年8月Price Catalog

| 資源 | Paid包含量 | Soft Limit | Hard Limit |
| --- | ---: | ---: | ---: |
| Workers要求 | 10 million/月 | 6 million | 8 million |
| Workers CPU | 30 million CPU-ms/月 | 18 million | 24 million |
| Durable Object要求 | 1 million/月 | 600,000 | 800,000 |
| Durable Object Duration | 400,000 GB-s/月 | 240,000 | 320,000 |
| Durable Object行読取 | 25 billion/月 | 15 billion | 20 billion |
| Durable Object行書込 | 50 million/月 | 30 million | 40 million |
| Durable Object SQLite | 5 GB-month | 3 GB-month | 4 GB-month |
| D1行読取 | 25 billion/月 | 15 billion | 20 billion |
| D1行書込 | 50 million/月 | 30 million | 40 million |
| D1 Storage | 5 GB-month | 3 GB-month | 4 GB-month |
| R2 Storage | 10 GB-month | 6 GB-month | 8 GB-month |
| R2 Class A | 1 million/月 | 600,000 | 800,000 |
| R2 Class B | 10 million/月 | 6 million | 8 million |
| Workers Logs | 20 million/月 | 12 million | 16 million |
| Container Memory | 25 GiB-hours/月 | 15 | 20 |
| Container CPU | 375 vCPU-minutes/月 | 225 | 300 |
| Container Disk | 200 GB-hours/月 | 120 | 160 |

Price Catalogはリリース時と毎月確認します。

確認から31日を超えた場合、安定機能は警告だけを出して継続し、価格未対応のPreviewまたはBeta Adapterだけを停止します。

基準は[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[Containers](https://developers.cloudflare.com/containers/pricing/)です。

## 要求処理と集計

処理順序は、認証と入力検証、Edge制限、Cache、Quota予約、実行、実績精算、AuditとUsage Rollupの順です。

Cache HitはD1、Quota Durable Object、AIを呼びません。

Reservationは期間、資源、推定量、期限、Task ID、Idempotency Keyを保持し、再試行で二重予約しません。

期限切れ回収は次回要求または既存Alarmへ相乗りし、Reservation専用の高頻度Alarmを作りません。

Usage Rollupは配置、資源、課金期間単位で保存します。

Principal別QuotaはDelegated API専用のQuota Durable Objectで管理し、Task別利用量はTaskのCall CountとAudit Metadataから取得します。

下流処理にはPublic Cache Miss 500,000回/月、Delegated Query 100,000回/月、Delegated Subject 500回/日、Owner Stateful Operation 50,000回/月の上限を設けます。

Rate Limiting Bindingは濫用抑制であり費用Hard Limitではありません。

匿名利用者にはIPを補助キーとして使い、API TokenまたはDelegated JWTがある場合は安定したPrincipal IDをキーにします。

Productionでは`workers.dev`を無効にし、公開Sourceがある場合だけPublic Routeを有効化します。

Account Budget Alertは3 USDと5 USDを推奨しますが、日次通知でありHard Capではありません。

## AIとSandbox

Workers AIの10,000 Neurons/日の無料割当後を月5 USDのReservationへ計上します。

Owner会話は入力のUTF-8 byte数と最大出力Tokenから保守的にNeuronを予約します。

Binding応答には確定Neuron明細が含まれないため、成功時は実際の出力長から推定精算し、通信結果が不明な失敗は予約最大量を使用済みとして精算します。

Cloud AIはPayload Loggingを無効化した認証済みAI Gateway経由に統一し、アプリケーションReservationを一次制御、Gateway Spend Limitを二次制御にします。Workers AI BindingではMetadata-only Loggingを要求できないため、Gateway Logを無効化してサニタイズ済みMeterをOPAP側へ記録します。

AI予算到達後も`search`は継続し、`answer`だけを`AI_SPEND_LIMIT_REACHED`で拒否します。

Gatewayの429で別Providerへ自動Fallbackしません。

Owner会話は出力2,048 Token、PublicとDelegatedの`answer`は1,024 Token、一要求は最大4,096 Tokenです。

動的Pluginは`lite` Container、RPC Transport、`keepAlive: false`、`sleepAfter: "30s"`を使います。

Cold Startでは実行30秒とSleep待機30秒を合わせたMemoryとDiskを予約し、CPUはInstance上限を予約して実績精算します。

Memory、CPU、DiskのどれかがHard Limitへ達した場合は動的Pluginだけを停止します。

## 保存量と監査

D1は低頻度のControl Dataに限定し、要求、Token、検索結果、ログごとの行を書きません。

Conversation Durable Objectは一会話500 MiB、配置全体のDurable Object SQLiteは4 GBで新規書込を停止します。

StorageのSoft Limitでは要約、期限切れ成果物削除、Checkpoint済みAudit Segmentの期限削除を実行します。

Hard Limit後も読取、Export、削除を許可し、新しい添付、Plugin成果物、Conversation書込だけを`STORAGE_BUDGET_REACHED`で拒否します。

通常Auditは一つの状態変更要求につき一回のLedger RPCへまとめます。

失敗時だけOutboxへ残し、次回要求または既存Alarmで再送します。

Ledger確認後は配信済みOutbox行を削除します。

Audit Ledgerは日次Segmentとし、R2 Checkpointを持つClosed Segmentだけを180日後にSegment単位で削除できます。

R2はStandard Storageだけを使い、既知のKeyで取得します。
