# OPAP Text Utilities Dynamic Plugin

This reviewable example plugin counts Unicode characters, lines, and whitespace-delimited words.

- It requests no capabilities.
- It performs no network access.
- It reads no secrets.
- It exports one tool: `text.utilities.stats`.

Build the uploadable archive with `pnpm --filter @opap/example-dynamic-plugin-text-utilities build`.
The resulting `.tgz` is written to `dist/opap-text-utilities-0.1.0.tgz` and is validated by OPAP's own archive inspector before the build succeeds.
