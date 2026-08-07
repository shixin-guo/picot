// ABOUTME: Provides local Lucide Icons (ISC) style SVG action icons for Picot controls.
// ABOUTME: Keeps icon DOM creation safe, same-origin, and independent of user content.

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  eye: [
    ["path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" }],
    ["circle", { cx: 12, cy: 12, r: 3 }],
  ],
  pencil: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" }],
  ],
  save: [
    ["path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" }],
    ["path", { d: "M17 21v-8H7v8M7 3v5h8" }],
  ],
  refresh: [
    ["path", { d: "M21 12a9 9 0 0 1-15.2 6.5L3 16" }],
    ["path", { d: "M3 12A9 9 0 0 1 18.2 5.5L21 8" }],
    ["path", { d: "M3 21v-5h5M21 3v5h-5" }],
  ],
  search: [
    ["circle", { cx: 11, cy: 11, r: 8 }],
    ["path", { d: "m21 21-4.3-4.3" }],
  ],
  list: [
    ["path", { d: "M8 6h13M8 12h13M8 18h13" }],
    ["path", { d: "M3 6h.01M3 12h.01M3 18h.01" }],
  ],
  copy: [
    ["rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }],
    ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }],
  ],
  "external-link": [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "M10 14 21 3" }],
    ["path", { d: "M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" }],
  ],
  link: [
    ["path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }],
    ["path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }],
  ],
  sliders: [
    ["line", { x1: 4, y1: 6, x2: 20, y2: 6 }],
    ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }],
    ["circle", { cx: 8, cy: 6, r: 2 }],
    ["circle", { cx: 16, cy: 12, r: 2 }],
    ["circle", { cx: 10, cy: 18, r: 2 }],
  ],
  wrap: [
    ["path", { d: "M3 6h18M3 12h12a3 3 0 1 1 0 6H9" }],
    ["path", { d: "m9 15-3 3 3 3" }],
  ],
  x: [["path", { d: "M18 6 6 18M6 6l12 12" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  maximize: [
    ["path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }],
    ["path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }],
    ["path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }],
    ["path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" }],
  ],
  minimize: [
    ["path", { d: "M8 3v3a2 2 0 0 1-2 2H3" }],
    ["path", { d: "M21 8h-3a2 2 0 0 1-2-2V3" }],
    ["path", { d: "M3 16h3a2 2 0 0 1 2 2v3" }],
    ["path", { d: "M16 21v-3a2 2 0 0 1 2-2h3" }],
  ],
  "text-collapse": [
    ["path", { d: "M21 12H9" }],
    ["path", { d: "M13 8l-4 4 4 4" }],
    ["path", { d: "M3 4h18" }],
    ["path", { d: "M3 20h18" }],
  ],
  "refresh-cw": [
    ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
  ],
  "message-square-plus": [
    ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" }],
    ["path", { d: "M12 8v6M9 11h6" }],
  ],
  terminal: [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["path", { d: "M7 9l3 3-3 3" }],
    ["path", { d: "M13 15h4" }],
  ],
  box: [
    ["path", { d: "m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" }],
    ["path", { d: "m4.3 7.6 7.7 4.5 7.7-4.5M12 12.1v8.7M8 5.1l8 4.6" }],
  ],
  folder: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }],
  ],
  "folder-plus": [
    ["path", { d: "M4 5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M12 11v5M9.5 13.5h5" }],
  ],
  "message-circle": [
    ["path", { d: "M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" }],
    ["path", { d: "M8 10h8M8 14h5" }],
  ],
  "message-square": [
    ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" }],
  ],
  settings: [
    ["path", { d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" }],
    [
      "path",
      {
        d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
      },
    ],
  ],
  menu: [
    ["line", { x1: 3, y1: 6, x2: 21, y2: 6 }],
    ["line", { x1: 3, y1: 12, x2: 21, y2: 12 }],
    ["line", { x1: 3, y1: 18, x2: 21, y2: 18 }],
  ],
  smartphone: [
    ["rect", { x: 5, y: 2, width: 14, height: 20, rx: 2 }],
    ["line", { x1: 12, y1: 18, x2: 12.01, y2: 18 }],
  ],
  "chevron-down": [["polyline", { points: "6 9 12 15 18 9" }]],
  "chevron-up": [["polyline", { points: "18 15 12 9 6 15" }]],
  "panel-right": [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["line", { x1: 15, y1: 4, x2: 15, y2: 20 }],
  ],
  "arrow-down": [
    ["line", { x1: 12, y1: 5, x2: 12, y2: 19 }],
    ["polyline", { points: "19 12 12 19 5 12" }],
  ],
  "arrow-right": [
    ["line", { x1: 5, y1: 12, x2: 19, y2: 12 }],
    ["polyline", { points: "12 5 19 12 12 19" }],
  ],
  "arrow-up": [["path", { d: "M12 19V5M5 12l7-7 7 7" }]],
  bot: [
    ["rect", { x: 4, y: 8, width: 16, height: 12, rx: 2 }],
    ["path", { d: "M12 8V4M9 4h6" }],
    ["circle", { cx: 9, cy: 14, r: 1 }],
    ["circle", { cx: 15, cy: 14, r: 1 }],
  ],
  mic: [
    ["rect", { x: 9, y: 2, width: 6, height: 12, rx: 3 }],
    ["path", { d: "M5 11a7 7 0 0 0 14 0" }],
    ["line", { x1: 12, y1: 18, x2: 12, y2: 22 }],
  ],
  "mic-off": [
    ["line", { x1: 4, y1: 4, x2: 20, y2: 20 }],
    ["path", { d: "M9 9v1a3 3 0 0 0 5 2" }],
    ["path", { d: "M15 10V6a3 3 0 0 0-5.6-1.5" }],
    ["path", { d: "M5 11a7 7 0 0 0 10.7 6" }],
    ["line", { x1: 12, y1: 18, x2: 12, y2: 22 }],
  ],
  send: [
    ["line", { x1: 22, y1: 2, x2: 11, y2: 13 }],
    ["polygon", { points: "22 2 15 22 11 13 2 9 22 2" }],
  ],
  square: [["rect", { x: 5, y: 5, width: 14, height: 14, rx: 2 }]],
  archive: [
    ["rect", { x: 3, y: 4, width: 18, height: 4, rx: 1 }],
    ["path", { d: "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" }],
    ["line", { x1: 10, y1: 12, x2: 14, y2: 12 }],
  ],
  "trash-2": [
    ["polyline", { points: "3 6 5 6 21 6" }],
    ["path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }],
    ["path", { d: "M10 11v6M14 11v6" }],
    ["path", { d: "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" }],
  ],
  "chevron-right": [["polyline", { points: "9 6 15 12 9 18" }]],
  "chevron-left": [["polyline", { points: "15 6 9 12 15 18" }]],
  "folder-open": [
    [
      "path",
      {
        d: "M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
      },
    ],
  ],
  "git-branch": [
    ["line", { x1: 6, y1: 3, x2: 6, y2: 15 }],
    ["circle", { cx: 18, cy: 6, r: 3 }],
    ["circle", { cx: 6, cy: 18, r: 3 }],
    ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
  ],
  minus: [["line", { x1: 5, y1: 12, x2: 19, y2: 12 }]],
  "sliders-horizontal": [
    ["line", { x1: 4, y1: 8, x2: 20, y2: 8 }],
    ["line", { x1: 4, y1: 16, x2: 20, y2: 16 }],
    ["circle", { cx: 9, cy: 8, r: 2 }],
    ["circle", { cx: 15, cy: 16, r: 2 }],
  ],
  brain: [
    [
      "path",
      {
        d: "M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z",
      },
    ],
    [
      "path",
      {
        d: "M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z",
      },
    ],
  ],
  clipboard: [
    ["path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" }],
    ["rect", { x: 8, y: 2, width: 8, height: 4, rx: 1 }],
  ],
  "bar-chart": [
    ["line", { x1: 12, y1: 20, x2: 12, y2: 10 }],
    ["line", { x1: 18, y1: 20, x2: 18, y2: 4 }],
    ["line", { x1: 6, y1: 20, x2: 6, y2: 16 }],
  ],
  "chevrons-down": [
    ["path", { d: "m7 6 5 5 5-5" }],
    ["path", { d: "m7 13 5 5 5-5" }],
  ],
  "chevrons-up": [
    ["path", { d: "m17 11-5-5-5 5" }],
    ["path", { d: "m17 18-5-5-5 5" }],
  ],
  ellipsis: [
    ["circle", { cx: 12, cy: 12, r: 1 }],
    ["circle", { cx: 19, cy: 12, r: 1 }],
    ["circle", { cx: 5, cy: 12, r: 1 }],
  ],
  "rotate-cw": [
    ["polyline", { points: "23 4 23 10 17 10" }],
    ["path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" }],
  ],
  "panel-bottom": [
    ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ["line", { x1: 3, y1: 15, x2: 21, y2: 15 }],
  ],
  pin: [
    ["line", { x1: 12, y1: 17, x2: 12, y2: 22 }],
    [
      "path",
      {
        d: "M5 17h14l-1.5-3V8a3 3 0 0 0-1.5-2.6V4a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v1.4A3 3 0 0 0 6.5 8v6z",
      },
    ],
  ],
};

/** Create a trusted local icon. Unknown names intentionally render no SVG. */
export function createIcon(
  name,
  { size = 16, document: ownerDocument = globalThis.document, filled = false } = {},
) {
  const definition = ICONS[name];
  if (!definition || !ownerDocument) return null;
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({
    "aria-hidden": "true",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: filled ? "currentColor" : "none",
    stroke: filled ? "none" : "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  })) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, attributes] of definition) {
    const element = ownerDocument.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    svg.appendChild(element);
  }
  return svg;
}

/** Replace a button's decorative content without changing its accessible name. */
export function setButtonIcon(button, name, options) {
  if (!button) return;
  const icon = createIcon(name, options);
  if (icon) button.replaceChildren(icon);
}

/**
 * Replace only the leading decorative `<svg>` inside a button while keeping
 * siblings (labels, badges). Use this for buttons that carry visible text —
 * `setButtonIcon`'s `replaceChildren` would erase it.
 */
export function replaceButtonGlyph(button, name, options) {
  if (!button) return;
  const icon = createIcon(name, options);
  if (!icon) return;
  const oldSvg = button.querySelector("svg");
  if (oldSvg) {
    oldSvg.replaceWith(icon);
  } else {
    button.prepend(icon);
  }
}
