# OPAP Text Utilities 動的Plugin

Unicode文字数、行数、空白区切りの単語数を数える、内容を確認しやすいサンプルPluginです。

- Capabilityを要求しません。
- 外部通信を行いません。
- Secretを読み取りません。
- `text.utilities.stats` Toolを一つ提供します。

`pnpm --filter @opap/example-dynamic-plugin-text-utilities build`でアップロード用Archiveを作成します。

生成物は`dist/opap-text-utilities-0.1.0.tgz`です。
Build時にはOPAP自身のArchive InspectorでManifest、ESM Bundle Digest、SBOMを検証します。
