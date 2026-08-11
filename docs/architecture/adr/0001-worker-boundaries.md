# ADR 0001 Worker境界

## 状態

Accepted

## 決定

Assistant、Public、Delegated、Control、Gatekeeperを別Workerとして配置します。

認可コードだけに依存せず、Bindingの不在によってPublic PlaneからPrivate資源へ到達できない構成にします。

## 帰結

デプロイ対象は増えますが、資格情報とPrivate Memoryの漏えい経路を構成段階で削減できます。
