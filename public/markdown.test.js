import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "./i18n.js";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";

beforeEach(async () => {
  document.body.innerHTML = "";
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal("fetch", async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: { copy: "Copy", copied: "Copied!" } }),
      };
    if (u.includes("/locales/zh.json"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: { copy: "复制", copied: "已复制!" } }),
      };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

describe("renderStreamingMarkdown", () => {
  it("renders complete markdown identically to renderMarkdown", () => {
    const text = "# Title\n\nSome **bold** and `code`.\n\n```js\nconst a = 1;\n```";
    expect(renderStreamingMarkdown(text)).toBe(renderMarkdown(text));
  });

  it("closes unterminated bold mid-stream", () => {
    const html = renderStreamingMarkdown("hello **bold te");
    expect(html).toContain("<strong>bold te</strong>");
    expect(html).not.toContain("**");
  });

  it("closes unterminated inline code mid-stream", () => {
    const html = renderStreamingMarkdown("run `npm inst");
    expect(html).toContain("<code>npm inst</code>");
  });

  it("renders an unterminated code fence as a code block", () => {
    const html = renderStreamingMarkdown("```js\nconst a = 1;\nconst b");
    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("```");
  });

  it("handles a fence with no newline yet", () => {
    const html = renderStreamingMarkdown("```js");
    expect(html).toContain("code-block-wrapper");
  });

  it("shows only the label for a link whose URL is still streaming", () => {
    const html = renderStreamingMarkdown("see [the docs](https://exa");
    expect(html).toContain("the docs");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("streamdown:incomplete-link");
  });

  it("returns empty string for empty input", () => {
    expect(renderStreamingMarkdown("")).toBe("");
    expect(renderStreamingMarkdown(null)).toBe("");
  });
});

describe("markdown copy button locale change", () => {
  it("uses messages.copy for the code block copy button after initI18n", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const copyBtn = container.querySelector(".copy-btn");
    expect(copyBtn.textContent).toBe("Copy");
  });

  it("updates .copy-btn:not(.copied) text on locale change", async () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const copyBtn = container.querySelector(".copy-btn");
    expect(copyBtn.textContent).toBe("Copy");

    await setLocale("zh");
    expect(copyBtn.textContent).toBe("复制");
  });

  it("does not overwrite .copied buttons during locale change", async () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);

    const copyBtn = container.querySelector(".copy-btn");
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");

    await setLocale("zh");
    expect(copyBtn.textContent).toBe("Copied!");
    expect(copyBtn.classList.contains("copied")).toBe(true);
  });
});
