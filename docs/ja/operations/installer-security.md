# OPAPセットアップウィザードの監査

Alpha成果物は未署名の場合があります。Windows版はRelease Workflowへ証明書が設定された場合だけ署名し、macOS一般配布版はApple資格情報がすべて設定された場合だけ署名と公証を行います。実際の状態はInstallerの監査画面で確認できます。Sourceが公開されているだけでは、Downloadした実行Fileの安全性は証明されません。起動前にArtifactを検証し、最初は試験用の配置名を使用してください。

署名資格情報はGitHub Actions Secretからだけ渡し、RepositoryやDeployment Bundleへ保存しません。

GitHubは、Source管理された固定Manifestから非公開Appを作成できます。InstallerはSystem BrowserでGitHubを開き、Loopback専用Listenerで乱数Stateを検証し、Manifest Codeを`api.github.com`と直接交換します。返されたClient Secret、Private Key、Webhook SecretはSecret Vaultへ保存し、RendererへはAppの表示名だけを返します。既存App用のJSON取込も残します。

## 起動前の検証

同じReleaseからInstaller、`SHA256SUMS`、対応する検証Script、SBOM、`release.json`をDownloadします。次のどちらかを実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 .\SHA256SUMS
```

```sh
sh ./verify.sh ./SHA256SUMS
```

GitHub CLIが利用できる場合はBuild Provenanceも確認します。

```text
gh attestation verify <artifact> -R ultimate-1113/open-personal-agent-platform
```

Attestationが示すのはArtifactを作成したSourceとWorkflowです。Source Code自体の安全性を保証するものではありません。

## Secretの処理

自動生成したPlatform SecretはElectron Rendererへ渡しません。Main ProcessがWindows DPAPI、macOS Keychain、Linux Secret Serviceを使用して保存します。Linuxの`basic_text`保存は拒否します。OS保護を利用できない場合は回復Passphraseを要求し、Argon2idとAES-256-GCMで暗号化した値だけを保存します。

Cloudflare登録用の一時Fileは現在の利用者だけが読める権限と無作為なFile名で作成し、配置後または中断からの回復時に削除します。Secret値、Authorization Header、OAuth Code、JWT、Prompt、Connector本文、Process環境変数はLogとInstallation Ledgerへ含めません。

任意Providerの資格情報はLocal Vault初期化後にJSONから取り込みます。Googleは標準の`client_secret.json`、GitHubは`{ "clientId": "...", "clientSecret": "...", "appName": "..." }`、Discordは`{ "applicationId": "...", "publicKey": "...", "botToken": "..." }`を受け付けます。Main ProcessだけがFileを読み、画面にはSecretではない識別表示だけを返します。

Ownerメール、Access Team Domain、Access Audience、Owner Time Zone、AI Gateway IDは配置前に確認する設定値です。Access IssuerとJWKS URLはTeam Domainから導出します。

## 通信と所有範囲

監査画面には許可された通信先と予定操作をすべて表示します。Loopback OAuth Callback以外のHTTP通信は拒否します。既存のAccess Team Domain、Tunnel、Application、Policyは変更しません。削除対象はInstallation LedgerでInstaller作成済みと記録された資源だけです。外部のGoogle ApplicationとGitHub Appは各Provider画面で明示的に確認します。

Telemetry、Analytics、Crash Upload、Crash Dumpは既定で無効です。
