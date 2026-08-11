# データ処理方針

[English](../../en/security/data-handling.md)

外部Serviceを正本とし、本文を既定では恒久複製しません。
ObservationにはSource ID、Content Digest、Information Policy、派生関係だけを保存します。

OwnerのObservationはConversation Durable Objectへ保存します。
Public検索は要求ごとのObservationを永続化せず、Delegated検索は結果ごとのD1行を書きません。
必要な拒否Eventと集約利用量だけを記録します。

ConversationとStructured MemoryはOwnerが削除するまで保持します。
ApprovalとAudit Metadataは既定180日、Plugin Logは7日、一時Artifactは24時間保持します。

OAuth TokenはGatekeeper内でEnvelope Encryptionし、Model、Plugin、一般Logへ渡しません。
