# 脅威モデル

[English](../../en/security/threat-model.md)

## 保護対象

- OAuth Token、API Key、署名鍵
- OwnerのConversation、Memory、Mail、Event、Document
- Delegated PrincipalごとのResource Scope
- Approval Record、Audit History、Plugin Artifact

## 主な脅威

- Public WorkerのBinding誤設定によるPrivate Resourceへの到達
- Prompt Injectionによる権限昇格とConfused Deputy
- 承認後のInput差し替え、Lease Replay、外部書込の重複
- Delegated Principal間のCache、Quota、検索結果の混同
- 悪意あるPluginによるSecret取得、外向き通信、Resource枯渇
- Log、Exception、Telemetryを通じた個人Dataの漏えい

## 防御

- WorkerとBindingを物理的に分離します。
- Tool実行時にGatekeeperで認可を再検証します。
- Execution LeaseをRequest Digest、Principal、Capability、Expiration、Nonceへ束縛します。
- Delegated Cache KeyへIssuer、Subject、Source IDを含めます。
- Plugin SandboxのInternet接続とSecret注入を無効にします。
- Audit Logへ本文、Prompt、Tokenを保存しません。

## 対象外

Cloudflareアカウント自体が侵害された後の完全な保護は保証しません。
Hash Chainは改変検出を補助しますが、外部の独立した公証ではありません。
