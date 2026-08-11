# ADR 0001: Worker境界

[English](../../../en/architecture/adr/0001-worker-boundaries.md)

## 状態

Accepted

## 決定

Assistant、Public、Delegated、Control、Gatekeeperを別Workerとして配置します。
認可コードだけに依存せず、Bindingが存在しない構成によってPublic PlaneからPrivate Resourceへの到達を防ぎます。

## 帰結

配置するComponentは増えますが、CredentialとPrivate Memoryの漏えい経路を構成段階で削減できます。
