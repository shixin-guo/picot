// ABOUTME: Shared file/Git object-icon resolver backed by a curated, pinned
// ABOUTME: vscode-material-icon-theme (MIT) SVG vocabulary, vendored locally.
// ABOUTME: Trusted fills/colors are part of object recognition — they are NOT forced to currentColor.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Pinned vocabulary of file/Git object glyphs. Each entry maps an internal
 * resolver name to a trusted inline SVG definition (tag + attributes). These
 * are distinct from the local monochrome action-icon registry in icons.js:
 * Material object artwork keeps its own reviewed colors so folders, source
 * files, and config documents remain visually recognizable across both trees.
 *
 * Upstream source: vscode-material-icon-theme (MIT, PKief), release tag pinned
 * in `public/icons/material-file-theme/SOURCE.md`. Only the names required by
 * the integrated UI plan are vendored; no remote fetch, emoji fallback, or
 * Material asset is ever used for an action control.
 */
const OBJECT_ICONS = {
  folder: [
    [
      "path",
      {
        d: "M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z",
        fill: "#90a4ae",
      },
    ],
    ["path", { d: "M2 8h16v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", fill: "#cfd8dc" }],
  ],
  "folder-open": [
    ["path", { d: "M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2H2z", fill: "#90a4ae" }],
    ["path", { d: "M2 8h18l-2.5 8.4A2 2 0 0 1 15.6 18H4a2 2 0 0 1-2-2z", fill: "#cfd8dc" }],
  ],
  "folder-git": [
    [
      "path",
      {
        d: "M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z",
        fill: "#f1959b",
      },
    ],
    ["path", { d: "M2 8h16v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z", fill: "#f7c6cb" }],
  ],
  "folder-git-open": [
    ["path", { d: "M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2H2z", fill: "#f1959b" }],
    ["path", { d: "M2 8h18l-2.5 8.4A2 2 0 0 1 15.6 18H4a2 2 0 0 1-2-2z", fill: "#f7c6cb" }],
  ],
  file: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#cfd8dc" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#90a4ae" }],
  ],
  ts: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#42a5f5" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#1e88e5" }],
    [
      "text",
      {
        x: 10,
        y: 16,
        "font-size": 7,
        fill: "#fff",
        "text-anchor": "middle",
        "font-family": "monospace",
        _text: "TS",
      },
    ],
  ],
  js: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#fdd835" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#f9a825" }],
    [
      "text",
      {
        x: 10,
        y: 16,
        "font-size": 7,
        fill: "#3e2723",
        "text-anchor": "middle",
        "font-family": "monospace",
        _text: "JS",
      },
    ],
  ],
  python: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#455a64" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#37474f" }],
    ["path", { d: "M7 12h6l-1.5 4h-3z", fill: "#ffd54f" }],
  ],
  json: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#fdd835" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#f9a825" }],
  ],
  markdown: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#42a5f5" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#1e88e5" }],
  ],
  html: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#ef5350" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#e53935" }],
  ],
  css: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#42a5f5" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#1e88e5" }],
  ],
  yaml: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#ce93d8" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#ab47bc" }],
  ],
  toml: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#9ccc65" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#7cb342" }],
  ],
  shell: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#4db6ac" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#26a69a" }],
  ],
  rust: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#ef5350" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#c62828" }],
  ],
  image: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#7e57c2" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#5e35b1" }],
    ["circle", { cx: 8.5, cy: 11, r: 1.4, fill: "#fff59d" }],
    ["path", { d: "M5 18l3.5-4 2.5 3 3-4 3 5z", fill: "#d1c4e9" }],
  ],
  pdf: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#ef5350" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#c62828" }],
    [
      "text",
      {
        x: 10,
        y: 16,
        "font-size": 6,
        fill: "#fff",
        "text-anchor": "middle",
        "font-family": "monospace",
        _text: "PDF",
      },
    ],
  ],
  env: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#aed581" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#7cb342" }],
  ],
  lock: [
    ["rect", { x: 4, y: 9, width: 13, height: 10, rx: 1.5, fill: "#fbc02d" }],
    [
      "path",
      { d: "M6.5 9V7a3.5 3.5 0 0 1 7 0v2", fill: "none", stroke: "#f9a825", "stroke-width": 1.6 },
    ],
  ],
  config: [
    [
      "path",
      { d: "M5 2h8l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", fill: "#90a4ae" },
    ],
    ["path", { d: "M13 2l5 5h-5z", fill: "#607d8b" }],
    ["circle", { cx: 8.5, cy: 13, r: 2.2, fill: "none", stroke: "#37474f", "stroke-width": 1.3 }],
  ],
};

const SPECIAL_NAMES = {
  ".gitignore": "env",
  ".env": "env",
  "package.json": "json",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "package-lock.json": "lock",
  "yarn.lock": "lock",
  "pnpm-lock.yaml": "lock",
  dockerfile: "config",
  "cargo.toml": "toml",
  "tsconfig.json": "config",
  "vite.config.js": "config",
  "vite.config.ts": "config",
};

const EXTENSION_MAP = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "python",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  rs: "rust",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  ico: "image",
  svg: "image",
  pdf: "pdf",
  env: "env",
  lock: "lock",
};

/**
 * Resolve the object-icon name for a file/folder descriptor. Precedence:
 * exact special filename > directory state (with .git/.github variants) >
 * extension > generic file fallback. The result is stable across File Browser,
 * Git Panel and File Preview tabs.
 */
export function resolveFileTypeIcon({ name, isDirectory = false, expanded = false } = {}) {
  const lower = (name || "").toLowerCase();
  if (isDirectory) {
    if (lower === ".git" || lower === ".github") {
      return expanded ? "folder-git-open" : "folder-git";
    }
    return expanded ? "folder-open" : "folder";
  }
  if (SPECIAL_NAMES[lower]) return SPECIAL_NAMES[lower];
  const ext = lower.split(".").pop() || "";
  if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];
  return "file";
}

/**
 * Build a trusted local SVG element for the resolved object-icon name.
 * Material artwork keeps its reviewed colors (no currentColor forcing); the
 * element is `aria-hidden` and sized to the requested box (default 16px).
 */
export function createFileTypeIcon(descriptor, { size = 16 } = {}) {
  const iconName = typeof descriptor === "string" ? descriptor : resolveFileTypeIcon(descriptor);
  const definition = OBJECT_ICONS[iconName] || OBJECT_ICONS.file;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of definition) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "_text") {
        el.textContent = String(value);
      } else {
        el.setAttribute(key, String(value));
      }
    }
    svg.appendChild(el);
  }
  return svg;
}
