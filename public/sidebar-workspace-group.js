// ABOUTME: Reusable sidebar region and workspace-group DOM builders for PINNED and PROJECTS.
// ABOUTME: Safe textContent-only rendering with disclosure semantics and inert hostile labels.

import { t } from "./i18n.js";
import { createIcon } from "./icons.js";

const FOLDER_CLOSED_ICON =
  '<svg class="folder-closed-icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

const FOLDER_OPEN_ICON =
  '<svg class="folder-open-icon" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

// Static disclosure arrow for the four section headers (RECENT, PINNED,
// PROJECTS, ARCHIVED). Points right when collapsed; CSS rotates it 90deg to
// point down when expanded.

export function createFolderIcon() {
  const icon = document.createElement("span");
  icon.className = "chevron folder-icon";
  icon.setAttribute("aria-hidden", "true");
  const doc = new DOMParser().parseFromString(
    `${FOLDER_CLOSED_ICON}${FOLDER_OPEN_ICON}`,
    "text/html",
  );
  icon.append(...doc.body.childNodes);
  return icon;
}

/**
 * Builds the disclosure arrow shared by all four sidebar section headers.
 * Exported so inline section builders (recent / archived in index.js) render
 * the exact same icon contract as buildSidebarSection.
 */
export function createSectionChevron() {
  const chevron = document.createElement("span");
  chevron.className = "chevron section-chevron";
  chevron.setAttribute("aria-hidden", "true");
  const icon = createIcon("chevron-right", { size: 16 });
  if (icon) chevron.appendChild(icon);
  return chevron;
}

function flipDisclosure(header, body, onToggle) {
  const next = header.getAttribute("aria-expanded") !== "true";
  header.setAttribute("aria-expanded", String(next));
  header.classList.toggle("collapsed", !next);
  body.classList.toggle("collapsed", !next);
  onToggle?.(next);
}

/**
 * Wires disclosure semantics onto a header/body pair.
 *
 * The header receives role=button, tabindex, and aria-expanded. Pointer
 * clicks, Enter, and Space all toggle the collapsed state. Clicks that
 * originate inside a nested <button> (new-chat, delete-all, etc.) are
 * ignored so action buttons never trigger folding.
 */
function wireDisclosure(header, body, expanded, onToggle) {
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", String(expanded));
  header.classList.toggle("collapsed", !expanded);
  body.classList.toggle("collapsed", !expanded);

  const runToggle = () => flipDisclosure(header, body, onToggle);

  header.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    runToggle();
  });

  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    runToggle();
  });
}

/**
 * Builds a collapsible sidebar region section (RECENT, PINNED, PROJECTS,
 * ARCHIVED).
 *
 * @param {object}  opts
 * @param {string}  opts.region          Region slug used for CSS classes.
 * @param {string}  opts.titleKey        i18n key for the section title.
 * @param {object}  [opts.titleParams]   Interpolation params for titleKey.
 * @param {number}  [opts.count]         Optional count badge value.
 * @param {boolean} [opts.expanded=true] Initial expanded state.
 * @param {function} [opts.onToggle]     Called with the new expanded boolean.
 * @param {function} [opts.renderSessions] Receives the sessions container element.
 * @param {function} [opts.renderFooter]  Receives a footer element (shown only when provided).
 * @returns {{ section: HTMLElement, header: HTMLElement, sessionsContainer: HTMLElement }}
 */
export function buildSidebarSection({
  region,
  titleKey,
  titleParams,
  count = null,
  expanded = true,
  onToggle = null,
  renderSessions = null,
  renderFooter = null,
}) {
  const section = document.createElement("div");
  section.className = `sidebar-section sidebar-section-${region}`;

  const header = document.createElement("div");
  header.className = `project-header sidebar-section-header sidebar-section-header-${region}`;

  header.appendChild(createSectionChevron());

  const title = document.createElement("span");
  title.className = "sidebar-section-title";
  title.textContent = t(titleKey, titleParams || {});
  header.appendChild(title);

  if (typeof count === "number") {
    const countEl = document.createElement("span");
    countEl.className = "project-count sidebar-section-count";
    countEl.textContent = String(count);
    header.appendChild(countEl);
  }

  section.appendChild(header);

  const sessionsContainer = document.createElement("div");
  sessionsContainer.className = "project-sessions sidebar-section-sessions";

  if (renderSessions) {
    renderSessions(sessionsContainer);
  }

  wireDisclosure(header, sessionsContainer, expanded, onToggle);

  section.appendChild(sessionsContainer);

  if (renderFooter) {
    const footer = document.createElement("div");
    footer.className = "sidebar-section-footer";
    renderFooter(footer);
    section.appendChild(footer);
  }

  return { section, header, sessionsContainer };
}

