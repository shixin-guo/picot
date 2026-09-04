import { t } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import { buildSidebarSection, buildSidebarWorkspaceGroup } from "../../sidebar-workspace-group.js";

const DEFAULT_LIMIT_PER_MACHINE = 12;

export async function loadRemoteMachineSessions(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl("/v2/remote-sessions", { cache: "no-store" });
  if (!response.ok) throw new Error(t("sidebar.remoteMachinesUnavailable"));
  const payload = await response.json();
  return Array.isArray(payload?.machines) ? payload.machines : [];
}

export function buildRemoteMachineSection(
  machines,
  { onSelect, onCreate, limitPerMachine = DEFAULT_LIMIT_PER_MACHINE } = {},
) {
  const available = (machines ?? []).filter((machine) => machine?.id && machine?.name);
  if (available.length === 0) return null;

  const sessionCount = available.reduce(
    (count, machine) => count + (Array.isArray(machine.sessions) ? machine.sessions.length : 0),
    0,
  );
  const { section } = buildSidebarSection({
    region: "machines",
    titleKey: "sidebar.machines",
    count: sessionCount,
    expanded: true,
    renderSessions: (body) => {
      for (const machine of available) {
        const sessions = Array.isArray(machine.sessions)
          ? machine.sessions.slice(0, limitPerMachine)
          : [];
        const { group, header } = buildSidebarWorkspaceGroup({
          workspaceId: `machine:${machine.id}`,
          folderName: machine.name,
          workspacePath: machine.statusMessage || t("sidebar.remoteMachine"),
          sessionCount: machine.sessions?.length ?? 0,
          expanded: machine.status !== "offline",
          onNewChat:
            typeof onCreate === "function" && sessions.length > 0 && machine.status !== "offline"
              ? () => onCreate?.(sessions[0])
              : null,
          newChatTitleKey: "sidebar.newRemoteSession",
          renderSessions: (container) => {
            if (sessions.length === 0) {
              const empty = document.createElement("div");
              empty.className = "remote-machine-empty";
              empty.textContent =
                machine.status === "error"
                  ? t("sidebar.remoteMachineUnavailable")
                  : t("sidebar.noRemoteSessions");
              container.appendChild(empty);
              return;
            }
            for (const session of sessions) {
              container.appendChild(buildRemoteSessionItem(session, onSelect));
            }
          },
        });
        group.classList.add("remote-machine-group");
        header.classList.add(`remote-machine-${machine.status || "unknown"}`);
        const icon = createIcon("monitor", { size: 14 });
        const folderIcon = header.querySelector(".folder-icon");
        if (icon && folderIcon) {
          icon.classList.add("remote-machine-icon");
          folderIcon.replaceWith(icon);
        }
        body.appendChild(group);
      }
    },
  });
  section.classList.add("machines-group");
  return section;
}

function buildRemoteSessionItem(session, onSelect) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "session-item remote-session-item";
  item.dataset.sessionId = session.id;
  item.title = t("sidebar.openRemoteSession", { machine: session.machineName || "" });

  const titleRow = document.createElement("span");
  titleRow.className = "session-title-row";
  const title = document.createElement("span");
  title.className = "session-title";
  title.textContent = session.name || session.firstMessage || t("sidebar.emptySession");
  titleRow.appendChild(title);

  const remoteBadge = document.createElement("span");
  remoteBadge.className = "remote-session-badge";
  remoteBadge.textContent = t("sidebar.remoteBadge");
  titleRow.appendChild(remoteBadge);

  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = formatRemoteSessionTime(session.timestamp);
  item.append(titleRow, meta);
  item.addEventListener("click", () => onSelect?.(session));
  return item;
}

function formatRemoteSessionTime(timestamp) {
  const date = new Date(timestamp || "");
  if (Number.isNaN(date.getTime())) return "";
  const elapsedMinutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (elapsedMinutes < 1) return t("sidebar.justNow");
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  if (elapsedMinutes < 1_440) return `${Math.floor(elapsedMinutes / 60)}h`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
