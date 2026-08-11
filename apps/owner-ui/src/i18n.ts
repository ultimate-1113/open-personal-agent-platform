import { useCallback, useEffect, useState } from "react";
import { en, type MessageKey } from "./locales/en.js";
import { ja } from "./locales/ja.js";

export type Locale = "en" | "ja";
export const supportedLocales = ["en", "ja"] as const;
export const catalogs = { en, ja } as const;

const storageKey = "opap.locale";

const isLocale = (value: string | null): value is Locale =>
  value !== null && supportedLocales.some((locale) => locale === value);

const initialLocale = (): Locale => {
  const stored = localStorage.getItem(storageKey);
  if (isLocale(stored)) return stored;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
};

export type Translate = (
  key: MessageKey,
  variables?: Readonly<Record<string, string | number>>,
) => string;

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    localStorage.setItem(storageKey, nextLocale);
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
