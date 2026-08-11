import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const storageKey = "opap.theme";

const isTheme = (value: string | null): value is Theme =>
  value === "light" || value === "dark";

const initialTheme = (): Theme => {
  const stored = localStorage.getItem(storageKey);
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#111714" : "#f4f7f4");
  }, [theme]);

  const setTheme = useCallback((nextTheme: Theme) => {
    localStorage.setItem(storageKey, nextTheme);
    setThemeState(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  return { theme, setTheme, toggleTheme } as const;
}
