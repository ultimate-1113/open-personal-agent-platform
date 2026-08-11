# Google・GitHub Provider設定

[English](../../en/operations/connector-provider-setup.md)

この文書は、Google Personal ConnectorとGitHub Personal Connectorを実行するために外部管理画面で行う設定を定義します。
設定値は2026年8月11日時点の実装と公式仕様を基準にしています。
`<ASSISTANT_ORIGIN>`は、Owner UIを提供するAssistant WorkerのOriginへ置き換えてください。
stagingとproductionでは、OAuth Client、GitHub App、Credential、Callback URLを分離してください。

## 共通条件

Gatekeeper Workerは公開URLを持たず、Assistant WorkerからService Bindingで呼び出します。
OAuth CallbackだけをAssistant Workerが受け取り、検証済みAuthorization CodeをGatekeeperへ渡します。
Callback URLは末尾のパスを含めて完全一致させます。

| 設定 | 保存場所 | 機密情報 | 用途 |
| --- | --- | --- | --- |
| Provider Client ID | Gatekeeperの通常Variable | いいえ | OAuth Clientの公開識別子 |
| Provider Client Secret | GatekeeperのWorker Secret | はい | Authorization CodeとTokenの交換 |
| `CREDENTIAL_KEK` | GatekeeperのWorker Secret | はい | OAuth Tokenを包む32 byteの鍵暗号化鍵 |
| `CREDENTIAL_KEY_ID` | Gatekeeperの通常Variable | いいえ | Token暗号鍵の版識別子 |
| `EXECUTION_LEASE_PUBLIC_JWK` | Gatekeeperの通常Variable | いいえ | Policy Controlが署名したExecution Leaseの検証 |

`CREDENTIAL_KEK`とProvider Client Secretをリポジトリ、Version管理対象の`.dev.vars`、平文Variableへ保存しないでください。
`EXECUTION_LEASE_PUBLIC_JWK`は、Policy Control Workerが使用する署名秘密鍵と対応させてください。

## Google Cloud設定

### 1. ProjectとAPIを準備する

環境ごとにGoogle Cloud Projectを分けることを推奨します。
Google Cloud Consoleの「APIとサービス」で、次のAPIを有効にします。

- Gmail API
- Google Calendar API
- Google Drive API

### 2. OAuth同意画面を設定する

Google Auth PlatformでBranding、Audience、Data Accessを設定します。
Google Workspace組織内だけで使う場合は`Internal`を選べます。
個人Google Accountまたは組織外Accountで使う場合は`External`を選び、Testing中はOwnerのGoogle AccountをTest userへ追加します。
External Testingでは認可が7日後に失効するため、長期運用前にPublishing statusとGoogleの検証要件を確認してください。

