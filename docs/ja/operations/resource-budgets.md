# 利用量と費用予算

[English](../../en/operations/resource-budgets.md)

単一Ownerの配置を、正常利用時にはCloudflare Workers Paidの包含量内で運用します。
これはCloudflareアカウント全体の請求額に対するHard Capではありません。
RequestはWorker Code実行前に計上されるため、本Applicationは分散攻撃と同じAccount内にある別Workerの利用量を制御できません。

## Policy

非AI Resourceの既定Soft Limitは包含量の60%、Hard Limitは80%です。
OwnerはHard Limitを10%から100%まで設定するか、`unlimited`を選べます。
`unlimited`は費用停止だけを解除し、Capability Call Count、Plugin実行30秒、Output 1 MiB、同時実行数2は維持します。

AIは日次無料割当を先に使い、月5 USDまでの超過を既定で許可します。
Budget変更と`unlimited`の選択時は費用責任を表示し、Audit Eventを記録します。

## 2026年8月Price Catalog

| Resource | Paid包含量 | Soft Limit | Hard Limit |
| --- | ---: | ---: | ---: |
| Workers Request | 10 million/月 | 6 million | 8 million |
| Workers CPU | 30 million CPU-ms/月 | 18 million | 24 million |
| Durable Object Request | 1 million/月 | 600,000 | 800,000 |
| Durable Object Duration | 400,000 GB-s/月 | 240,000 | 320,000 |
| Durable Object Row Read | 25 billion/月 | 15 billion | 20 billion |
| Durable Object Row Write | 50 million/月 | 30 million | 40 million |
| Durable Object SQLite | 5 GB-month | 3 GB-month | 4 GB-month |
| D1 Row Read | 25 billion/月 | 15 billion | 20 billion |
| D1 Row Write | 50 million/月 | 30 million | 40 million |
| D1 Storage | 5 GB-month | 3 GB-month | 4 GB-month |
| R2 Storage | 10 GB-month | 6 GB-month | 8 GB-month |
| R2 Class A | 1 million/月 | 600,000 | 800,000 |
| R2 Class B | 10 million/月 | 6 million | 8 million |
| Workers Logs | 20 million/月 | 12 million | 16 million |
| Container Memory | 25 GiB-hours/月 | 15 | 20 |
| Container CPU | 375 vCPU-minutes/月 | 225 | 300 |
| Container Disk | 200 GB-hours/月 | 120 | 160 |

Price CatalogはRelease時と毎月確認します。
31日を超えた場合、Stable機能は警告して継続し、最新価格に未対応のPreviewまたはBeta Adapterだけを停止します。
基準は[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[Containers](https://developers.cloudflare.com/containers/pricing/)です。

## Request集計

処理順序はAuthenticationとValidation、Edge Limit、Cache、Quota Reservation、Execution、Settlement、AuditとUsage Rollupです。
Cache HitはD1、Quota Durable Object、AIを呼びません。

ReservationはPeriod、Resource、Estimated Amount、Expiry、Task ID、Idempotency Keyを保持します。
Retryは二重予約せず、期限切れ回収は次のRequestか既存Alarmへ相乗りします。
RollupはDeployment、Resource、Billing Periodごとに保存します。

下流上限はPublic Cache Missが月500,000回、Delegated Queryが月100,000回、Delegated Subjectが日500回、Owner Stateful Operationが月50,000回です。
Rate Limiting Bindingは濫用を抑止しますが、請求額のHard Limitではありません。
Productionでは`workers.dev`を無効にし、Public Sourceが存在する場合だけPublic Routeを有効化します。

## AIとSandbox

Workers AIの日次無料10,000 Neuronsを超えた利用量は、月5 USDのReservationへ計上します。
すべてのCloud AIは、Payload Loggingを無効にした認証済みAI Gatewayを使います。
Application Reservationを一次制御、Gateway Spend Limitを二次制御とします。
AI Gatewayの`429`で別ProviderへFallbackしません。

Owner ConversationのOutputは2,048 Token、PublicとDelegatedの`answer`は1,024 Token、一要求は4,096 Tokenへ制限します。
AI Budget到達後も`search`は継続し、`answer`は`AI_SPEND_LIMIT_REACHED`を返します。

Dynamic Pluginは`lite` Container、RPC Transport、`keepAlive: false`、`sleepAfter: "30s"`を使います。
Memory、CPU、Diskを個別に予約し、どれか一つが上限へ達した場合はDynamic Pluginだけを停止します。

## StorageとAudit

D1は更新頻度の低いControl Dataへ限定し、Request、Token、Search Result、Logごとの行を作りません。
一つのConversationは500 MiB、配置全体のDurable Object SQLiteは4 GBで新規書込を停止します。

StorageのSoft Limitでは要約を実行し、期限切れArtifactと削除可能なClosed Audit Segmentを削除します。
Hard Limit到達後もRead、Export、Deleteを許可し、新しいAttachment、Plugin Artifact、Conversation Writeは`STORAGE_BUDGET_REACHED`を返します。

Auditは一つのMutationにつき一回のLedger RPCを使います。
失敗したDeliveryだけをOutboxへ残し、Closed Daily SegmentはR2 Checkpointが存在する場合に限り180日後に削除できます。
