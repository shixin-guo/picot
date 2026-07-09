import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const publicDir = resolve(import.meta.dirname);
const en = JSON.parse(readFileSync(resolve(publicDir, "locales/en.json"), "utf-8"));
const zh = JSON.parse(readFileSync(resolve(publicDir, "locales/zh.json"), "utf-8"));

// ── Flatten helpers ───────────────────────────────────────────────────

function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const enKeys = new Set(flattenKeys(en));
const zhKeys = new Set(flattenKeys(zh));

// ── Key parity ────────────────────────────────────────────────────────

describe("locale key parity", () => {
  it("zh contains every en key", () => {
    const missing = [...enKeys].filter((k) => !zhKeys.has(k));
    expect(missing, `zh.json missing keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("en contains every zh key (no extra zh keys)", () => {
    const extra = [...zhKeys].filter((k) => !enKeys.has(k));
    expect(extra, `zh.json has extra keys not in en.json: ${extra.join(", ")}`).toEqual([]);
  });

  it("every locale value is a non-empty string or nested plain object", () => {
    const checkValues = (obj, path = "") => {
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          checkValues(v, p);
        } else if (typeof v === "string") {
          expect(v.length, `empty string at ${p}`).toBeGreaterThan(0);
        } else {
          throw new Error(`non-string, non-object value at ${p}: ${typeof v}`);
        }
      }
    };
    checkValues(en);
    checkValues(zh);
  });
});

// ── HTML key references ───────────────────────────────────────────────

describe("HTML data-i18n key references", () => {
  const htmlFiles = ["index.html", "bootstrap.html"];

  for (const file of htmlFiles) {
    it(`${file} references only keys that exist in en.json`, () => {
      const content = readFileSync(resolve(publicDir, file), "utf-8");
      const attrs = ["data-i18n", "data-i18n-ph", "data-i18n-title", "data-i18n-aria-label"];
      const referenced = new Set();

      for (const attr of attrs) {
        const regex = new RegExp(`${attr}="([^"]+)"`, "g");
        let match;

        for (;;) {
          match = regex.exec(content);
          if (!match) break;
          referenced.add(match[1]);
        }
      }

      const missing = [...referenced].filter((k) => !enKeys.has(k));
      expect(missing, `${file} references missing keys: ${missing.join(", ")}`).toEqual([]);
    });
  }
});

// ── JS literal t() key references ─────────────────────────────────────

describe("JS t() literal key references", () => {
  // Phase 1 JS files that should use t()
  const jsFiles = [
    "app.js",
    "message-renderer.js",
    "markdown.js",
    "tool-card.js",
    "file-browser.js",
    "folder-picker.js",
    "dialogs.js",
    "app-updater.js",
    "app-voice-input.js",
    "session-sidebar.js",
    "app-settings-editors.js",
    "app-settings-toggles.js",
    "settings-save-status.js",
    "package-install-status.js",
    "workspace-actions.js",
    "onboarding-state.js",
  ];

  it("every literal t(\"...\") / t('...') key exists in en.json", () => {
    const referenced = new Set();

    for (const file of jsFiles) {
      let content;
      try {
        content = readFileSync(resolve(publicDir, file), "utf-8");
      } catch {
        continue; // file may not exist yet
      }
      // Match t("key.path") and t('key.path')
      const regex = /\bt\(\s*["']([^"']+)["']/g;
      let match;

      for (;;) {
        match = regex.exec(content);
        if (!match) break;
        referenced.add(match[1]);
      }
    }

    const missing = [...referenced].filter((k) => !enKeys.has(k));
    expect(missing, `t() references missing keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("no raw t() output in innerHTML/insertAdjacentHTML/template without escapeHtml", () => {
    const violations = [];

    for (const file of jsFiles) {
      let content;
      try {
        content = readFileSync(resolve(publicDir, file), "utf-8");
      } catch {
        continue;
      }

      // Check for `${t(` in template literals assigned to innerHTML or insertAdjacentHTML
      // We only flag t() in template literals that are directly assigned to innerHTML
      // or passed to insertAdjacentHTML. Using t() in a template literal passed to a
      // function that uses textContent (like renderError) is safe.
      const innerHtmlTemplateRegex = /\.innerHTML\s*=\s*`[^`]*\$\{t\(/g;
      let match;

      for (;;) {
        match = innerHtmlTemplateRegex.exec(content);
        if (!match) break;
        const segment = content.slice(match.index, match.index + 300);
        if (
          !segment.includes("escapeHtml(t(") &&
          !segment.includes("this.escapeHtml(t(") &&
          !segment.includes("this._escape(t(")
        ) {
          violations.push(`${file}: raw \${t()} in innerHTML template without escapeHtml`);
        }
      }

      // Check for .innerHTML = ...t(...
      const innerHtmlRegex = /\.innerHTML\s*=\s*[^;]*\bt\(/g;

      for (;;) {
        match = innerHtmlRegex.exec(content);
        if (!match) break;
        const segment = content.slice(match.index, match.index + 500);
        if (
          !segment.includes("escapeHtml(t(") &&
          !segment.includes("this.escapeHtml(t(") &&
          !segment.includes("this._escape(t(") &&
          !segment.includes("textContent")
        ) {
          violations.push(`${file}: .innerHTML assignment with raw t() without escapeHtml`);
        }
      }

      // Check for insertAdjacentHTML with t()
      const insertAdjRegex = /insertAdjacentHTML\([^;]*\bt\(/g;

      for (;;) {
        match = insertAdjRegex.exec(content);
        if (!match) break;
        const segment = content.slice(match.index, match.index + 200);
        if (!segment.includes("escapeHtml(t(")) {
          violations.push(`${file}: insertAdjacentHTML with raw t() without escapeHtml`);
        }
      }
    }

    expect(violations, `Raw t() in HTML:\n${violations.join("\n")}`).toEqual([]);
  });
});
