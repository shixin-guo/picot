import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { attachCopyButtonDelegation, renderFileMarkdown } from "./file-preview-markdown.js";

// Ensure i18n is initialized so renderMarkdown() has its translations.
import { initI18n, setLocale, t } from "./i18n.js";

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = (url) => {
    const isChinese = String(url).includes("/zh.json");
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          app: { welcome: isChinese ? "欢迎" : "Welcome" },
          messages: {
            copy: isChinese ? "复制" : "Copy",
            copied: isChinese ? "已复制！" : "Copied!",
          },
          files: {
            loading: isChinese ? "加载中..." : "Loading...",
            preview: { copyFailed: isChinese ? "复制失败" : "Copy failed" },
          },
        }),
    });
  };
  await initI18n();
});

let container;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
});

describe("renderFileMarkdown", () => {
  test("renders headings", () => {
    const frag = renderFileMarkdown("# Title\n\n## Subtitle");
    container.appendChild(frag);
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelector("h2")).not.toBeNull();
  });

  test("renders emphasis (bold, italic)", () => {
    const frag = renderFileMarkdown("**bold** and *italic*");
    container.appendChild(frag);
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("em")).not.toBeNull();
  });

  test("renders lists", () => {
    const frag = renderFileMarkdown("- item1\n- item2\n");
    container.appendChild(frag);
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelectorAll("li").length).toBe(2);
  });

  test("renders task checkboxes as disabled", () => {
    const frag = renderFileMarkdown("- [x] done\n- [ ] todo\n");
    container.appendChild(frag);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    for (const cb of checkboxes) {
      expect(cb.hasAttribute("disabled")).toBe(true);
    }
  });

  test("renders tables with safe text-align", () => {
    const frag = renderFileMarkdown("| Col1 | Col2 |\n|:------|:-----:|\n| a | b |\n");
    container.appendChild(frag);
    expect(container.querySelector("table")).not.toBeNull();
  });

  test("renders blockquotes", () => {
    const frag = renderFileMarkdown("> quoted text\n");
    container.appendChild(frag);
    expect(container.querySelector("blockquote")).not.toBeNull();
  });

  test("renders code blocks", () => {
    const frag = renderFileMarkdown("```js\nconsole.log(1);\n```\n");
    container.appendChild(frag);
    expect(container.querySelector("pre code")).not.toBeNull();
  });

  test("renders safe links", () => {
    const frag = renderFileMarkdown("[Example](https://example.com)");
    container.appendChild(frag);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://example.com");
  });

  test("renders safe images", () => {
    const frag = renderFileMarkdown("![Alt](https://example.com/img.png)");
    container.appendChild(frag);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("https://example.com/img.png");
  });

  test("removes script tags", () => {
    const frag = renderFileMarkdown("# Title\n\n<script>alert('xss')</script>\n");
    container.appendChild(frag);
    expect(container.querySelector("script")).toBeNull();
  });

  test("removes iframe tags", () => {
    const frag = renderFileMarkdown('# Title\n\n<iframe src="https://evil.com"></iframe>\n');
    container.appendChild(frag);
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("removes javascript: protocol links", () => {
    // renderMarkdown might not produce these directly, but test the sanitizer.
    const frag = renderFileMarkdown("[click](javascript:alert(1))");
    container.appendChild(frag);
    const link = container.querySelector("a");
    if (link) {
      // The href should have been stripped or rendered safe.
      const href = link.getAttribute("href");
      expect(href === null || !href.startsWith("javascript:")).toBe(true);
    }
  });

  test("removes unsafe data: URIs from images (non-image types)", () => {
    const frag = renderFileMarkdown("![Alt](data:text/html,<script>alert(1)</script>)");
    container.appendChild(frag);
    const img = container.querySelector("img");
    if (img) {
      const src = img.getAttribute("src");
      expect(src === null || !src.startsWith("data:text/html")).toBe(true);
    }
  });

  test("allows data:image/* in images", () => {
    const frag = renderFileMarkdown("![Alt](data:image/png;base64,iVBORw0KGgo=)");
    container.appendChild(frag);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("removes inline event-handler attributes", () => {
    const frag = renderFileMarkdown('# Title\n\n<div onclick="alert(1)">text</div>\n');
    container.appendChild(frag);
    const div = container.querySelector("div");
    if (div) {
      expect(div.hasAttribute("onclick")).toBe(false);
    }
  });

  test("keeps only safe attributes on allowed raw HTML elements", () => {
    const frag = renderFileMarkdown(
      '<a href="https://example.com" target="_self" ping="https://tracker.invalid" class="settings-overlay">link</a>' +
        '<button type="submit" form="message-form" formaction="/api/open">submit</button>' +
        '<input type="text" value="secret">',
    );
    container.appendChild(frag);

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.hasAttribute("ping")).toBe(false);
    expect(link?.hasAttribute("class")).toBe(false);

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  test("copy button delegation works after mount", () => {
    const frag = renderFileMarkdown("```js\nconsole.log('hello');\n```\n");
    container.appendChild(frag);
    const cleanup = attachCopyButtonDelegation(container);

    const btn = container.querySelector(".copy-btn");
    expect(btn).not.toBeNull();
    // The button should NOT have an inline onclick handler.
    expect(btn.hasAttribute("onclick")).toBe(false);

    cleanup();
  });

  test("uses the active locale for copy-button feedback", async () => {
    await setLocale("zh");
    const frag = renderFileMarkdown("```js\nconsole.log('hello');\n```\n");
    container.appendChild(frag);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const cleanup = attachCopyButtonDelegation(container);

    const btn = container.querySelector(".copy-btn");
    expect(btn?.textContent).toBe(t("messages.copy"));
    btn?.click();
    await Promise.resolve();
    expect(btn?.textContent).toBe(t("messages.copied"));

    cleanup();
  });

  test("reports clipboard failures without an unhandled rejection", async () => {
    const frag = renderFileMarkdown("```js\nconsole.log('hello');\n```\n");
    container.appendChild(frag);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
    });
    const cleanup = attachCopyButtonDelegation(container);

    const btn = container.querySelector(".copy-btn");
    btn?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(btn?.textContent).toBe(t("files.preview.copyFailed"));

    cleanup();
  });
});
