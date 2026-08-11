# 多言語対応

[English](../../en/contributing/localization.md)

## UI

`apps/owner-ui/src/locales/en.ts`を基準Catalogとします。
ほかのCatalogは`LocaleCatalog` Typeを満たす必要があり、Keyの不足と過剰はTypeScript Errorになります。
Componentは`t("key")`を使い、利用者向けの文章を直接埋め込みません。

Localeを追加するときは、次の手順を実行します。

1. `LocaleCatalog`を満たすCatalogを追加します。
2. `i18n.ts`の`supportedLocales`と`catalogs`へLocale Codeを追加します。
3. すべてのCatalogへ言語名を追加します。
4. 多言語Testを拡張し、Desktop幅とMobile幅で表示を確認します。

選択したLocaleは`opap.locale`へ保存します。
保存値がない場合、日本語のBrowser Localeでは日本語を使い、それ以外では英語を使います。

## Theme

Theme Tokenは`styles.css`のCSS Custom Propertyとして定義します。
ComponentはTheme固有の色を直接指定せず、このTokenを使います。
選択したThemeは`opap.theme`へ保存し、保存値がない場合はOS設定を使います。

## 文書

英語文書は`docs/en`、日本語文書は`docs/ja`へ、同じ相対Pathで配置します。
各文書はTitleの直後から対応する翻訳へLinkします。
Repository Rootの文書は英語版を既定とし、日本語版へ`.ja.md`を付けます。

Pull Requestで文書の意味を変更するときは、同じ変更内で両言語を更新します。
CIはPathの対応とLocal Markdown Linkを検査します。
