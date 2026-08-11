# Owner操作面

Owner UIはAssistant Workerと同一Originで配信します。

Cloudflare Accessを必須の外側境界とし、すべての`/v1` APIでAccess JWTを再検証します。

UIはConversation、Task、Structured Memory、Approval、Audit、Model Provider、Budgetを扱います。

Conversation IDの選択だけを端末のLocal Storageへ保存し、メッセージ、Memory、承認内容、監査履歴はブラウザへ永続保存しません。

Task、Memory、Messageの書込は、Owner Stateful OperationのQuota予約後にConversation Durable Objectへ保存し、成功後に実績精算します。

ApprovalはControl D1へ保存し、承認または拒否はIdempotency Keyへ束縛します。

Approval作成と判断は配置単位のAudit Ledger Durable Objectへ同期追記します。

Audit Ledgerは日次Segmentと配置全体のSHA-256ハッシュチェーンを保持します。

予算設定はControl D1へ保存し、更新をAudit Eventへ記録します。

利用量画面はOwner Quota Durable Objectの期間Rollupを読み取り、通常、縮退、停止の状態を表示します。

Model Routerの既定経路は`MockLocalProvider`です。

`WorkersAiProvider`はAI Gateway指定、Payload Logging無効化、出力Token上限、Destination評価を実装しています。

Workers AIはOwnerがProvider画面で`owner`かつ`normal`の送信先として明示許可した場合だけ選択できます。

生成前に日次無料Neuronと月次超過予算をQuota Durable Objectで原子的に予約し、成功後は保守的な実績推定へ精算します。

AI Gateway BindingはPayloadを残さないためGateway Log自体を無効化し、サニタイズ済み利用量だけをOPAP側へ保存します。

GatewayのSpend Limit拒否やWorkers AI停止時に、別Providerへ自動Fallbackしません。
