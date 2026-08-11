# Identity設定

[English](../../en/operations/identity-configuration.md)

## Owner

Assistant WorkerをCloudflare Accessで保護し、環境ごとに次の値を設定します。

- `OWNER_EMAIL`: 最初のBootstrapを許可するOwnerのEmail Address
- `ACCESS_ISSUER`: Access JWTのIssuer
- `ACCESS_AUDIENCE`: Access ApplicationのAudience
- `ACCESS_JWKS_URI`: 対象Access Teamの`/cdn-cgi/access/certs`

最初のBootstrap成功後は、Email Addressではなく、検証済みJWTのIssuerとSubjectでOwnerを識別します。
Email Addressと生のSubjectはD1へ保存しません。
Commit済み`wrangler.jsonc`の値は開発用Placeholderであるため、本番配置前に置き換えます。

## Delegated OIDC

Delegated Workerには許可するIssuer、Audience、固定JWKS URIを設定します。
信頼できないJWT ClaimからJWKS URIを導出してはいけません。

Delegated Principal IDのHMAC Keyは平文Variableではなく、Worker Secretとして保存します。

```bash
wrangler secret put DELEGATED_PRINCIPAL_HMAC_SECRET --config apps/delegated-agent-api/wrangler.jsonc
```

各Sourceは明示的なResource ID AllowlistとACLを設定してControl D1へ登録します。
未登録または無効なSource、空のResource Allowlist、不正なACL、未検証のEmail Claimは拒否します。

## Route

`policy-control-worker`、`conversation-agent`、`quota-worker`へ公開Routeを設定しません。
本番Assistant RouteはAccess Applicationの背後へ配置します。
Delegated APIの本番RouteはOIDC設定後に有効化します。
