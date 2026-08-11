# アーキテクチャ

[English](../../en/architecture/overview.md)

一つの配置は、一人のOwnerだけが使います。
外部サイト利用者はDelegated Principalであり、Ownerの個人秘書へアクセスできません。

システムはAssistant、Public、Delegated、Control、GatekeeperのWorkerへ分離します。
Public WorkerにはControl D1、OAuth、Memory、Private R2、Local ProviderのBindingを設定せず、Private Dataを持たない`PUBLIC_QUOTA` Durable Objectだけを許可します。
Delegated Workerは明示的に公開された読取Capabilityだけを呼び出します。
ControlとGatekeeperは公開Routeを持たず、Service Binding RPCだけを受け付けます。

## Information Policy

Sensitivity、Audience、Destination、Retention、Source Trustを独立した軸として記録します。
派生データは入力の制約を緩めずに合成します。

## 承認

承認は表示した要求のSHA-256 Digestへ束縛します。
Gatekeeperは署名済みExecution Leaseを検証し、Nonceを一度だけ消費します。

## I/O予算

D1はOwner設定、Grant、Policy、Approval、Connector、Plugin Installationなど、更新頻度の低いControl Dataに限定します。
Conversation内のMessage、Task、ObservationはConversation Durable ObjectのSQLiteへ一回のTransactionでまとめて保存します。

AssistantはOwnerを認証し、`owner-stateful-operation`を予約してから、状態変更を非公開のConversation Agent Durable Objectへ転送します。
同じIdempotency Keyは同じConversation IDへ決定的に対応します。

Audit Eventは配置単位のAudit Ledger Durable Objectへ追記します。
D1とR2へは日次Checkpointだけを書き出します。
通常のAudit Eventは、一つの状態変更要求につき一回のLedger RPCへまとめます。
失敗したEventだけをOutboxへ残し、次の要求か既存Alarmで再送し、Ledgerの確認後に削除します。

Ledgerは日次Segmentに分けます。
Active Segmentだけが変更可能であり、Closed SegmentはR2 Checkpointが存在する場合に限り180日後に削除できます。

Publicの濫用抑止にはCloudflare Rate Limiting Bindingを使い、要求ごとのD1 Counterは作りません。
Policy、Grant、Delegated Source ACLは版付きSnapshotとしてTask開始時に取得し、Execution Leaseへ版を束縛します。
GatekeeperはLeaseを検証できるため、外部API実行前にPolicyをD1から再読込しません。

UsageはTokenやSubrequestごとの明細行を作らず、配置、Resource、課金期間の単位で集約します。
Delegated Principalだけは専用Quota Durable Objectで分離し、Task別利用量はTaskのCall CountとAudit Metadataから取得します。
有料処理は最大推定量を実行前に予約し、終了後に実績との差分を精算します。

各Conversationでは、最も早い実行予定に対して一つのAlarmだけを使います。

## 費用保護

既定値はCloudflareアカウントのHard Capではなく、個人利用向けの運用予算です。
Hard Limitを超える可能性がある処理は、開始前に拒否します。

- Public検索はRate Limiting BindingとCacheをQuotaより先に評価し、認証済み要求ではIP Addressではなく安定したPrincipal IDを使います。
- `search`はModelを呼ばず、`answer`だけがAI予算を消費します。
- Model Input、Output、検索件数、Tool Call数に要求単位の上限を設けます。
- Soft Limit到達後は検索だけに縮退するか、明示設定された低価格Providerを使います。
- Static Pluginを優先し、Dynamic PluginはContainer Memory、CPU、Diskを個別に予約します。
- Audit Checkpointは一日につき一つの決定的なR2 Object Keyを使います。
- Workers Logsへ本文を記録せず、SamplingとRedactionを適用します。

具体的な上限は[利用量と費用予算](../operations/resource-budgets.md)を参照してください。
