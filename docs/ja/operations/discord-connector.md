# Discord Connector

[English](../../en/operations/discord-connector.md)

Discord Connectorは、Cloudflare上のHTTP Interactionを正式経路として使用します。
Slash CommandはMac miniなどの常時稼働機を必要としません。
通常のBot DMは、実験的なGateway Bridgeを有効にした配置だけで利用できます。

## Worker境界

公開Discord Adapterは`POST /interactions`、`POST /gateway-events`、`GET /health`だけを提供します。
AdapterはDiscord署名、Bridge署名、本文サイズ、時刻差、重複IDを検証します。
AdapterはControl D1、Conversation Durable Object、Connector、AI、Bot Tokenへ直接接続しません。
Owner照合とApplication Service呼出しはAssistant Workerの`DiscordEntrypoint`が担当します。
Discord APIへの書込とBot Tokenは非公開Discord Gatekeeperへ隔離します。

## Developer Portal

Developer Portalには次の値を設定します。

- Public BotはOFFにします。
- Requires OAuth2 Code GrantはOFFにします。
- Presence IntentはOFFにします。
- Server Members IntentはOFFにします。
- Message Content IntentはGateway Bridgeを使う場合だけONにします。
- Install LinkはNoneにします。
- User InstallとGuild Installを有効にします。
- Interaction Endpoint URLは`https://opap-discord-staging.lfantian708.workers.dev/interactions`にします。

User InstallのScopeは`applications.commands`です。
Guild InstallのScopeは`applications.commands bot`です。
Guild Bot PermissionはView Channels、Send Messages、Embed Linksだけです。
Permission Integerは`19456`です。

## staging配置

次の順序で配置します。

1. Control D1へ`migrations/control/0004_discord_links.sql`を適用します。
2. Discord Gatekeeper D1へ`migrations/discord-gatekeeper/0001_initial.sql`を適用します。
3. Discord Gatekeeperへ`DISCORD_BOT_TOKEN`をWorker Secretとして設定します。
4. Discord Gatekeeper、Assistant Worker、Discord Adapterの順に配置します。
5. Developer PortalへInteraction Endpoint URLを保存します。
6. Owner UIでDiscord Commandを同期します。
7. User Installを実行します。
8. Owner UIでリンクコードを生成し、Bot DMで`/link code:<code>`を実行します。

Bot Tokenはチャット、追跡対象の設定ファイル、通常Variableへ貼り付けません。
`.dev.vars.example`を`.dev.vars`へコピーし、`DISCORD_BOT_TOKEN`へ値を設定します。
`.dev.vars`はGitの追跡対象外です。
次のコマンドは`.dev.vars`を読み取り、値を表示せずWorker Secretへ登録します。

```powershell
pnpm run secret:discord:staging
```

Gateway Bridgeを有効にする場合はAdapterにも署名鍵を設定します。

`DISCORD_BRIDGE_SIGNING_KEY`も`.dev.vars`へ設定し、`scripts/register-discord-staging-secrets.ps1 -IncludeBridge`を実行します。

## Commandと承認

`/agent`はWeb UIと同じConversation Durable Objectへ書き込みます。
`/tasks`、`/approvals`、`/audit`もWeb UIと同じApplication Serviceを利用します。
Guild内の応答は既定でephemeralです。
新しいGuild Channelを通知先へ登録する`/notify-here`は承認を必要とします。
`/notify-off-here`は確認後、現在のGuild Channelだけを通知先から解除します。
自動通知はReview Buttonだけを表示し、Review後のephemeral応答で承認または拒否を選びます。
`secret`情報はDM、Guild Channel、ログへ送信しません。

## Gateway Bridge

`apps/discord-gateway-bridge`はNode.js 24で動作します。
Bridgeはリンク済みOwnerからBot DMへ届いた本文だけをCloudflareへ転送します。
Guild Message、Group DM、Attachment、Bot Messageは転送しません。
Bridgeは外向き通信だけを使うため、Cloudflare TunnelとWorkers VPCは不要です。
`deployments/macos/com.opap.discord-gateway-bridge.plist`はlaunchdの設定例です。
この機能は実機未検証であり、v0.1の完成条件には含めません。

## 費用と保持

Interaction ID、Gateway Message ID、Bridge NonceはSQLite-backed Durable Objectへ24時間だけ保持します。
Interaction Tokenは永続化しません。
会話本文は既存Conversation Durable Objectだけへ保存します。
失敗時だけ通知OutboxをD1へ保存し、429ではDiscordの`retry_after`を尊重します。
通信切断で結果が不明な書込は`unknown`とし、無条件に再送しません。
