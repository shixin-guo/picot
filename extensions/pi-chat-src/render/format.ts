// Formatting adapted from Vercel Chat SDK service converters (MIT).
// Source inspiration:
// - packages/adapter-telegram/src/markdown.ts

import type { ChatService } from "../core/config-types.js";

export interface RenderedChunkPayload {
  text: string;
  parseMode?: "Markdown" | "HTML";
}

// Escape HTML special characters outside of tags we generate ourselves.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Convert a Markdown string to Telegram HTML (parse_mode: "HTML").
 *
 * Supported conversions:
 *   ```lang\ncode\n```  →  <pre><code class="language-lang">...</code></pre>
 *   `inline`            →  <code>inline</code>
 *   **bold**            →  <b>bold</b>
 *   __bold__            →  <b>bold</b>
 *   *italic*            →  <i>italic</i>
 *   _italic_            →  <i>italic</i>
 *   ~~strike~~          →  <s>strike</s>
 *   [text](url)         →  <a href="url">text</a>
 *   ### Heading         →  <b>Heading</b>
 */
function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang
    const fenceMatch = line.match(/^```(\w*)$/);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== "```") {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      const codeContent = codeLines.join("\n");
      if (lang) {
        output.push(`<pre><code class="language-${lang}">${codeContent}</code></pre>`);
      } else {
        output.push(`<pre>${codeContent}</pre>`);
      }
      i++; // skip closing ```
      continue;
    }

    // Inline formatting on the line
    output.push(convertInline(line));
    i++;
  }

  return output.join("\n").trim();
}

function convertInline(line: string): string {
  // Headings → bold
  const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch) {
    return `<b>${convertSpans(headingMatch[1])}</b>`;
  }
  return convertSpans(line);
}

function convertSpans(text: string): string {
  // Process inline code first to avoid nested formatting inside it
  const parts: string[] = [];
  const inlineCodeRe = /`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: intentional pattern
  while ((match = inlineCodeRe.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(convertFormatting(escapeHtml(text.slice(last, match.index))));
    }
    parts.push(`<code>${escapeHtml(match[1])}</code>`);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push(convertFormatting(escapeHtml(text.slice(last))));
  }

  return parts.join("");
}

function convertFormatting(html: string): string {
  return (
    html
      // Links: [text](url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // Bold: **text** or __text__
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/__([^_]+)__/g, "<b>$1</b>")
      // Italic: *text* or _text_ (single, not touching word boundaries issues)
      .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
      .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "<i>$1</i>")
      // Strikethrough: ~~text~~
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
  );
}

export function formatMarkdownForService(
  service: ChatService,
  markdown: string,
): RenderedChunkPayload {
  if (service === "telegram") {
    return { text: markdownToTelegramHtml(markdown), parseMode: "HTML" };
  }
  return { text: markdown };
}

export function maxMessageLength(service: ChatService): number {
  if (service === "telegram") return 4096;
  return 4096;
}
