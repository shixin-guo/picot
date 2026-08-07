// ABOUTME: Renders the Packages skills tab under Settings > Skills.
// ABOUTME: Shows bundled skill candidates from configured Pi packages. Switches are disabled placeholders.

import { onLocaleChange, t } from "../../i18n.js";

/**
 * @typedef {Object} PackageSkillCandidate
 * @property {string} id
 * @property {string} canonicalPath
 * @property {string} relativePath
 * @property {string} name
 * @property {string} description
 * @property {Array<{path?:string;message:string}>} diagnostics
 *
 * @typedef {Object} PackageSkillCard
 * @property {string} id
 * @property {string} source
 * @property {string} identity
 * @property {"global"|"project"} scope
 * @property {string|undefined} effectivePackageRoot
 * @property {string|undefined} version
 * @property {PackageSkillCandidate[]} candidates
 * @property {Array<{path?:string;message:string}>} diagnostics
 *
 * @typedef {Object} PackageSkillInventory
 * @property {"global"|"project"} scope
 * @property {boolean} trusted
 * @property {PackageSkillCard[]} packages
 * @property {Array<{path?:string;message:string}>} diagnostics
 */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "title") node.title = value;
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
 * Set up the Packages skills tab.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {(cmd:Object)=>Promise<Object>} opts.rpcCommand
 * @returns {{activate:()=>Promise<void>,setScope:(scope:"global"|"project")=>Promise<void>,refresh:()=>Promise<void>,destroy:()=>void}}
 */
