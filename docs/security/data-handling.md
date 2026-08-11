# データ処理方針

外部サービスを正本とし、本文の恒久複製を既定では行いません。

Observationには取得元ID、内容ダイジェスト、Information Policy、派生関係だけを保存します。

OwnerのObservationはConversation Durable Objectへ保存し、Public検索では要求ごとのObservation永続化を行いません。

Delegated検索は結果単位のD1書込を行わず、必要な拒否イベントと集約利用量だけを記録します。

会話とStructured Memoryは所有者が削除するまで保持します。

承認と監査メタデータは既定180日、Pluginログは7日、一時成果物は24日ではなく24時間保持します。

OAuth TokenはGatekeeper内でEnvelope Encryptionし、モデル、Plugin、一般ログへ渡しません。
