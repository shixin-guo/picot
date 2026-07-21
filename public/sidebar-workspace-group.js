// ABOUTME: Reusable sidebar region and workspace-group DOM builders for PINNED and PROJECTS.
// ABOUTME: Safe textContent-only rendering with disclosure semantics and inert hostile labels.

import { t } from "./i18n.js";

/**
 * Static plus-icon SVG for the new-chat button. This is a fixed constant —
 * never interpolated with dynamic values — so innerHTML is safe here.
 */
const NEW_CHAT_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

function createChevron() {
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "\u25BC";
  chevron.setAttribute("aria-hidden", "true");
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

  header.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    flipDisclosure(header, body, onToggle);
  });

  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    flipDisclosure(header, body, onToggle);
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

  header.appendChild(createChevron());

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

  header.appendChild(createChevron());

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
    moreActionsBtn.textContent = "…";
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
    newChatBtn.innerHTML = NEW_CHAT_ICON;
    newChatBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onNewChat(event);
    });
    header.appendChild(newChatBtn);
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
