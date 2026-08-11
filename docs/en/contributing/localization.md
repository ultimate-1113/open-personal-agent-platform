# Localization

[日本語](../../ja/contributing/localization.md)

## UI

English is the source catalog in `apps/owner-ui/src/locales/en.ts`.
Every other catalog must satisfy its `LocaleCatalog` type, so a missing or extra key fails TypeScript.
Components use `t("key")` and do not embed user-facing prose.

To add a locale:

1. Add a catalog that satisfies `LocaleCatalog`.
2. Add its code to `supportedLocales` and `catalogs` in `i18n.ts`.
3. Add the language name to every catalog.
4. Extend localization tests and perform a visual check at desktop and mobile widths.

The selected locale is stored as `opap.locale`.
Without a stored choice, Japanese browser locales use Japanese and all others use English.

## Theme

Theme tokens are CSS custom properties in `styles.css`.
Components must use those tokens rather than raw theme-specific colors.
The selected theme is stored as `opap.theme`; otherwise the OS preference is used.

## Documentation

English documents live under `docs/en` and Japanese documents under `docs/ja`, with identical relative paths.
Each document links to its counterpart below the title.
Root project files use an English default and a `.ja.md` Japanese counterpart.

When a pull request changes meaning, update both languages in the same change.
CI checks path parity and local Markdown links.