Data Accessには、実装が要求する次のScopeを登録します。

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.owned
https://www.googleapis.com/auth/drive.readonly
```

Gmailの`gmail.readonly`と`gmail.compose`、Driveの`drive.readonly`はRestricted Scopeです。
公開運用、またはGoogle User DataをServerへ保存・転送する運用では、OAuth App Verificationや追加のSecurity Assessmentが必要になる場合があります。

### 3. OAuth Clientを作成する

Application typeは`Web application`を選びます。
Authorized redirect URIへ次の値を登録します。

```text
<ASSISTANT_ORIGIN>/v1/connections/google/callback
```

現在の実装はBrowserからGoogle APIを直接呼ばないため、Authorized JavaScript originsは不要です。
Redirect URIのScheme、Host、Path、末尾Slashは実際のCallbackと完全一致させてください。

### 4. Workerへ設定する

取得したClient IDをGoogle Gatekeeperの`GOOGLE_CLIENT_ID`通常Variableへ設定します。
Client Secretは次のようにSecretへ設定します。

```sh
wrangler secret put GOOGLE_CLIENT_SECRET --config <google-gatekeeper-config>
wrangler secret put CREDENTIAL_KEK --config <google-gatekeeper-config>
```

設定後にGatekeeperとAssistant Workerを配置し、Owner UIの接続画面からGoogleへ接続します。
Scopeを変更した場合は、既存Connectionを切断して再同意してください。

### Google機能とScope

| 機能 | Google API操作 | 必要Scope | 実行前承認 |
| --- | --- | --- | --- |
| Ownerの識別 | OpenID Connect、UserInfo email | `openid`、`userinfo.email` | 不要 |
| Gmail検索・一覧 | `users.messages.list` | `gmail.readonly` | Cloud送信時だけ必要 |
| Gmail本文取得 | `users.messages.get` | `gmail.readonly` | Cloud送信時だけ必要 |
| Gmail下書き作成 | `users.drafts.create` | `gmail.compose` | 常に必要 |
| Gmail送信 | `users.messages.send` | `gmail.compose` | 常に必要 |
| Calendar予定一覧 | `events.list` | `calendar.readonly` | Cloud送信時だけ必要 |
| Calendar予定作成 | `events.insert` | `calendar.events.owned` | 常に必要 |
| Drive検索・一覧 | `files.list` | `drive.readonly` | Cloud送信時だけ必要 |

読取結果をLocal Providerだけへ渡す場合、外部書込承認は不要です。
読取結果をWorkers AIへ送る場合、Ownerが今回の送信を承認するか、自動読取承認を選択している必要があります。
`secret`に分類された情報は、承認の有無にかかわらずモデルへ送信しません。

現在のDrive実装は`files.list`でメタデータだけを取得します。
現在の機能だけなら`drive.metadata.readonly`へ狭められる可能性がありますが、本文取得を追加する計画があるため`drive.readonly`を要求しています。
Drive本文取得を実装しないリリースでは、Scopeを狭める変更を検討してください。

## GitHub App設定

### 1. GitHub Appを作成する

Owner Accountまたは管理可能なOrganizationのDeveloper settingsからGitHub Appを作成します。
GitHub App nameはGitHub全体で一意な値にします。
Homepage URLにはRepositoryまたはProjectの公開URLを設定します。
Callback URLへ次の値を登録します。

```text
<ASSISTANT_ORIGIN>/v1/connections/github/callback
```

`Request user authorization (OAuth) during installation`は無効にし、Owner UIからStateとPKCEを生成して認可を開始します。
`Expire user authorization tokens`は有効のままにしてください。
Device Flow、Setup URL、Webhookは現在の実装で使用しません。
Webhookの`Active`を無効にし、Webhook URLとSecretは設定しないでください。

### 2. Repository Permissionを設定する

GitHub Appへ次のRepository Permissionを設定します。

- Contents: Read-only
- Issues: Read and write
- Pull requests: Read-only
- Metadata: Read-only（GitHubが自動付与）

Account、Organization、Enterprise Permissionは不要です。
Appは必要なRepositoryだけを選択してInstallしてください。
利用可能範囲は、Ownerの権限、GitHub App Permission、Installationで選択したRepositoryの積集合です。

### 3. OAuth Credentialを設定する

GitHub AppのClient IDをGitHub Gatekeeperの`GITHUB_CLIENT_ID`通常Variableへ設定します。
Client Secretを生成し、次のようにSecretへ設定します。

```sh
wrangler secret put GITHUB_CLIENT_SECRET --config <github-gatekeeper-config>
wrangler secret put CREDENTIAL_KEK --config <github-gatekeeper-config>
```

GitHub App IDとPrivate Keyは現在のUser Access Token実装では使用しません。
設定後にGatekeeperとAssistant Workerを配置し、Owner UIの接続画面からGitHubへ接続します。

### GitHub機能とPermission

| 機能 | GitHub API操作 | 必要Permission | 実行前承認 |
| --- | --- | --- | --- |
| Ownerの識別 | `GET /user` | User authorization | 不要 |
| Repository一覧 | `GET /user/repos` | Metadata: Read | Cloud送信時だけ必要 |
| Code検索 | `GET /search/code` | Contents: Read | Cloud送信時だけ必要 |
| Issue検索・受信箱 | `GET /search/issues`、`GET /issues` | Issues: Read | Cloud送信時だけ必要 |
| Pull Request一覧 | `GET /repos/{owner}/{repo}/pulls` | Pull requests: Read | Cloud送信時だけ必要 |
| Issue・Pull Requestコメント取得 | `GET /repos/{owner}/{repo}/issues/{number}/comments` | Issues: Read | Cloud送信時だけ必要 |
| Issue作成 | `POST /repos/{owner}/{repo}/issues` | Issues: Write | 常に必要 |
| Issue・Pull Requestコメント投稿 | `POST /repos/{owner}/{repo}/issues/{number}/comments` | Issues: Write | 常に必要 |

GitHub AppのOAuth要求では`scope`を空にします。
User Access Tokenの権限はOAuth Scopeではなく、App PermissionとInstallation範囲で制限します。
OrganizationがSAML SSOを使用している場合は、Ownerが有効なSAML Sessionを確立してから再接続する必要があります。

## 設定変更時の確認

Callback Hostを変更した場合は、Google OAuth Client、GitHub App、Cloudflare Access Application、Worker設定を同時に更新します。
新しいCallbackで接続を確認してから、古いCallbackを削除します。

Connector機能を追加または削除した場合は、次の項目を一つの変更として扱います。

1. Gatekeeperの要求ScopeまたはGitHub App Permission
2. Provider管理画面の設定
3. Capability Definitionと承認区分
4. Fake Serverを使う契約試験
5. この機能対応表
6. 既存Connectionの再同意またはInstallation Permission更新

Google Scopeを増やすときは、Data Accessと同意画面を更新し、既存Connectionを再同意させます。
GitHub App Permissionを増やすと、既存InstallationのOwnerによる追加承認が必要です。
追加承認が完了するまで、新しいPermissionを必要とする機能を利用可能として表示しないでください。

Client SecretをRotationするときは、新しいSecretをWorkerへ配置して動作確認してから古いSecretを失効させます。
OAuth Token暗号鍵をRotationするときは、既存Tokenを新しい鍵で再暗号化するか、Connectionを再同意させます。

公式仕様と管理画面はリリース時および毎月確認します。
確認時は、この文書の日付、Scope、Permission、Token有効期限、検証要件を更新します。

## 受入確認

- GoogleとGitHubで同じAccountを再接続してもConnectionが重複しない。
- GoogleでGmail一覧・本文、Calendar一覧、Drive一覧を取得できる。
- Gmail下書き・送信とCalendar予定作成が承認前に実行されない。
- GitHubでInstall対象Repository、Code、Issue、Pull Request、コメントを読み取れる。
- GitHub Issue作成とコメント投稿が承認前に実行されない。
- Install対象外Repositoryへの読取と書込を拒否する。
- ScopeまたはPermission不足を再接続が必要なエラーとして表示する。
- Provider Error、Audit、LogへTokenやResponse Bodyを保存しない。

## 参照

実装上の正本は、[Google Gatekeeper](../../../apps/google-gatekeeper/src/index.ts)、[Google Connector](../../../packages/google-connector/src/index.ts)、[GitHub Gatekeeper](../../../apps/github-gatekeeper/src/index.ts)、[GitHub Connector](../../../packages/github-connector/src/index.ts)です。

- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)
- [Google OAuth Web Server Flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth Policy](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google OAuth App Verification](https://support.google.com/cloud/answer/13461325?hl=en)
- [Google OAuth Audience and Test Users](https://support.google.com/cloud/answer/15549945?hl=en)
- [Gmail OAuth Scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Calendar Authorization](https://developers.google.com/workspace/calendar/api/auth)
- [Google Drive OAuth Scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Choosing GitHub App Permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Generating a GitHub App User Access Token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing GitHub App User Access Tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub App REST Permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
