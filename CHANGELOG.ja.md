# 変更履歴

Open Personal Agent Platformの主な変更を記録します。

## [0.1.0-alpha.1] - 2026-08-13

### 追加

- Gmail、Calendar、Driveを扱うGoogle Personal Connectorと、承認付きGmail・Calendar書込。
- Repository読取、Issue作成、IssueまたはPull RequestへのComment投稿を行うGitHub App Connector。
- Discord HTTP Interaction Adapter、非公開Gatekeeper、Owner Link、Slash Command、通知先、通常DM用の実験的Gateway Bridge。
- OwnerがTime Zoneを設定できる一回限りTaskと繰り返しTask。
- Owner UIとDiscord DMの双方向Chat同期。
- 結果が`unknown`になった外部書込の明示的な照合。
- OAuth Credential、D1、Resource Allowlistを分離した読取専用Delegated Source Gatekeeper。
- 配置時のExecution Lease公開鍵整合性検査。

### 変更

- Connector Tool選択、承認Review、結果整形、Chat表示順を改善。
- Approval Filter、実行状態表示、Task・Memory編集、承認Modeの保存、Enter送信を追加。
- OAuth Refreshが拒否されたConnectionを再同意待ちにし、広いCredentialへFallbackしないよう変更。
- Phase 3の境界とstaging手順を日英資料へ反映。

### 既知の制約

- Delegated SourceのQuery・ACL接続はPhase 4で実装します。
- Discord Gateway Bridgeは実験機能であり、Mac mini実機では未検証です。
- このAlpha版は本番SLAと長期API互換保証を提供しません。

## [0.1.0-alpha.0] - 2026-08-11

- Phase 2のOwner縦断機能と費用制御を含む初回公開Alpha。
