# Identity configuration

[日本語](../../ja/operations/identity-configuration.md)

## Owner

Protect the Assistant Worker with Cloudflare Access and configure these values for each environment:

- `OWNER_EMAIL`: owner email allowed to perform the first bootstrap
- `ACCESS_ISSUER`: Access JWT issuer
- `ACCESS_AUDIENCE`: Access application audience
- `ACCESS_JWKS_URI`: `/cdn-cgi/access/certs` for the selected Access team

After the first successful bootstrap, identity uses the verified JWT issuer and subject rather than email.
Neither the email address nor raw subject is stored in D1.
Values in committed `wrangler.jsonc` files are development placeholders and must be replaced before production deployment.

## Delegated OIDC

Configure an allowlisted issuer, audience, and fixed JWKS URI on the Delegated Worker.
Never derive a JWKS URI from an untrusted JWT claim.

Store the delegated principal HMAC key as a Worker secret, not a plaintext variable:

```bash
wrangler secret put DELEGATED_PRINCIPAL_HMAC_SECRET --config apps/delegated-agent-api/wrangler.jsonc
```

Register each source in Control D1 with an explicit resource ID allowlist and ACL.
Unregistered or disabled sources, empty resource allowlists, invalid ACLs, and unverified email claims are denied.

## Routes

Do not configure public routes for `policy-control-worker`, `conversation-agent`, or `quota-worker`.
Place the production Assistant route behind its Access application.
Enable the Delegated API production route only after OIDC configuration is complete.
