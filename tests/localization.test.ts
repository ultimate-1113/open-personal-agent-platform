import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../apps/owner-ui/src/locales/en.js";
import { ja } from "../apps/owner-ui/src/locales/ja.js";

const repositoryRoot = resolve(import.meta.dirname, "..");

const ignoredDirectories = new Set([".git", ".pnpm-store", ".wrangler", "coverage", "node_modules"]);

const filesBelow = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });

describe("localization contract", () => {
  it("keeps the English and Japanese UI catalogs in exact key parity", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps matching English and Japanese documentation paths", () => {
    const localizedPaths = (locale: "en" | "ja") =>
      filesBelow(resolve(repositoryRoot, "docs", locale))
        .filter((file) => file.endsWith(".md"))
        .map((file) => relative(resolve(repositoryRoot, "docs", locale), file))
        .sort();

    expect(localizedPaths("ja")).toEqual(localizedPaths("en"));
  });

  it("keeps every local Markdown link resolvable", () => {
    const markdownFiles = filesBelow(repositoryRoot).filter((file) => file.endsWith(".md"));
    const brokenLinks: string[] = [];

    for (const file of markdownFiles) {
      const markdown = readFileSync(file, "utf8");
      for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]?.split("#", 1)[0];
        if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
        const decodedTarget = decodeURIComponent(target.replace(/^<|>$/g, ""));
        if (!existsSync(resolve(dirname(file), decodedTarget))) {
          brokenLinks.push(`${relative(repositoryRoot, file)} -> ${target}`);
        }
      }
    }

    expect(brokenLinks).toEqual([]);
  });

  it("uses shared theme tokens and exposes both themes", () => {
    const styles = readFileSync(resolve(repositoryRoot, "apps/owner-ui/src/styles.css"), "utf8");
    const app = readFileSync(resolve(repositoryRoot, "apps/owner-ui/src/App.tsx"), "utf8");

    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain("--surface:");
    expect(app).toContain('role="switch"');
    expect(app).toContain("useTheme()");
  });
});
