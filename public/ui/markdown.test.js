import { describe, expect, it } from "vitest";
import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";

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

  it("does not leak code block placeholders for a fenced block in a list item", () => {
    const markdown = "- ```js\nconst answer = 42;\n```";
    const html = renderStreamingMarkdown(markdown);

    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("const answer = 42;");
    expect(html).not.toContain("%%CODEBLOCK_");
  });

  it("returns empty string for empty input", () => {
    expect(renderStreamingMarkdown("")).toBe("");
    expect(renderStreamingMarkdown(null)).toBe("");
  });
});

describe("renderMarkdown", () => {
  it("renders fenced code blocks whose language contains a hyphen", () => {
    const html = renderMarkdown('```acceptance-report\n{"criteriaSatisfied": []}\n```');

    expect(html).toContain("code-block-wrapper");
    expect(html).toContain("acceptance-report");
    expect(html).toContain("&quot;criteriaSatisfied&quot;");
    expect(html).not.toContain("```acceptance-report");
  });

  it("does not leak code block placeholders for unordered or ordered list items", () => {
    for (const marker of ["-", "1."]) {
      const html = renderMarkdown(`${marker} \`\`\`sh\necho ok\n\`\`\``);

      expect(html).toContain("code-block-wrapper");
      expect(html).toContain("echo ok");
      expect(html).not.toContain("%%CODEBLOCK_");
    }
  });
});