/**
 * Builds a single workspace group with a disclosure header, folder name,
 * session count, and an optional new-chat button. Used inside both PINNED
 * and PROJECTS regions.
 *
 * All dynamic values (folder name, path, count, labels) are assigned via
 * textContent or DOM properties — never innerHTML — so HTML-like content
 * is rendered as inert text.
 *
 * @param {object}  opts
 * @param {string}  opts.workspaceId         Stable ID for data-workspace-id.
 * @param {string}  opts.folderName          Folder name to display (inert text).
 * @param {string}  [opts.workspacePath]     Full path for the tooltip (inert).
 * @param {number}  [opts.sessionCount=0]    Non-archived session count.
 * @param {boolean} [opts.expanded=false]    Initial expanded state.
 * @param {function} [opts.onToggle]         Called with the new expanded boolean.
 * @param {function} [opts.onNewChat]        New-chat callback (button shown only when provided).
 * @param {function} [opts.onContextMenu]    Workspace context-menu callback.
 * @param {function} [opts.onMoreActions]    Workspace actions-button callback.
 * @param {string}  [opts.newChatTitleKey]   i18n key for the new-chat aria-label.
 * @param {string}  [opts.moreActionsTitleKey] i18n key for the actions-button aria-label.
 * @param {function} [opts.renderSessions]   Receives the sessions container element.
 * @param {function} [opts.renderFooter]     Receives a footer element (shown only when provided).
 * @returns {{ group: HTMLElement, header: HTMLElement, sessionsContainer: HTMLElement }}
 */
export function buildSidebarWorkspaceGroup({
  workspaceId,
  folderName,
  workspacePath,
  sessionCount = 0,
  expanded = false,
  onToggle = null,
  onNewChat = null,
  onContextMenu = null,
  onMoreActions = null,
  focusEnabled = false,
  onFocus = null,
  newChatTitleKey = "sidebar.newChat",
  moreActionsTitleKey = "sidebar.workspaceActions",
  renderSessions = null,
  renderFooter = null,
}) {
  const group = document.createElement("div");
  group.className = "project-group workspace-group";
  if (workspaceId) {
    group.dataset.workspaceId = workspaceId;
  }

  const header = document.createElement("div");
  header.className = "project-header workspace-header";

  header.appendChild(createFolderIcon());

  const nameEl = document.createElement("span");
  nameEl.className = "project-name workspace-name";
  nameEl.textContent = folderName;
  if (workspacePath) {
    nameEl.title = workspacePath;
  }
  header.appendChild(nameEl);

  const countEl = document.createElement("span");
  countEl.className = "project-count workspace-count";
  countEl.textContent = String(sessionCount);
  header.appendChild(countEl);

  if (onContextMenu) {
    header.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      onContextMenu(event);
    });
  }

  if (onMoreActions) {
    const label = t(moreActionsTitleKey, { path: folderName });
    const moreActionsBtn = document.createElement("button");
    moreActionsBtn.type = "button";
    moreActionsBtn.className = "workspace-more-actions-btn";
    moreActionsBtn.title = label;
    moreActionsBtn.setAttribute("aria-label", label);
    const moreIcon = createIcon("ellipsis", { size: 14 });
    if (moreIcon) moreActionsBtn.replaceChildren(moreIcon);
    else moreActionsBtn.replaceChildren();
    moreActionsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onMoreActions(event);
    });
    header.appendChild(moreActionsBtn);
  }

  if (onNewChat) {
    const label = t(newChatTitleKey, { path: folderName });
    const newChatBtn = document.createElement("button");
    newChatBtn.type = "button";
    newChatBtn.className = "project-new-chat-btn workspace-new-chat-btn";
    newChatBtn.title = label;
    newChatBtn.setAttribute("aria-label", label);
    const newChatIcon = createIcon("plus", { size: 12 });
    if (newChatIcon) newChatBtn.replaceChildren(newChatIcon);
    newChatBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onNewChat(event);
    });
    header.appendChild(newChatBtn);
  }

  if (focusEnabled && onFocus) {
    const label = t("workspace.focus");
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "workspace-focus-btn";
    focusBtn.title = label;
    focusBtn.setAttribute("aria-label", label);
    const focusIcon = createIcon("chevron-right", { size: 14 });
    if (focusIcon) focusBtn.replaceChildren(focusIcon);
    else focusBtn.replaceChildren();
    focusBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onFocus(event);
    });
    header.appendChild(focusBtn);
  }

  group.appendChild(header);

  const sessionsContainer = document.createElement("div");
  sessionsContainer.className = "project-sessions workspace-sessions";

  if (renderSessions) {
    renderSessions(sessionsContainer);
  }

  wireDisclosure(header, sessionsContainer, expanded, onToggle);

  group.appendChild(sessionsContainer);

  if (renderFooter) {
    const footer = document.createElement("div");
    footer.className = "workspace-group-footer";
    renderFooter(footer);
    group.appendChild(footer);
  }

  return { group, header, sessionsContainer };
}
