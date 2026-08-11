# Identity設定

## Owner

Assistant WorkerをCloudflare Accessで保護し、次の値を配置環境ごとに設定します。

- `OWNER_EMAIL`: 初回Bootstrapを許可するOwnerのメールアドレス
- `ACCESS_ISSUER`: Access JWTのIssuer
- `ACCESS_AUDIENCE`: Access ApplicationのAudience
- `ACCESS_JWKS_URI`: 対象Access Teamの`/cdn-cgi/access/certs`

初回成功後はメールアドレスではなく、署名検証済みJWTのIssuerとSubjectでOwnerを識別します。

メールアドレスと生のSubjectはD1へ保存しません。

`wrangler.jsonc`の値は開発用Placeholderなので、本番配置前に必ず置換します。

## Delegated OIDC

Delegated Workerには許可するIssuer、Audience、固定JWKS URIを設定します。

JWT ClaimからJWKS URIを導出してはいけません。

Delegated Principal IDのHMAC鍵は平文の`vars`へ追加せず、次のWorker Secretとして登録します。

```bash
wrangler secret put DELEGATED_PRINCIPAL_HMAC_SECRET --config apps/delegated-agent-api/wrangler.jsonc
```

SourceはControl D1の`delegated_sources`へResource ID AllowlistとACLを明示登録します。

未登録Source、無効Source、空のResource Allowlist、不正なACL、未検証メールClaimは拒否されます。

## Route

`policy-control-worker`、`conversation-agent`、`quota-worker`へ公開Routeを設定しません。

Assistantの本番RouteはAccess Applicationの背後にだけ配置します。

Delegated APIの本番RouteはOIDC設定完了後に有効化します。
