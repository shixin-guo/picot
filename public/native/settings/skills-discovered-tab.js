// ABOUTME: Renders the Discovered tab from the server-authoritative Pi skill inventory.
// ABOUTME: Owns Claude root enablement and existing skill toggle/tree behavior.

import { onLocaleChange, t } from "../../i18n.js";
import { manageModalDialog } from "./skills-modal.js";

/**
 * @typedef {Object} SkillInventoryItem
 * @property {"skill"} kind
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {boolean} enabled
 * @property {string} status
 * @property {string} ruleRelativeDir
 * @property {string} ruleBaseDir
 * @property {string} scope
 * @property {string} sourceRoot
 * @property {boolean} ambiguous
 * @property {{id:string;canonicalPath:string;name:string}|undefined} shadowedBy
 *
 * @typedef {Object} SkillGroupNode
 * @property {"group"} kind
 * @property {string} id
 * @property {string} sourceRoot
 * @property {string} ruleBaseRelativePath
 * @property {string} name
 * @property {string} scope
 * @property {"all-on"|"all-off"|"mixed"} state
 * @property {boolean} ambiguous
 * @property {(SkillInventoryItem|SkillGroupNode)[]} children
 *
 * @typedef {Object} SkillRoot
 * @property {string} sourceRoot
 * @property {string} ruleBaseDir
 * @property {string} scope
 * @property {(SkillInventoryItem|SkillGroupNode)[]} children
 *
 * @typedef {Object} SkillInventory
 * @property {string} scope
 * @property {string} settingsPath
 * @property {boolean} trusted
 * @property {SkillRoot[]} roots
 * @property {string[]} customRules
 * @property {string[]} discoveredRoots
 * @property {Array<{path?:string;message:string}>} diagnostics
 */

function expectedScopeFor(scope) {
  return scope === "global" ? "user" : "project";
}

function flatLeaves(node) {
  const out = [];
  for (const c of node.children ?? []) {
    if (c.kind === "skill") out.push(c);
    else out.push(...flatLeaves(c));
  }
  return out;
}

function countGroups(node) {
  let n = 0;
  for (const c of node.children ?? []) {
    if (c.kind === "group") n += 1 + countGroups(c);
  }
  return n;
}

function rootsForScope(inventory, scope) {
  const want = expectedScopeFor(scope);
  return (inventory?.roots ?? []).filter((r) => r.scope === want);
}

