// Shared HTML-markup sanitizer for renderer output (markdown.js et al.).
// renderMarkdown() does not escape raw HTML embedded in text, so any markup
// injected into the DOM must pass through here first.

const BLOCKED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FOREIGNOBJECT",
  "ANIMATE",
  "SET",
  "USE",
]);

/** Strip dangerous elements and attributes from an already-parsed DOM subtree, in place. */
export function sanitizeMarkup(root) {
  root.querySelectorAll("*").forEach((element) => {
    if (BLOCKED_TAGS.has(element.tagName)) {
      element.remove();
      return;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "formaction" ||
        (name === "href" && !/^(https?:|mailto:|#)/i.test(value)) ||
        (name === "src" && !/^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp);)/i.test(value)) ||
        (name === "style" && /url\s*\(/i.test(value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
}

/** Parse an HTML string and return a sanitized DocumentFragment of its body. */
export function parseSanitizedMarkup(markup) {
  const parsed = new DOMParser().parseFromString(String(markup || ""), "text/html");
  sanitizeMarkup(parsed.body);
  const fragment = document.createDocumentFragment();
  fragment.append(...Array.from(parsed.body.childNodes));
  return fragment;
}