export function setupPackageSkillsTab({ container, rpcCommand }) {
  let scope = "global";
  /** @type {PackageSkillInventory|null} */
  let inventory = null;
  let hasActivated = false;
  /** @type {Record<string,number>} */
  const scopeCounts = {};
  const expandedCards = new Set();
  let loadSeq = 0;
  let errorMessage = null;
  const unsubscribeLocale = onLocaleChange(() => render());

  function renderLoading() {
    container.replaceChildren(
      el("div", { class: "skills-loading", text: t("settings.packageSkills.loading") }),
    );
  }

  function renderError(message) {
    errorMessage = message || t("settings.packageSkills.loadFailed");
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

  /**
   * @param {"global"|"project"} nextScope
   */
  async function load(nextScope = scope) {
    scope = nextScope;
    errorMessage = null;
    const seq = ++loadSeq;
    renderLoading();
    /** @type {{success?:boolean;data?:PackageSkillInventory;error?:string}|undefined} */
    let response;
    try {
      response = await rpcCommand({ type: "list_package_skill_inventory", scope });
    } catch (e) {
      if (seq !== loadSeq) return;
      inventory = null;
      renderError(e instanceof Error ? e.message : t("settings.packageSkills.loadFailed"));
      return;
    }
    if (seq !== loadSeq) return;
    if (!response?.success) {
      inventory = null;
      renderError(response?.error);
      return;
    }
    inventory = response.data;
    // The effective package list is the combined set; counts reflect the
    // selected scope's emphasis but the list itself is not filtered.
    scopeCounts[scope] = inventory.packages.filter((p) => p.scope === scope).length;
    render();
  }

  async function activate() {
    if (hasActivated) return;
    hasActivated = true;
    await load(scope);
  }

  async function setScope(nextScope) {
    if (nextScope === scope) return;
    await load(nextScope);
  }

  function refresh() {
    return load(scope);
  }

  function renderScopeTabs() {
    const tabs = el("div", {
      class: "skills-scope-tabs",
      role: "group",
      aria: { label: t("settings.packageSkills.title") },
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

  // A disabled placeholder switch: package candidates are read-only Bundled
  // skills today, so neither a package nor an individual skill can be toggled
  // here. The control is rendered to match the Discovered tab's layout, with a
  // visible "Enable all" affordance on package headers, but stays disabled
  // until enable/disable is implemented.
  function renderDisabledSwitch(ariaLabel) {
    const button = el("button", {
      type: "button",
      class: "settings-toggle skills-switch",
      "aria-checked": "false",
      "aria-label": ariaLabel,
      role: "switch",
      disabled: true,
    });
    return button;
  }

  function renderEnableAllAffordance(card) {
    // Visible "Enable all" label + a disabled switch, mirroring a group card's
    // header control. Disabled because enable/disable is not yet wired.
    return el("div", { class: "skills-group-enable-all" }, [
      el("span", { class: "skills-enable-all-label", text: t("settings.packageSkills.enableAll") }),
      renderDisabledSwitch(`${t("settings.packageSkills.enableAll")}: ${card.source}`),
    ]);
  }

  /**
   * @param {PackageSkillCard} card
   */
  function renderCard(card) {
    const expanded = expandedCards.has(card.id);
    const installed = Boolean(card.effectivePackageRoot);
    const header = el("div", { class: "skills-group-header" }, [
      el("button", {
        type: "button",
        class: `skills-expand${expanded ? "" : " collapsed"}`,
        text: expanded ? "⌄" : "›",
        aria: {
          label: `${t("settings.packageSkills.package")}: ${card.source}`,
          expanded: String(expanded),
          controls: `skills-group-list-${card.id}`,
        },
        onClick: () => {
          if (expandedCards.has(card.id)) expandedCards.delete(card.id);
          else expandedCards.add(card.id);
          render();
        },
      }),
      el("div", { class: "skills-group-info" }, [
        el("div", { class: "skills-group-name", text: card.source }),
        el("div", { class: "skills-group-source" }, [
          el("span", {
            class: "package-skills-card-scope",
            text: t(`settings.packageSkills.${card.scope}`),
          }),
          card.version
            ? el("span", { class: "package-skills-card-version", text: `v${card.version}` })
            : null,
          el("span", {
            class: "package-skills-card-count",
            text: t("settings.packageSkills.candidateCount", { count: card.candidates.length }),
          }),
        ]),
      ]),
      renderEnableAllAffordance(card),
    ]);

    if (!installed) {
      header.appendChild(
        el("div", {
          class: "package-skills-not-installed",
          text: t("settings.packageSkills.notInstalled"),
        }),
      );
    }

    for (const d of card.diagnostics ?? []) {
      header.appendChild(el("div", { class: "package-skills-diagnostic", text: d.message }));
    }

    const listing = el(
      "div",
      {
        id: `skills-group-list-${card.id}`,
        class: "skills-group-listing",
      },
      expanded && installed ? card.candidates.map((cand) => renderCandidate(cand)) : [],
    );

    return el(
      "section",
      {
        class: `skills-group${expanded ? "" : " closed"}${installed ? "" : " not-installed"}`,
        dataset: { packageCard: card.id },
      },
      [header, listing],
    );
  }

  /**
   * @param {PackageSkillCandidate} candidate
   */
  function renderCandidate(candidate) {
    return el("div", { class: "skills-skill-row", dataset: { candidate: candidate.name } }, [
      el("div", { class: "skills-skill-info" }, [
        el("div", { class: "skills-skill-name", text: candidate.name }),
        el("div", { class: "skills-skill-description", text: candidate.description }),
        el("div", { class: "skills-skill-path" }, [
          el("code", {
            class: "package-skills-candidate-relative",
            text: candidate.relativePath,
            title: candidate.canonicalPath,
            aria: {
              label: `${t("settings.packageSkills.canonicalPath")}: ${candidate.canonicalPath}`,
            },
          }),
        ]),
        ...(candidate.diagnostics ?? []).map((d) =>
          el("div", { class: "package-skills-diagnostic", text: d.message }),
        ),
      ]),
      renderDisabledSwitch(`${t("settings.skills.enableSkill")}: ${candidate.name}`),
    ]);
  }

  function render() {
    const scrollTop = container.scrollTop;

    if (!inventory) {
      if (errorMessage) renderError(errorMessage);
      else renderLoading();
      return;
    }

    const untrusted = scope === "project" && !inventory.trusted;

    const fragment = document.createDocumentFragment();

    fragment.appendChild(
      el("div", { class: "skills-header" }, [
        el("div", {}, [
          el("h3", {
            class: "settings-section-title",
            text: t("settings.packageSkills.title"),
          }),
          el("p", {
            class: "skills-intro",
            text: t("settings.packageSkills.description"),
          }),
          el("p", {
            class: "package-skills-bundled-note",
            text: t("settings.packageSkills.bundledCandidates"),
          }),
        ]),
        el("button", {
          type: "button",
          class: "skills-rescan",
          text: t("settings.skills.rescan"),
          onClick: refresh,
        }),
      ]),
    );

    fragment.appendChild(renderScopeTabs());

    if (untrusted) {
      fragment.appendChild(
        el("div", {
          class: "skills-notice",
          text: t("settings.packageSkills.projectUntrusted"),
        }),
      );
    } else {
      const emphasized = inventory.packages.filter((p) => p.scope === scope);
      fragment.appendChild(
        el("div", { class: "skills-scope-meta" }, [
          el("span", {
            text: t("settings.packageSkills.scopeSummary", { count: emphasized.length }),
          }),
        ]),
      );
    }

    for (const d of inventory.diagnostics ?? []) {
      fragment.appendChild(
        el("div", {
          class: "package-skills-diagnostic package-skills-diagnostic-global",
          text: d.message,
        }),
      );
    }

    if (inventory.packages.length === 0) {
      fragment.appendChild(
        el("div", { class: "skills-empty", text: t("settings.packageSkills.empty") }),
      );
    } else {
      const list = el("div", { class: "skills-group-list" });
      for (const card of inventory.packages) list.appendChild(renderCard(card));
      fragment.appendChild(list);
    }

    container.replaceChildren(fragment);
    container.scrollTop = scrollTop;
  }

  function destroy() {
    unsubscribeLocale?.();
    container.replaceChildren();
  }

  return { activate, setScope, refresh, destroy };
}
