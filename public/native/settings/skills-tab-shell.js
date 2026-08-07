// ABOUTME: Composes the three Settings > Skills tabs with accessible keyboard navigation.
// ABOUTME: Keeps child tab state alive while lazy-activating a selected child exactly once.

export function setupSkillsTabShell({ tabs, panels, activate }) {
  const tabList = [...tabs];
  let selected = tabList.find((tab) => tab.classList.contains("active")) ?? tabList[0];

  function select(tab, { focus = false } = {}) {
    if (!tabList.includes(tab)) return;
    selected = tab;
    const name = tab.dataset.skillsPageTab;
    for (const candidate of tabList) {
      const active = candidate === tab;
      candidate.classList.toggle("active", active);
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
    }
    for (const [panelName, panel] of Object.entries(panels)) {
      panel?.classList.toggle("hidden", panelName !== name);
    }
    void activate?.(name);
    if (focus) tab.focus();
  }

  for (const tab of tabList) {
    tab.tabIndex = tab === selected ? 0 : -1;
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = tabList.indexOf(tab);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabList.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + tabList.length) % tabList.length;
      select(tabList[next], { focus: true });
    });
  }

  // Activate the default tab on init so its first panel (Discovered) loads
  // its data instead of staying on the construction-time Loading placeholder.
  select(selected);

  return { select, destroy: () => {} };
}
