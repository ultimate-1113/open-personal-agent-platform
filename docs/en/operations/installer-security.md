# Auditing the OPAP Setup Wizard

Alpha artifacts may be unsigned. A Windows release is signed only when the release workflow has its Windows certificate secrets, and a macOS public release is signed and notarized only when all Apple credentials are configured. The Audit tab reports the actual artifact state. Source availability does not by itself prove that a downloaded executable is safe. Verify the artifact before running it, review the planned operations in the Audit tab, and use a test deployment name first.

Release signing credentials are supplied only through GitHub Actions secrets (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`). They are never stored in the repository or deployment bundle.

For GitHub, the Installer can create a private App from the source-controlled manifest. It opens GitHub in the system browser, validates a random callback state on a loopback-only listener, exchanges the one-hour manifest code directly with `api.github.com`, and stores the returned client secret, private key, and webhook secret in the local Secret Vault. The renderer receives only the App label. JSON import remains available for an existing App.

## Verify before launch

Download the installer, `SHA256SUMS`, the matching verification script, the SBOM, and `release.json` from the same release. Run one of:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 .\SHA256SUMS
```

```sh
sh ./verify.sh ./SHA256SUMS
```

When GitHub CLI is available, also verify build provenance:

```text
gh attestation verify <artifact> -R ultimate-1113/open-personal-agent-platform
```

An attestation identifies the source and workflow that produced an artifact. It does not establish that the source code itself is safe.

## Secret lifecycle

Generated platform secrets never enter the Electron renderer. The main process stores them with Windows DPAPI, macOS Keychain, or Linux Secret Service. Linux `basic_text` storage is refused. If protected OS storage is unavailable, the installer requires a recovery passphrase and stores only Argon2id/AES-256-GCM ciphertext.

Temporary Cloudflare secret files are restricted to the current user, use random names, and are removed after deployment and on recovery from an interrupted run. Secret values, authorization headers, OAuth codes, JWTs, prompts, connector content, and process environments are excluded from logs and the installation ledger.

Optional provider credentials are imported from JSON only after the local vault is initialized. Google accepts the standard `client_secret.json`. GitHub accepts `{ "clientId": "...", "clientSecret": "...", "appName": "..." }`. Discord accepts `{ "applicationId": "...", "publicKey": "...", "botToken": "..." }`. Only the main process reads these files and the screen receives a non-secret label.

Owner email, Access Team Domain, Access Audience, Owner time zone, and AI Gateway ID are reviewed configuration values. The Access issuer and JWKS URL are derived from the Team Domain.

## Network and ownership

The Audit tab lists every allowed destination and planned operation. Plain HTTP is refused except for loopback OAuth callbacks. Existing Access team domains, Tunnels, applications, and policies are not changed. Removal operates only on resources recorded as installer-created in the installation ledger; external Google and GitHub applications require explicit confirmation in their provider consoles.

Telemetry, analytics, crash uploads, and crash dumps are disabled by default.
