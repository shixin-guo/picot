/**
 * File classification and CodeMirror language resolver.
 *
 * Maps file paths to content types (markdown, text, image, pdf, unknown)
 * and returns the appropriate CodeMirror language extension.
 * Source modules import @codemirror/* directly; Vitest resolves from
 * node_modules, while the browser import map redirects to vendor bundles.
 */

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { r } from "@codemirror/legacy-modes/mode/r";
import { shell } from "@codemirror/legacy-modes/mode/shell";

const shellLanguage = StreamLanguage.define(shell);
const rLanguage = StreamLanguage.define(r);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);

/**
 * Classify a file path into a content type.
 */
export function classifyFilePath(filePath) {
  const ext = getExtension(filePath);

  if (ext === "pdf") {
    return { contentType: "pdf", editable: false, languageId: null };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return { contentType: "image", editable: false, languageId: null };
  }

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return { contentType: "markdown", editable: true, languageId: "markdown" };
  }

  // Text/code files
  const languageId = getLanguageId(ext);
  return { contentType: "text", editable: true, languageId };
}

function getLanguageId(ext) {
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "json":
    case "jsonc":
      return "json";
    case "yaml":
    case "yml":
      return "yaml";
    case "py":
    case "pyw":
    case "pyi":
      return "python";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "xml":
      return "html";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "env":
      return "shell";
    case "r":
      return "r";
    default:
      return null;
  }
}

/**
 * Return the CodeMirror language extension for a file path, or null if
 * no dedicated language mode exists (plain text fallback).
 */
export function languageExtensionForPath(filePath) {
  const ext = getExtension(filePath);

  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ typescript: false, jsx: ext === "jsx" });
    case "json":
    case "jsonc":
    case "jsonl":
      return json();
    case "yaml":
    case "yml":
      return yaml();
    case "py":
    case "pyw":
    case "pyi":
      return python();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css();
    case "html":
    case "htm":
    case "xml":
      return html();
    case "md":
    case "markdown":
    case "mdown":
    case "mkd":
      return markdown();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "env":
      return shellLanguage;
    case "r":
      return rLanguage;
    default:
      return null;
  }
}

function getExtension(filePath) {
  if (typeof filePath !== "string") return "";
  const basename = filePath.split("/").pop() || filePath;
  const idx = basename.lastIndexOf(".");
  if (idx <= 0) return ""; // dotfiles or no extension
  return basename.slice(idx + 1).toLowerCase();
}
