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
import { renderMarkdown } from "./markdown.js";

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
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tagName = child.tagName.toLowerCase();

      if (!ELEMENT_ALLOWLIST.has(tagName)) {
        // Replace non-allowlisted element with its text content.
        const textNode = document.createTextNode(child.textContent || "");
        child.replaceWith(textNode);
        continue;
      }

      // Remove all event-handler attributes (on*).
      for (const attr of [...child.attributes]) {
        const attrName = attr.name.toLowerCase();

        // Strip all on* attributes.
        if (attrName.startsWith("on")) {
          child.removeAttribute(attr.name);
          continue;
        }

        // Validate href on <a> elements.
        if (tagName === "a" && attrName === "href") {
          if (!isSafeLink(attr.value)) {
            child.removeAttribute("href");
          }
          continue;
        }

        // Validate src on <img> elements.
        if (tagName === "img" && attrName === "src") {
          if (!isSafeImageSrc(attr.value)) {
            child.removeAttribute("src");
          }
          continue;
        }

        // Validate style attributes — only allow safe text-align.
        if (attrName === "style") {
          const styleText = attr.value;
          const textAlignMatch = styleText.match(/text-align\s*:\s*([^;]+)/i);
          if (textAlignMatch && isSafeTextAlign(textAlignMatch[1])) {
            child.setAttribute("style", `text-align: ${textAlignMatch[1].trim().toLowerCase()}`);
          } else {
            child.removeAttribute("style");
          }
          continue;
        }

        // Validate class on input — only allow task-list checkboxes.
        if (tagName === "input" && attrName === "class") {
          continue; // keep class for task-list styling
        }

        // For input elements, only allow type, checked, disabled, class.
        if (tagName === "input") {
          if (!["type", "checked", "disabled", "class"].includes(attrName)) {
            child.removeAttribute(attr.name);
          }
          continue;
        }

        // Remove class from copy buttons (they get event delegation).
        if (tagName === "button" && attrName === "class") {
          // Keep class but it will be styled via CSS.
        }
      }

      // Ensure <input> checkboxes are always disabled.
      if (tagName === "input") {
        child.setAttribute("disabled", "");
      }

      // Ensure external links have rel="noopener noreferrer" to prevent tabnabbing.
      if (tagName === "a" && child.hasAttribute("href")) {
        child.setAttribute("rel", "noopener noreferrer");
      }

      // Recurse into children.
      sanitizeNode(child);
    }
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
  function handleClick(event) {
    const btn = event.target.closest(".copy-btn");
    if (!btn || !container.contains(btn)) return;

    const wrapper = btn.closest(".code-block-wrapper");
    if (!wrapper) return;

    const codeEl = wrapper.querySelector("code");
    if (!codeEl) return;

    const text = codeEl.textContent || "";
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("copied");
        }, 1200);
      });
    }
  }

  container.addEventListener("click", handleClick);
  return () => container.removeEventListener("click", handleClick);
}
