/**
 * project-header — populates the chat header with workspace path and git
 * branch info fetched from the host data plane.
 *
 * Responsibilities:
 *  - Show the full workspace path in the #workspace-indicator pill.
 *  - Show the current git branch in the #git-branch-indicator pill.
 *  - Both pills are hidden when data is unavailable.
 *  - The workspace-path pill is clickable: it delegates to the `onOpenFiles`
 *    callback (provided by app.js) which expands the file sidebar and
 *    switches to the Files tab. This keeps the module decoupled from the
 *    sidebar/tab DOM wiring owned by app.js.
 */

import { onLocaleChange, t } from "../../i18n.js";

/**
 * @param {object} options
 * @param {import('./data-gateway.js').HostDataGateway} options.data
 * @param {string} options.workspaceId
 * @param {() => void} [options.onOpenFiles] Invoked when the workspace-path
 *   pill is clicked; app.js expands the file sidebar and activates the
 *   Files tab.
 */
export async function setupProjectHeader({ data, workspaceId, onOpenFiles } = {}) {
  const workspaceEl = document.getElementById("workspace-indicator");
  // #git-branch-indicator is the label span inside #diff-sidebar-toggle.
  // The toggle button itself carries the hidden class and is shown only when
  // git info is available.
  const branchLabelEl = document.getElementById("git-branch-indicator");
  const diffToggleEl = branchLabelEl?.closest("#diff-sidebar-toggle");
  if (!workspaceEl && !branchLabelEl) return;

  let info;
  try {
    const response = await data.workspaceInfo(workspaceId);
    info = response?.info;
  } catch {
    // Network or host error — leave pills hidden.
    return;
  }
  if (!info) return;

  if (workspaceEl && info.path) {
    workspaceEl.textContent = info.path;
    workspaceEl.title = info.path;
    workspaceEl.classList.remove("hidden");
    // Make the path pill behave like a button that opens the Files tab.
    if (typeof onOpenFiles === "function") {
      workspaceEl.classList.add("clickable-pill");
      workspaceEl.setAttribute("role", "button");
      workspaceEl.setAttribute("tabindex", "0");
      const applyAriaLabel = () =>
        workspaceEl.setAttribute(
          "aria-label",
          t("migrated.index.ariaLabel.openFilesPanel", { path: info.path }),
        );
      applyAriaLabel();
      // Keep the label current when the user switches language mid-session.
      onLocaleChange(applyAriaLabel);
      workspaceEl.addEventListener("click", onOpenFiles);
      workspaceEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenFiles();
        }
      });
    }
  }

  if (diffToggleEl) {
    if (info.gitBranch) {
      if (branchLabelEl) branchLabelEl.textContent = info.gitBranch;
      diffToggleEl.title = `Git changes — ${info.gitBranch}`;
      diffToggleEl.classList.remove("hidden");
    } else {
      diffToggleEl.classList.add("hidden");
    }
  }
}
