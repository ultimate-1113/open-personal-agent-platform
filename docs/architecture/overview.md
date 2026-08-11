# アーキテクチャ

一つの配置は一人の所有者専用です。

外部サイト利用者はDelegated Principalであり、所有者の個人秘書へアクセスできません。

システムはAssistant、Public、Delegated、Control、GatekeeperのWorkerへ分かれます。

Public WorkerにはControl DB、OAuth、Memory、Private R2、Local ProviderのBindingを設定しません。Private Dataを持たない`PUBLIC_QUOTA` Durable Objectだけを許可します。

Delegated Workerは明示公開された読取Capabilityだけを呼び出します。

ControlとGatekeeperは公開Routeを持たず、Service Binding RPCだけを受け付けます。

## データ分類

機密度、閲覧主体、送信先、保持期限、取得元の信頼度を独立して記録します。

派生データは、入力の制約を緩めずに合成します。

## 承認

承認は表示した要求のSHA-256ダイジェストへ束縛します。

Gatekeeperは署名済みExecution Leaseを検証し、Nonceを一度だけ消費します。

## I/O予算

D1はOwner設定、Grant、Policy、承認、Connector、Plugin Installationなど、更新頻度の低いControl Dataに限定します。

Conversation内のMessage、Task、ObservationはConversation Durable ObjectのSQLiteへ、一回のTransactionでまとめて保存します。

Conversationの作成と状態変更はAssistant WorkerでOwner認証と`owner-stateful-operation`のReservationを済ませてから、非公開のConversation Agent Durable Objectへ転送します。同じIdempotency Keyは同じConversation IDへ決定的に対応します。

Audit Eventは配置単位のAudit Ledger Durable Objectへ追記し、日次CheckpointだけをD1とR2へ書き出します。

通常Auditは一つの状態変更要求につき一回のLedger RPCへまとめます。失敗時だけOutboxへ残し、次回要求または既存Alarmで再送します。Ledger確認後はOutbox行を削除します。

Audit Ledgerは日次Segmentに分けます。Active Segmentは更新禁止とし、R2 Checkpointを保存したClosed Segmentだけを180日後にSegment単位で削除します。

Public Rate LimitはCloudflare Rate Limiting Bindingで処理し、要求ごとのD1 Counter更新を行いません。

Policy、Grant、Delegated Source ACLは版付きSnapshotとしてTask開始時に取得し、Execution Leaseへ版を束縛します。

GatekeeperはLeaseを検証できるため、外部API実行前にPolicyをD1から再読込しません。

UsageはTokenやSubrequestごとの明細行を保存せず、配置・資源・課金期間単位のRollupを更新します。Delegated Principalだけは専用Quota Durable Objectで分離し、Task別利用量はTaskのCall CountとAudit Metadataから取得します。有料処理は推定量を先に予約し、終了後に実績との差分を精算します。

Durable ObjectのAlarmはTaskごとに作らず、各Conversationで最も早い実行時刻に一つだけ設定します。

## 費用保護

既定値はCloudflareの契約上限ではなく、個人利用向けの運用予算です。日次と月次のSoft LimitおよびHard Limitを持ち、Hard Limitを超える可能性がある処理は開始前に拒否します。

- Public検索はRate Limiting BindingとCacheを先に評価し、D1へ要求単位のQuotaを書きません。IPは匿名利用者の補助キーであり、TokenやJWTがあればPrincipal IDを使います。
- `search`はモデルを呼ばず、`answer`だけがモデル予算を消費します。
- Model入力、出力、検索件数、Tool Call数には要求単位の上限を設けます。
- Soft Limit後は検索のみ、または明示設定された低価格Providerへ縮退します。
- SandboxはPlugin呼出しの既定経路にせず、静的Pluginを優先します。動的PluginはContainer Memory、CPU、Diskを別々に予約してから起動します。
- R2への監査Checkpointは日次一Objectとし、一覧取得ではなく決定的なObject Keyで読みます。
- Workers Logsは本文を記録せず、SamplingとRedactionを適用します。

具体的な既定予算と測定方法は[利用量・費用予算](../operations/resource-budgets.md)で管理します。
