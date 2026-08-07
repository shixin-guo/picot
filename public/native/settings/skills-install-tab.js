// ABOUTME: Renders the opaque native local-skills installation flow in Settings.
// ABOUTME: Selects, scans, confirms, and installs sourceId-bound skill candidates only.

import { onLocaleChange, t } from "../../i18n.js";
import { manageModalDialog } from "./skills-modal.js";

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") {
      for (const [name, item] of Object.entries(value)) node.dataset[name] = item;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "aria") {
      for (const [name, item] of Object.entries(value)) node.setAttribute(`aria-${name}`, item);
    } else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child != null && child !== false)
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function collectCandidates(nodes) {
  return nodes.flatMap((node) =>
    node.kind === "skill" ? [node] : collectCandidates(node.children ?? []),
  );
}

/** @param {{container:HTMLElement, transport:{pickSkillSource:(workspaceId?:string|null)=>Promise<object|null>,scanSkillInstallSource:(sourceId:string)=>Promise<object>,installSkillLinks:(request:object)=>Promise<object>}, getWorkspaceId?:()=>string|null, isProjectTrusted:()=>boolean, showSuccess?:(message:string)=>void, showError?:(message:string)=>void}} opts */
export function setupSkillsInstallTab({
  container,
  transport,
  getWorkspaceId,
  isProjectTrusted,
  showSuccess,
  showError,
}) {
  let activated = false;
  let phase = "idle";
  let scan = null;
  let scope = "global";
  const selection = new Set();
  let error = null;
  /** Monotonic generation guard so a slow scan cannot overwrite a newer one. */
  let scanSeq = 0;
  /** Frozen snapshot captured at confirmation time; install submits this. */
  let pendingInstall = null;
  const unsubscribeLocale = onLocaleChange(() => render());
  /** Stable resolver for the Review button after a render rebuilds the DOM. */
  const reviewOpener = () => container.querySelector(".skills-install-review");

  function selectedItems() {
    if (!scan) return [];
    const nodes = new Map();
    const visit = (items) =>
      items.forEach((item) => {
        nodes.set(item.id, item);
        if (item.kind === "group") visit(item.children ?? []);
      });
    visit(scan.tree ?? []);
    return [...selection]
      .map((id) => nodes.get(id))
      .filter(Boolean)
      .map((item) => ({ kind: item.kind, id: item.id }));
  }

  function candidateState(node) {
    const children = node.kind === "group" ? collectCandidates(node.children ?? []) : [node];
    const selected = children.filter((item) => selection.has(item.id)).length;
    return {
      checked: selected === children.length && selected > 0,
      indeterminate: selected > 0 && selected < children.length,
    };
  }

  function toggleNode(node, checked) {
    const candidates = node.kind === "group" ? collectCandidates(node.children ?? []) : [node];
    for (const candidate of candidates) {
      if (checked) selection.add(candidate.id);
      else selection.delete(candidate.id);
    }
    render();
  }

  async function chooseSource() {
    const seq = ++scanSeq;
    phase = "scanning";
    error = null;
    render();
    try {
      const picked = await transport.pickSkillSource(getWorkspaceId?.());
      if (seq !== scanSeq) return; // superseded by a newer chooseSource
      if (!picked?.sourceId) {
        phase = "idle";
        render();
        return;
      }
      scan = await transport.scanSkillInstallSource(picked.sourceId, getWorkspaceId?.());
      if (seq !== scanSeq) return; // superseded while scanning
      selection.clear();
      for (const item of scan.defaultSelection ?? []) selection.add(item.id);
      phase = "selecting";
    } catch (cause) {
      if (seq !== scanSeq) return;
      phase = "error";
      error = cause instanceof Error ? cause.message : t("settings.installSkills.scanFailed");
      showError?.(error);
    }
    render();
  }

  function beginConfirmation() {
    if (!scan || selection.size === 0) return;
    phase = "confirming";
    render();
  }

  function cancelConfirmation() {
    phase = "selecting";
    pendingInstall = null;
    render();
  }

  async function install() {
    if (!scan || selection.size === 0) return;
    // Freeze the request snapshot from the confirmation dialog so that any
    // later changes to scope/selection during the in-flight install cannot
    // desync the UI from what is actually submitted.
    pendingInstall = {
      sourceId: scan.sourceId,
      scope,
      scanRevision: scan.scanRevision,
      selection: selectedItems(),
    };
    const workspaceId = getWorkspaceId?.();
    if (workspaceId) pendingInstall.workspaceId = workspaceId;
    phase = "installing";
    error = null;
    render();
    try {
      const result = await transport.installSkillLinks(pendingInstall);
      phase = "done";
      scan = { ...scan, result };
      showSuccess?.(t("settings.installSkills.restartRequired"));
    } catch (cause) {
      phase = "error";
      error = cause instanceof Error ? cause.message : t("settings.installSkills.installFailed");
      showError?.(error);
    }
    pendingInstall = null;
    render();
  }

  function renderNode(node) {
    const state = candidateState(node);
    const input = el("input", {
      type: "checkbox",
      class: "skills-install-checkbox",
      "aria-label": `${node.kind === "group" ? t("settings.installSkills.group") : t("settings.installSkills.skill")}: ${node.name}${node.kind === "skill" && node.description ? ` — ${node.description}` : ""}`,
      disabled: phase === "installing" ? "disabled" : undefined,
    });
    input.checked = state.checked;
    input.indeterminate = state.indeterminate;
    input.addEventListener("change", () => toggleNode(node, input.checked));
    const row = el("div", { class: "skills-install-node", dataset: { installNode: node.id } }, [
      input,
      el("div", { class: "skills-install-node-text" }, [
        el("strong", { text: node.name }),
        node.kind === "skill" ? el("span", { text: node.description }) : null,
      ]),
    ]);
    if (node.kind !== "group") return row;
    return el("div", { class: "skills-install-group" }, [
      row,
      el("div", { class: "skills-install-children" }, (node.children ?? []).map(renderNode)),
    ]);
  }

  function renderScope() {
    const projectTrusted = isProjectTrusted();
    const locked = phase === "installing";
    const tabs = el("div", {
      class: "skills-scope-tabs",
      role: "group",
      aria: { label: t("settings.installSkills.title") },
    });
    for (const value of ["global", "project"]) {
      const active = value === scope;
      const disabled = locked || (value === "project" && !projectTrusted);
      tabs.appendChild(
        el(
          "button",
          {
            type: "button",
            class: `skills-scope-tab${active ? " active" : ""}`,
            "aria-pressed": String(active),
            dataset: { scope: value },
            disabled: disabled ? true : undefined,
            onClick: () => {
              if (locked || value === scope) return;
              scope = value;
              render();
            },
          },
          [t(`settings.installSkills.${value}`)],
        ),
      );
    }
    if (!projectTrusted) {
      tabs.appendChild(
        el("span", {
          class: "skills-install-untrusted",
          text: t("settings.installSkills.projectUntrusted"),
        }),
      );
    }
    return tabs;
  }

  function render() {
    const content = [
      el("div", { class: "skills-header" }, [
        el("div", {}, [
          el("h3", { class: "settings-section-title", text: t("settings.installSkills.title") }),
          el("p", { class: "skills-intro", text: t("settings.installSkills.description") }),
        ]),
        el("button", {
          type: "button",
          class: "skills-rescan skills-install-choose",
          text: t("settings.installSkills.chooseFolder"),
          disabled: phase === "scanning" || phase === "installing" ? "disabled" : undefined,
          onClick: () => void chooseSource(),
        }),
      ]),
    ];
    if (phase === "scanning")
      content.push(
        el("div", { class: "skills-install-loading", text: t("settings.installSkills.scanning") }),
      );
    if (phase === "error")
      content.push(
        el("div", {
          class: "skills-install-error",
          text: error || t("settings.installSkills.scanFailed"),
        }),
      );
    if (
      scan &&
      (phase === "selecting" ||
        phase === "confirming" ||
        phase === "installing" ||
        phase === "done")
    ) {
      content.push(renderScope());
      content.push(el("div", { class: "skills-install-tree" }, (scan.tree ?? []).map(renderNode)));
      if (phase === "done") {
        const result = scan.result ?? {};
        content.push(
          el("div", {
            class: "skills-install-result",
            text: t("settings.installSkills.complete", {
              added: result.addedEntries?.length ?? 0,
              skipped: result.skippedEntries?.length ?? 0,
            }),
          }),
        );
      } else if (phase === "confirming") {
        const confirmId = "skills-install-confirm";
        content.push(
          el(
            "div",
            {
              class: "skills-install-confirmation",
              role: "alertdialog",
              "aria-modal": "true",
              "aria-labelledby": `${confirmId}-title`,
              "aria-describedby": `${confirmId}-desc`,
            },
            [
              el("h4", {
                id: `${confirmId}-title`,
                class: "skills-install-confirmation-title",
                text: t("settings.installSkills.confirmationHeading"),
              }),
              el("p", {
                id: `${confirmId}-desc`,
                text: t("settings.installSkills.confirmation", {
                  count: selection.size,
                  scope: t(`settings.installSkills.${scope}`),
                }),
              }),
              el("button", {
                type: "button",
                class: "skills-install-confirm",
                text: t("settings.installSkills.confirm"),
                onClick: () => void install(),
              }),
              el("button", {
                type: "button",
                class: "skills-install-cancel",
                text: t("settings.installSkills.cancel"),
                onClick: cancelConfirmation,
              }),
            ],
          ),
        );
      } else {
        content.push(
          el("button", {
            type: "button",
            class: "skills-install-review",
            text:
              phase === "installing"
                ? t("settings.installSkills.installing")
                : t("settings.installSkills.review"),
            disabled: selection.size === 0 || phase === "installing" ? "disabled" : undefined,
            onClick: beginConfirmation,
          }),
        );
      }
    }
    container.replaceChildren(...content);
    if (phase === "confirming") {
      manageModalDialog(container.querySelector(".skills-install-confirmation"), {
        initialFocus: container.querySelector(".skills-install-confirm"),
        restoreFocusTo: reviewOpener,
        inertRoot: document.body,
        owner: "skills-install",
        onCancel: cancelConfirmation,
      });
    } else {
      manageModalDialog(null, { owner: "skills-install" });
    }
  }

  async function activate() {
    if (activated) return;
    activated = true;
    render();
  }

  function destroy() {
    unsubscribeLocale?.();
    container.replaceChildren();
  }

  render();
  return { activate, destroy };
}