function countItems(inventory, scope) {
  return rootsForScope(inventory, scope).reduce((n, r) => n + flatLeaves(r).length, 0);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "aria") {
      for (const [ak, av] of Object.entries(value)) node.setAttribute(`aria-${ak}`, av);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {(cmd:Object)=>Promise<Object>} opts.rpcCommand
 * @param {(msg:string)=>void} [opts.showSuccess]
 * @param {(msg:string)=>void} [opts.showError]
 */
export function setupDiscoveredSkillsTab({ container, rpcCommand, showSuccess, showError }) {
  let scope = "global";
  /** @type {SkillInventory|null} */
  let inventory = null;
  let hasActivated = false;
  /** @type {Record<string, number>} */
  const scopeCounts = {};
  // Groups start collapsed; a user expands one by adding its id here.
  const expandedGroups = new Set();
  const pendingTargets = new Set();
  let loadSeq = 0;
  let errorMessage = null;
  let confirmingClaudeRoot = null;
  let addingClaudeRoot = false;
  let claudeRootOpenerSourceRoot = null;
  /** Stable resolver for the root's Add button after a render rebuilds the DOM. */
  const claudeRootOpener = () =>
    [...container.querySelectorAll("[data-skill-root]")]
      .find((root) => root.dataset.skillRoot === claudeRootOpenerSourceRoot)
      ?.querySelector(".skills-add-root") ?? null;
  const unsubscribeLocale = onLocaleChange(() => render());

  function renderLoading() {
    container.replaceChildren(
      el("div", { class: "skills-loading", text: t("settings.skills.loading") }),
    );
  }

  function renderError(message) {
    errorMessage = message || t("settings.skills.loadFailed");
    container.replaceChildren(
      el("div", { class: "skills-error" }, [
        el("span", { text: errorMessage }),
        el("button", {
          type: "button",
          class: "skills-rescan",
          text: t("settings.skills.rescan"),
          onClick: () => void load(scope),
        }),
      ]),
    );
  }

  async function load(nextScope = scope) {
    scope = nextScope;
    errorMessage = null;
    const seq = ++loadSeq;
    renderLoading();
    let response;
    try {
      response = await rpcCommand({ type: "list_skill_inventory", scope });
    } catch (e) {
      if (seq !== loadSeq) return;
      inventory = null;
      renderError(e instanceof Error ? e.message : t("settings.skills.loadFailed"));
      return;
    }
    if (seq !== loadSeq) return;
    if (!response?.success) {
      inventory = null;
      renderError(response?.error);
      return;
    }
    inventory = response.data;
    scopeCounts[scope] = countItems(inventory, scope);
    const other = scope === "global" ? "project" : "global";
    scopeCounts[other] = countItems(inventory, other);
    if (seq !== loadSeq) return;
    render();
  }

  async function activate() {
    if (hasActivated) return;
    hasActivated = true;
    await load(scope);
  }

  function beginClaudeRootConfirmation(root) {
    claudeRootOpenerSourceRoot = root.sourceRoot;
    confirmingClaudeRoot = root;
    render();
  }

  function cancelClaudeRootConfirmation() {
    if (addingClaudeRoot) return;
    confirmingClaudeRoot = null;
    render();
  }

  async function addClaudeRoot(root) {
    if (addingClaudeRoot) return;
    addingClaudeRoot = true;
    render();
    const mutationScope = scope;
    const mutationSeq = loadSeq;
    let response;
    try {
      response = await rpcCommand({
        type: "skill_add_root",
        scope: mutationScope,
        kind: root.rootKind,
      });
    } catch (error) {
      showError?.(error instanceof Error ? error.message : t("settings.skills.addRootFailed"));
      addingClaudeRoot = false;
      render();
      return;
    }
    if (!response?.success) {
      showError?.(response?.error || t("settings.skills.addRootFailed"));
      addingClaudeRoot = false;
      render();
      return;
    }
    if (scope !== mutationScope || loadSeq !== mutationSeq) {
      addingClaudeRoot = false;
      if (scope === mutationScope) void load(scope);
      return;
    }
    inventory = response.data?.inventory ?? response.data;
    confirmingClaudeRoot = null;
    addingClaudeRoot = false;
    showSuccess?.(t("settings.skills.rootAddedRestartRequired"));
    render();
  }

  async function setEnabled(target, enabled) {
    const mutationScope = scope;
    const mutationSeq = loadSeq;
    pendingTargets.add(target.id);
    render();
    let response;
    try {
      response = await rpcCommand({ type: "set_skill_enabled", scope, target, enabled });
    } catch (e) {
      pendingTargets.delete(target.id);
      showError?.(e instanceof Error ? e.message : t("settings.skills.saveFailed"));
      render();
      return;
    }
    pendingTargets.delete(target.id);
    if (!response?.success) {
      showError?.(response?.error || t("settings.skills.saveFailed"));
      render();
      return;
    }
    if (scope !== mutationScope || loadSeq !== mutationSeq) {
      if (scope === mutationScope) void load(scope);
      return;
    }
    inventory = response.data.inventory;
    scopeCounts.global = countItems(inventory, "global");
    scopeCounts.project = countItems(inventory, "project");
    showSuccess?.(t("settings.skills.savedRestartRequired"));
    render();
  }

  function rescan() {
    void load(scope);
  }

  function renderScopeTabs() {
    const tabs = el("div", {
      class: "skills-scope-tabs",
      role: "group",
      aria: { label: t("settings.skills.title") },
    });
    for (const s of ["global", "project"]) {
      const count = scopeCounts[s];
      const active = s === scope;
      tabs.appendChild(
        el(
          "button",
          {
            type: "button",
            class: `skills-scope-tab${active ? " active" : ""}`,
            "aria-pressed": String(active),
            dataset: { scope: s },
            onClick: () => {
              if (s !== scope) void load(s);
            },
          },
          [
            t(`settings.skills.${s}`),
            count !== undefined ? el("small", { text: ` ${count}` }) : null,
          ],
        ),
      );
    }
    return tabs;
  }

  function renderSwitch(checked, disabled, indeterminate, ariaLabel, onChange) {
    // Reuse the General/Providers tab's sliding toggle (`.settings-toggle`)
    // instead of a raw checkbox so Skills matches the rest of Settings.
    // Group rows may be in a mixed state (some children on, some off); we
    // expose that via a `data-mixed` attribute and a dedicated CSS variant.
    const button = el("button", {
      type: "button",
      class: `settings-toggle skills-switch${indeterminate ? " mixed" : ""}`,
      "aria-checked": String(Boolean(checked)),
      "aria-label": ariaLabel,
      role: "switch",
    });
    if (checked) button.classList.add("on");
    if (indeterminate) button.dataset.mixed = "true";
    if (disabled) button.disabled = true;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      onChange(!button.classList.contains("on"));
    });
    return button;
  }

  function stateBadge(state, enabled, total) {
    const label =
      state === "all-on"
        ? t("settings.skills.allEnabled")
        : state === "all-off"
          ? t("settings.skills.allDisabled")
          : t("settings.skills.enabledCount", { enabled, total });
    return el("span", {
      class: `skills-group-status ${state}`,
      text: label,
      dataset: { skillGroupState: state },
    });
  }

  function renderRoot(root, rootDisabled) {
    const rootBasename = root.sourceRoot.split("/").pop() || root.sourceRoot;
    const isClaude = root.rootKind === "claude-global" || root.rootKind === "claude-project";
    const canAddRoot =
      isClaude && !root.configuredForPi && !(root.scope === "project" && rootDisabled);
    return el("section", { class: "skills-root", dataset: { skillRoot: root.sourceRoot } }, [
      el("div", { class: "skills-root-header" }, [
        el("div", {}, [
          el("code", { class: "skills-root-path", text: root.sourceRoot }),
          el("span", {
            class: "skills-root-scope",
            text: t(`settings.skills.${root.scope === "user" ? "global" : "project"}`),
          }),
        ]),
        canAddRoot
          ? el("button", {
              type: "button",
              class: "skills-add-root",
              text: t("settings.skills.addRoot"),
              onClick: () => beginClaudeRootConfirmation(root),
            })
          : null,
      ]),
      el(
        "div",
        { class: "skills-root-children" },
        renderTopChildren(root.children, rootDisabled, rootBasename),
      ),
    ]);
  }

  // Top-level children of a root: skills that sit directly under a sourceRoot
  // (not inside a group container) are aggregated into ONE card titled with
  // the root basename ("skills"), with one skill row each. Real group
  // containers render as their own group cards.
  function renderTopChildren(children, parentDisabled, rootBasename) {
    const result = [];
    const topSkills = children.filter((c) => c.kind === "skill");
    if (topSkills.length > 0) {
      result.push(renderTopSkillsCard(topSkills, parentDisabled, rootBasename));
    }
    for (const c of children) {
      if (c.kind === "group") result.push(renderGroupNode(c, parentDisabled));
    }
    return result;
  }

  function renderChildren(children, parentDisabled) {
    return children.map((c) =>
      c.kind === "skill" ? renderSkillRow(c, parentDisabled) : renderGroupNode(c, parentDisabled),
    );
  }

  function renderTopSkillsCard(skills, parentDisabled, rootBasename) {
    // Skills directly under a sourceRoot are not a real group — the root
    // directory itself cannot be enabled/disabled as a unit — so the card
    // header carries only the folder name and no switch; each skill row has
    // its own switch.
    return el(
      "section",
      { class: "skills-group skills-single-skill", dataset: { skillCard: rootBasename } },
      [
        el("div", { class: "skills-group-header skills-group-header-readonly" }, [
          el("div", { class: "skills-group-info" }, [
            el("div", { class: "skills-group-name", text: rootBasename }),
          ]),
        ]),
        el(
          "div",
          { class: "skills-group-listing" },
          skills.map((s) => renderSkillRow(s, parentDisabled)),
        ),
      ],
    );
  }

  function renderGroupNode(group, parentDisabled) {
    const expanded = expandedGroups.has(group.id);
    const leaves = flatLeaves(group);
    const enabled = leaves.filter((i) => i.status === "enabled").length;
    const groupPending = pendingTargets.has(group.id);
    const groupDisabled = parentDisabled || group.ambiguous || groupPending;

    const header = el("div", { class: "skills-group-header" }, [
      el("button", {
        type: "button",
        class: `skills-expand${expanded ? "" : " collapsed"}`,
        text: expanded ? "⌄" : "›",
        aria: {
          label: `${t("settings.skills.source")}: ${group.ruleBaseRelativePath}`,
          expanded: String(expanded),
          controls: `skills-group-list-${group.id}`,
        },
        onClick: () => {
          if (expandedGroups.has(group.id)) expandedGroups.delete(group.id);
          else expandedGroups.add(group.id);
          render();
        },
      }),
      el("div", { class: "skills-group-info" }, [
        el("div", { class: "skills-group-name", text: group.name }),
        el("div", { class: "skills-group-source", text: group.ruleBaseRelativePath }),
      ]),
      stateBadge(group.state, enabled, leaves.length),
      renderSwitch(
        group.state === "all-on",
        groupDisabled,
        group.state === "mixed",
        `${t("settings.skills.enableGroup")}: ${group.ruleBaseRelativePath}`,
        (checked) => void setEnabled({ kind: "group", id: group.id }, checked),
      ),
    ]);

    if (group.ambiguous) {
      header.appendChild(
        el("div", {
          class: "skills-ambiguous-note",
          text: t("settings.skills.ambiguousRuleTarget"),
        }),
      );
    }

    const listing = el(
      "div",
      { id: `skills-group-list-${group.id}`, class: "skills-group-listing" },
      expanded ? renderChildren(group.children, groupDisabled) : [],
    );

    return el(
      "section",
      {
        class: `skills-group${expanded ? "" : " closed"}`,
        dataset: { skillGroup: group.id },
      },
      [header, listing],
    );
  }

  function renderSkillRow(item, parentDisabled = false) {
    const shadowed = item.status === "shadowed";
    const rowDisabled = item.ambiguous || shadowed || pendingTargets.has(item.id) || parentDisabled;
    return el(
      "div",
      { class: "skills-skill-row", dataset: { skillRow: item.name, skillToggle: item.name } },
      [
        el("div", { class: "skills-skill-info" }, [
          el("div", { class: "skills-skill-name", text: item.name }),
          el("div", { class: "skills-skill-description", text: item.description }),
          shadowed && item.shadowedBy
            ? el("div", {
                class: "skills-shadowed-note",
                text: t("settings.skills.shadowedBy", { name: item.shadowedBy.name }),
              })
            : null,
        ]),
        renderSwitch(
          item.status === "enabled",
          rowDisabled,
          false,
          `${t("settings.skills.enableSkill")}: ${item.name}`,
          (checked) => void setEnabled({ kind: "skill", id: item.id }, checked),
        ),
      ],
    );
  }

  function render() {
    const scrollTop = container.scrollTop;

    if (!inventory) {
      if (errorMessage) renderError(errorMessage);
      else renderLoading();
      return;
    }

    const visibleRoots = rootsForScope(inventory, scope);
    const untrusted = scope === "project" && !inventory.trusted;
    const total = visibleRoots.reduce((n, r) => n + flatLeaves(r).length, 0);
    const groupCount = visibleRoots.reduce((n, r) => n + countGroups(r), 0);
    const rootDisabled = untrusted;

    const fragment = document.createDocumentFragment();

    fragment.appendChild(
      el("div", { class: "skills-header" }, [
        el("div", {}, [
          el("h3", { class: "settings-section-title", text: t("settings.skills.title") }),
          el("p", { class: "skills-intro", text: t("settings.skills.description") }),
        ]),
        el("button", {
          type: "button",
          class: "skills-rescan",
          text: t("settings.skills.rescan"),
          onClick: rescan,
        }),
      ]),
    );

    fragment.appendChild(renderScopeTabs());

    if (untrusted) {
      fragment.appendChild(
        el("div", { class: "skills-notice", text: t("settings.skills.projectUntrusted") }),
      );
    }

    fragment.appendChild(
      el("div", { class: "skills-scope-meta" }, [
        el("span", { text: t("settings.skills.scopeSummary", { total, groups: groupCount }) }),
      ]),
    );

    if (confirmingClaudeRoot) {
      const dialogId = "skills-claude-root-confirm";
      fragment.appendChild(
        el(
          "div",
          {
            class: "skills-add-root-confirmation",
            role: "alertdialog",
            "aria-modal": "true",
            "aria-labelledby": `${dialogId}-title`,
            "aria-describedby": `${dialogId}-desc`,
          },
          [
            el("h4", {
              id: `${dialogId}-title`,
              class: "skills-add-root-confirmation-title",
              text: t("settings.skills.addRootConfirmation"),
            }),
            el("div", { id: `${dialogId}-desc` }, [
              el("code", { text: confirmingClaudeRoot.sourceRoot }),
              el("code", { text: confirmingClaudeRoot.settingsPath || "" }),
              el("code", { text: confirmingClaudeRoot.recommendedEntry || "" }),
            ]),
            el("button", {
              type: "button",
              class: "skills-add-root-confirm",
              text: t("settings.skills.addRootConfirm"),
              disabled: addingClaudeRoot ? "disabled" : undefined,
              onClick: () => void addClaudeRoot(confirmingClaudeRoot),
            }),
            el("button", {
              type: "button",
              class: "skills-add-root-cancel",
              text: t("settings.skills.addRootCancel"),
              disabled: addingClaudeRoot ? "disabled" : undefined,
              onClick: cancelClaudeRootConfirmation,
            }),
          ],
        ),
      );
    }

    if (inventory.customRules && inventory.customRules.length > 0) {
      fragment.appendChild(
        el("div", { class: "skills-custom-rules" }, [
          el("div", { class: "skills-custom-rules-label", text: t("settings.skills.customRules") }),
          ...inventory.customRules.map((r) => el("code", { class: "skills-custom-rule", text: r })),
        ]),
      );
    }

    for (const d of inventory.diagnostics ?? []) {
      console.warn("[skills] diagnostic:", d.message);
    }

    if (visibleRoots.length === 0 || total === 0) {
      fragment.appendChild(el("div", { class: "skills-empty", text: t("settings.skills.empty") }));
    } else {
      const list = el("div", { class: "skills-group-list" });
      for (const root of visibleRoots) list.appendChild(renderRoot(root, rootDisabled));
      fragment.appendChild(list);
    }

    container.replaceChildren(fragment);
    container.scrollTop = scrollTop;
    if (confirmingClaudeRoot) {
      manageModalDialog(container.querySelector(".skills-add-root-confirmation"), {
        initialFocus: container.querySelector(".skills-add-root-confirm"),
        restoreFocusTo: claudeRootOpener,
        inertRoot: document.body,
        owner: "skills-discovered",
        onCancel: cancelClaudeRootConfirmation,
      });
    } else {
      manageModalDialog(null, { owner: "skills-discovered" });
    }
  }

  function destroy() {
    unsubscribeLocale?.();
    container.replaceChildren();
  }

  return {
    activate,
    load,
    destroy,
    isProjectTrusted: () => Boolean(inventory?.trusted),
  };
}
