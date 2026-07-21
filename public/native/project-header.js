/**
 * project-header — populates the chat header with workspace path and git
 * branch info fetched from the host data plane.
 *
 * Responsibilities:
 *  - Show the full workspace path in the #workspace-indicator pill.
 *  - Show the current git branch in the #git-branch-indicator pill.
 *  - Both pills are hidden when data is unavailable.
 */

/**
 * @param {object} options
 * @param {import('./data-gateway.js').HostDataGateway} options.data
 * @param {string} options.workspaceId
 */
export async function setupProjectHeader({ data, workspaceId }) {
  const workspaceEl = document.getElementById("workspace-indicator");
  const branchEl = document.getElementById("git-branch-indicator");
  if (!workspaceEl && !branchEl) return;

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
  }

  if (branchEl) {
    if (info.gitBranch) {
      branchEl.textContent = info.gitBranch;
      branchEl.classList.remove("hidden");
    } else {
      branchEl.classList.add("hidden");
    }
  }
}
