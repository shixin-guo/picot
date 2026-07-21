/**
 * Sanitized Markdown file preview.
 *
 * Wraps the existing renderMarkdown() with DOM-based sanitization:
 * - Explicit element allowlist
 * - All event-handler attributes removed
 * - Link protocols restricted to http, https, mailto, and #fragment
 * - Image protocols restricted to http, https, and data:image/*
 * - Inline styles limited to text-align values for table cells
 *
 * Copy-button onclick attributes from renderMarkdown() are stripped;
 * event delegation is installed when the fragment is mounted.
 */

import { t } from "./i18n.js";
import { renderMarkdown } from "./ui/markdown.js";

const ELEMENT_ALLOWLIST = new Set([
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "button",
  "tr",
  "th",
  "td",
  "a",
  "img",
  "div",
  "span",
  "input",
]);

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

const ALLOWED_CLASSES = new Map([
  ["button", new Set(["copy-btn"])],
  ["div", new Set(["code-block-wrapper", "code-block-header", "table-wrapper"])],
  ["img", new Set(["inline-image"])],
  ["li", new Set(["task-list-item"])],
  ["ul", new Set(["task-list"])],
]);

const ALLOWED_ATTRIBUTES = new Map([
  ["a", new Set(["href"])],
  ["button", new Set(["class"])],
  ["div", new Set(["class"])],
  ["img", new Set(["alt", "class", "src"])],
  ["input", new Set(["checked", "disabled", "type"])],
  ["li", new Set(["class"])],
  ["td", new Set(["style"])],
  ["th", new Set(["style"])],
  ["ul", new Set(["class"])],
]);

function isSafeLink(href) {
  if (!href) return true; // allow empty href (e.g. fragment-only)
  const trimmed = href.trim();
  // Allow fragment links.
  if (trimmed.startsWith("#")) return true;
  try {
    const url = new URL(trimmed, "http://dummy.invalid");
    return SAFE_LINK_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function isSafeImageSrc(src) {
  if (!src) return true;
  const trimmed = src.trim();
  // Allow data:image/* URIs.
  if (trimmed.startsWith("data:image/")) return true;
  try {
    const url = new URL(trimmed, "http://dummy.invalid");
    return SAFE_IMAGE_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

function isSafeTextAlign(value) {
  const normalized = (value || "").trim().toLowerCase();
  return ["left", "center", "right"].includes(normalized);
}

/**
 * Sanitize a DOM node in-place: remove non-allowlisted elements and
 * dangerous attributes, validate URLs and styles.
 */
function sanitizeNode(node) {
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tagName = child.tagName.toLowerCase();
    if (!ELEMENT_ALLOWLIST.has(tagName)) {
      child.replaceWith(document.createTextNode(child.textContent || ""));
      continue;
    }

    if (tagName === "button" && !child.classList.contains("copy-btn")) {
      child.replaceWith(document.createTextNode(child.textContent || ""));
      continue;
    }
    if (tagName === "input" && child.getAttribute("type")?.toLowerCase() !== "checkbox") {
      child.remove();
      continue;
    }

    const allowedAttributes = ALLOWED_ATTRIBUTES.get(tagName) || new Set();
    for (const attr of [...child.attributes]) {
      const attrName = attr.name.toLowerCase();
      if (!allowedAttributes.has(attrName)) {
        child.removeAttribute(attr.name);
        continue;
      }

      if (attrName === "class") {
        const allowedClasses = ALLOWED_CLASSES.get(tagName) || new Set();
        const safeClasses = [...child.classList].filter((className) =>
          allowedClasses.has(className),
        );
        if (safeClasses.length > 0) {
          child.className = safeClasses.join(" ");
        } else {
          child.removeAttribute("class");
        }
        continue;
      }

      if (tagName === "a" && attrName === "href" && !isSafeLink(attr.value)) {
        child.removeAttribute("href");
        continue;
      }
      if (tagName === "img" && attrName === "src" && !isSafeImageSrc(attr.value)) {
        child.removeAttribute("src");
        continue;
      }
      if (
        attrName === "style" &&
        (!["td", "th"].includes(tagName) || !isSafeTextAlign(child.style.textAlign))
      ) {
        child.removeAttribute("style");
      } else if (attrName === "style") {
        child.setAttribute("style", `text-align: ${child.style.textAlign.toLowerCase()}`);
      }
    }

    if (tagName === "input") {
      child.setAttribute("type", "checkbox");
      child.setAttribute("disabled", "");
    }
    if (tagName === "button") {
      child.setAttribute("type", "button");
    }
    if (tagName === "a" && child.hasAttribute("href")) {
      child.setAttribute("rel", "noopener noreferrer");
      if (!child.getAttribute("href").trim().startsWith("#")) {
        child.setAttribute("target", "_blank");
      }
    }

    sanitizeNode(child);
  }
}

/**
 * Render Markdown text into a sanitized DocumentFragment.
 */
export function renderFileMarkdown(markdownText) {
  const rawHtml = renderMarkdown(markdownText || "");
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  const fragment = template.content.cloneNode(true);
  sanitizeNode(fragment);
  return fragment;
}

/**
 * Attach copy-button event delegation to a mounted container.
 * Must be called AFTER the fragment from renderFileMarkdown() is inserted
 * into the DOM. The returned cleanup function removes the listener.
 */
export function attachCopyButtonDelegation(container) {
  let feedbackTimer = null;
  function handleClick(event) {
    const btn = event.target.closest(".copy-btn");
    if (!btn || !container.contains(btn)) return;

    const wrapper = btn.closest(".code-block-wrapper");
    if (!wrapper) return;

    const codeEl = wrapper.querySelector("code");
    if (!codeEl) return;

    const text = codeEl.textContent || "";
    const original = btn.textContent;
    const showFeedback = (label, className) => {
      clearTimeout(feedbackTimer);
      btn.textContent = label;
      btn.classList.add(className);
      feedbackTimer = setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove(className);
      }, 1200);
    };

    if (!navigator.clipboard) {
      showFeedback(t("files.preview.copyFailed"), "copy-failed");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => showFeedback(t("messages.copied"), "copied"),
      () => showFeedback(t("files.preview.copyFailed"), "copy-failed"),
    );
  }

  container.addEventListener("click", handleClick);
  return () => {
    clearTimeout(feedbackTimer);
    container.removeEventListener("click", handleClick);
  };
}
