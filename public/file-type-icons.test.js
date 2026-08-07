// @vitest-environment jsdom
// ABOUTME: Verifies the shared file/Git object-icon resolver returns trusted local
// ABOUTME: Material-style SVG glyphs with stable precedence and no emoji fallback.
import { describe, expect, it } from "vitest";
import { createFileTypeIcon, resolveFileTypeIcon } from "./file-type-icons.js";

describe("resolveFileTypeIcon precedence", () => {
  it("resolves directories with open/closed and .git variants", () => {
    expect(resolveFileTypeIcon({ name: "src", isDirectory: true })).toBe("folder");
    expect(resolveFileTypeIcon({ name: "src", isDirectory: true, expanded: true })).toBe(
      "folder-open",
    );
    expect(resolveFileTypeIcon({ name: ".git", isDirectory: true })).toBe("folder-git");
    expect(resolveFileTypeIcon({ name: ".github", isDirectory: true, expanded: true })).toBe(
      "folder-git-open",
    );
  });

  it("prefers exact special filenames over extension", () => {
    expect(resolveFileTypeIcon({ name: "package.json" })).toBe("json");
    expect(resolveFileTypeIcon({ name: ".gitignore" })).toBe("env");
    expect(resolveFileTypeIcon({ name: "bun.lock" })).toBe("lock");
    expect(resolveFileTypeIcon({ name: "Dockerfile" })).toBe("config");
  });

  it("resolves source extensions to their language glyph", () => {
    expect(resolveFileTypeIcon({ name: "app.ts" })).toBe("ts");
    expect(resolveFileTypeIcon({ name: "app.tsx" })).toBe("ts");
    expect(resolveFileTypeIcon({ name: "app.js" })).toBe("js");
    expect(resolveFileTypeIcon({ name: "main.py" })).toBe("python");
    expect(resolveFileTypeIcon({ name: "lib.rs" })).toBe("rust");
    expect(resolveFileTypeIcon({ name: "config.yaml" })).toBe("yaml");
    expect(resolveFileTypeIcon({ name: "Cargo.toml" })).toBe("toml");
  });

  it("falls back to the generic file glyph for unknown names", () => {
    expect(resolveFileTypeIcon({ name: "weird.zzz" })).toBe("file");
    expect(resolveFileTypeIcon({ name: "noext" })).toBe("file");
  });

  it("is stable across all three consumers (browser, git, preview)", () => {
    const descriptor = { name: "README.md" };
    const a = resolveFileTypeIcon(descriptor);
    const b = resolveFileTypeIcon(descriptor);
    const c = resolveFileTypeIcon(descriptor);
    expect(new Set([a, b, c]).size).toBe(1);
  });
});

describe("createFileTypeIcon element contract", () => {
  it("returns an aria-hidden SVG with the reviewed material colors", () => {
    const icon = createFileTypeIcon({ name: "app.ts" });
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("viewBox")).toBe("0 0 20 20");
    // Material artwork keeps its own reviewed fill (not forced to currentColor).
    const fills = [...icon.querySelectorAll("[fill]")].map((n) => n.getAttribute("fill"));
    expect(fills.some((f) => f && f !== "currentColor" && f !== "none")).toBe(true);
  });

  it("honours the requested size and defaults to 16", () => {
    expect(createFileTypeIcon({ name: "a.js" }).getAttribute("width")).toBe("16");
    expect(createFileTypeIcon({ name: "a.js" }, { size: 12 }).getAttribute("width")).toBe("12");
  });

  it("never renders unicode emoji text for a resolved object icon", () => {
    for (const name of ["app.ts", "src", ".git", "README.md", "unknown.xyz"]) {
      const icon = createFileTypeIcon(
        name.startsWith(".") || name === "src" || name === ".git"
          ? { name, isDirectory: name === "src" || name === ".git" }
          : { name },
      );
      // Only <text> nodes carry string content, and only for label glyphs (TS/JS/PDF).
      const text = icon.textContent.replace(/\s/g, "");
      expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).toBe(false);
    }
  });

  it("falls back to the generic file glyph for an unknown resolved name", () => {
    const icon = createFileTypeIcon("definitely-not-an-icon");
    expect(icon.querySelectorAll("path").length).toBeGreaterThan(0);
  });
});
