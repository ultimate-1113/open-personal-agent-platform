import { useCallback, useEffect, useState } from "react";
import { en, type MessageKey } from "./locales/en.js";
import { ja } from "./locales/ja.js";

export type Locale = "en" | "ja";
export const supportedLocales = ["en", "ja"] as const;
export const catalogs = { en, ja } as const;

export const isLocale = (value: unknown): value is Locale =>
  value !== null && supportedLocales.some((locale) => locale === value);

export type Translate = (
  key: MessageKey,
  variables?: Readonly<Record<string, string | number>>,
) => string;

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>("ja");

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const t = useCallback<Translate>((key, variables) => {
    let message: string = catalogs[locale][key];
    for (const [name, value] of Object.entries(variables ?? {})) {
      message = message.replaceAll(`{{${name}}}`, String(value));
    }
    return message;
  }, [locale]);

  return { locale, setLocale, t } as const;
}
