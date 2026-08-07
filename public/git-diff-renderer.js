// ABOUTME: Renders bounded Git patches as read-only side-by-side rows.
// ABOUTME: Uses separate scroll columns, block alignment, fixed gutters, and explicit raw fallback reasons.

import { t } from "./i18n.js";

const MAX_ALIGNED_ROWS = 600;

function parsePatch(patch) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let index = 0;
  const lines = String(patch || "").split("\n");
  while (index < lines.length) {
    const line = lines[index++];
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }
    if (/^(---|\+\+\+|diff |index |\\ No newline)/.test(line)) continue;
    if (line.startsWith(" ")) {
      rows.push({
        original: { line: oldLine++, text: line.slice(1), kind: "unchanged" },
        current: { line: newLine++, text: line.slice(1), kind: "unchanged" },
      });
      continue;
    }
    if (!line.startsWith("-")) {
      if (line.startsWith("+"))
        rows.push({
          original: null,
          current: { line: newLine++, text: line.slice(1), kind: "added" },
        });
      continue;
    }
    const removed = [];
    while (index - 1 < lines.length && lines[index - 1].startsWith("-")) {
      removed.push({ line: oldLine++, text: lines[index - 1].slice(1), kind: "removed" });
      if (index >= lines.length || !lines[index].startsWith("-")) break;
      index += 1;
    }
    const added = [];
    while (index < lines.length && lines[index].startsWith("+")) {
      added.push({ line: newLine++, text: lines[index].slice(1), kind: "added" });
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1)
      rows.push({ original: removed[offset] || null, current: added[offset] || null });
  }
  return rows.slice(0, MAX_ALIGNED_ROWS);
}

export function createGitDiffRenderer(initialDescriptor = {}) {
  let descriptor = initialDescriptor;
  let root;
  const render = (container) => {
    root = container;
    container.replaceChildren();
    container.className = "git-diff-renderer";
    const toolbar = document.createElement("header");
    toolbar.className = "git-diff-toolbar";
    const path = document.createElement("span");
    path.className = "git-diff-path";
    path.textContent = descriptor.displayPath || "Diff";
    path.title = descriptor.displayPath || "Diff";
    const comparison = document.createElement("span");
    comparison.className = "git-diff-comparison";
    const comparisonKey = descriptor.comparison || "changes";
    comparison.textContent = t(`git.comparison.${comparisonKey}`);
    toolbar.append(path, comparison);
    container.append(toolbar);

    const fallbackReason = descriptor.fallbackReason;
    if (fallbackReason || descriptor.truncated || descriptor.binary) {
      const fallback = document.createElement("section");
      fallback.className = "git-diff-fallback";
      const reason = document.createElement("p");
      reason.className = "git-diff-fallback-reason";
      reason.textContent =
        fallbackReason || (descriptor.truncated ? "Diff is truncated" : "Raw patch");
      const pre = document.createElement("pre");
      pre.textContent = descriptor.rawPatch || "";
      fallback.append(reason, pre);
      container.append(fallback);
      return;
    }
    const rows = descriptor.rows || parsePatch(descriptor.patch || descriptor.rawPatch || "");
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "git-diff-empty";
      empty.textContent = t("git.diffEmpty");
      container.append(empty);
      return;
    }
    const columns = document.createElement("div");
    columns.className = "git-diff-columns";
    const original = document.createElement("div");
    const current = document.createElement("div");
    original.className = "git-diff-column git-diff-original";
    current.className = "git-diff-column git-diff-current";
    for (const [column, label] of [
      [original, "Original"],
      [current, "Modified"],
    ]) {
      const header = document.createElement("div");
      header.className = "git-diff-column-header";
      header.textContent = label === "Original" ? t("git.diffOriginal") : t("git.diffModified");
      column.append(header);
    }
    for (const row of rows) {
      for (const [column, cell] of [
        [original, row.original],
        [current, row.current],
      ]) {
        const el = document.createElement("div");
        el.className = `git-diff-cell ${cell?.kind || "blank"}`;
        const gutter = document.createElement("span");
        gutter.className = "git-diff-gutter";
        gutter.textContent =
          cell?.line === null || cell?.line === undefined ? "" : String(cell.line);
        el.append(gutter, document.createTextNode(cell?.text || ""));
        column.append(el);
      }
    }
    let syncing = false;
    let syncFrame = null;
    const syncScroll = (source, target) => {
      if (syncing || syncFrame !== null) return;
      syncFrame = requestAnimationFrame(() => {
        syncFrame = null;
        syncing = true;
        target.scrollTop = source.scrollTop;
        syncing = false;
      });
    };
    original.addEventListener("scroll", () => syncScroll(original, current));
    current.addEventListener("scroll", () => syncScroll(current, original));
    columns.append(original, current);
    container.append(columns);
  };
  return {
    mount: render,
    update(next) {
      descriptor = next || descriptor;
      if (root) render(root);
    },
    destroy() {
      root?.replaceChildren();
      root = null;
    },
  };
}
