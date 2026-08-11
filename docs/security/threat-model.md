# 脅威モデル

## 保護対象

- OAuth Token、API Key、署名鍵。
- 所有者の会話、Memory、メール、予定、文書。
- Delegated PrincipalごとのResource Scope。
- 承認内容、監査履歴、Plugin配布物。

## 主な脅威

- Public WorkerのBinding誤設定によるPrivate資源への到達。
- Prompt Injectionによる権限昇格とConfused Deputy。
- 承認後の入力差替え、Lease Replay、重複した外部書込。
- Delegated Principal間のCache、Quota、検索結果の混同。
- 悪意あるPluginによるSecret取得、外向き通信、資源枯渇。
- ログ、例外、Telemetryを通じた個人データ漏えい。

## 防御

- WorkerとBindingを物理的に分離します。
- Tool実行時にGatekeeperで認可を再検証します。
- Execution Leaseを要求ダイジェスト、Principal、Capability、期限、Nonceへ束縛します。
- Cache KeyへIssuer、Subject、Source IDを含めます。
- Plugin Sandboxのインターネット接続とSecret注入を無効にします。
- 監査ログへ本文、Prompt、Tokenを保存しません。

## 非目標

Cloudflareアカウント自体が侵害された場合の完全な保護は保証しません。

ハッシュチェーンは改変検出を補助しますが、外部の独立した公証を提供しません。
