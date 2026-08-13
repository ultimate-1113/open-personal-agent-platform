# Owner操作面

[English](../../en/operations/owner-surface.md)

Owner UIはAssistant Workerと同じOriginから配信します。
Cloudflare Accessを必須の外側境界とし、すべての`/v1` EndpointでAccess JWTを再検証します。

UIはConversation、Task、Structured Memory、Approval、Audit、Model Provider、Budgetを提供します。
日本語と英語、設定を保持するライトテーマとダークテーマに対応します。
選択中のConversation ID、Locale、ThemeだけをBrowser Local Storageへ保存します。
Message、Memory、Approval Content、Audit HistoryはBrowserへ永続保存しません。

Task、Memory、Messageの書込はOwner Stateful Operation Quotaを予約してからConversation Durable Objectへ保存し、終了後に実績を精算します。
Taskは一回、毎日、指定曜日、毎月のいずれかをIANAタイムゾーン付きで指定できます。
チャット画面やDiscordを開いておく必要はありません。Conversation Durable Objectが最も近いTask用のAlarmを一つだけ保持し、予定時刻にAssistant Workerを呼び出します。
Taskの要求と結果を永続的な文脈へ残すため、各TaskはConversationに属します。会話を始める前にTaskを作成した場合は、その文脈を自動的に作成します。
実行時刻を逃した繰り返し分をまとめて再生せず、結果が不明または失敗した一回Taskも自動再試行しません。
ApprovalはControl D1へ保存し、各判断をIdempotency Keyへ束縛します。
Approvalの作成と判断は配置単位のAudit Ledgerへ同期追記します。

Budget設定はControl D1へ保存してAudit Eventを記録します。
Usage画面はOwner Quota Durable Objectの期間Rollupを読み取り、通常、縮退、停止の状態を表示します。

Model Routerの既定経路は`MockLocalProvider`です。
`WorkersAiProvider`はAI Gateway経路、Payload Logging無効化、Output Token上限、Destination評価を強制します。
Workers AIはOwnerが`owner`かつ`normal`のData送信を明示的に許可した場合だけ選択できます。
生成前に日次無料Neuronと月次超過予算を原子的に予約し、終了後に保守的な実績値へ精算します。
Gateway拒否またはWorkers AI停止時も、別Providerへ自動Fallbackしません。
