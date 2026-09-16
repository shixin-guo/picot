// `#` picker for delegating a task to an external Agent Client Protocol (ACP)
// subagent (Claude Code, ...). Modeled on composer-slash-menu.js but simpler:
// the catalog is a short static list, and selecting an entry replaces the
// `#query` with a `#<token> ` prefix so the user types the task after it
// (`#claude fix the failing test`). `onSelect` is an optional hook.

export function activeHashQuery(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const beforeCursor = input.value.slice(0, cursor);
  const match = beforeCursor.match(/^#([^\s#]*)$/);
  if (!match) return null;
  return { query: match[1].toLowerCase(), end: cursor };
}

export function matchAgents(agents, query) {
  if (!query) return agents;
  return agents.filter((agent) =>
    [agent.id, agent.label, agent.description].some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query),
    ),
  );
}

export function setupComposerAgentMenu({ input, container, getAgents, onSelect = () => {} }) {
  if (!input || !container) return { close() {}, update() {} };

  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let updateGeneration = 0;

  container.setAttribute("role", "listbox");
  container.setAttribute("aria-label", "Agents");
  input.setAttribute("aria-autocomplete", "list");

  function close() {
    updateGeneration += 1;
    open = false;
    matches = [];
    selectedIndex = 0;
    container.classList.add("hidden");
    container.innerHTML = "";
    input.removeAttribute("aria-activedescendant");
  }

  function select(index) {
    const agent = matches[index];
    const hash = activeHashQuery(input);
    if (!agent || !hash) return;
    const prefix = `#${agent.token ?? agent.id} `;
    input.value = prefix + input.value.slice(hash.end);
    input.setSelectionRange(prefix.length, prefix.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    close();
    onSelect(agent);
  }

  function updateSelection() {
    const options = container.querySelectorAll(".skill-slash-option");
    options.forEach((option, index) => {
      const selected = index === selectedIndex;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    if (matches.length > 0) {
      input.setAttribute("aria-activedescendant", `agent-picker-option-${selectedIndex}`);
      options[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }

  function render() {
    const hash = activeHashQuery(input);
    if (!hash) {
      close();
      return;
    }
    matches = matchAgents(getAgents(), hash.query);
    selectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

    container.innerHTML = "";
    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "skill-slash-empty";
      empty.textContent = "No matching agents";
      container.appendChild(empty);
    } else {
      matches.forEach((agent, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `agent-picker-option-${index}`;
        option.className = "skill-slash-option agent-picker-option";
        option.classList.toggle("selected", index === selectedIndex);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === selectedIndex));
        option.innerHTML = `
          <span class="skill-slash-name"></span>
          <span class="skill-slash-description"></span>`;
        option.querySelector(".skill-slash-name").textContent = agent.label;
        option.querySelector(".skill-slash-description").textContent = agent.description ?? "";
        option.addEventListener("mouseenter", () => {
          selectedIndex = index;
          updateSelection();
        });
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", () => select(index));
        container.appendChild(option);
      });
    }

    open = true;
    container.classList.remove("hidden");
    updateSelection();
  }

  async function update() {
    const generation = ++updateGeneration;
    if (!activeHashQuery(input)) {
      close();
      return;
    }
    await Promise.resolve();
    if (generation === updateGeneration && activeHashQuery(input)) render();
  }

  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener(
    "keydown",
    (event) => {
      const isImeComposing = event.isComposing || event.keyCode === 229;
      if (isImeComposing) return;
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (!open) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (matches.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
        updateSelection();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && matches.length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select(selectedIndex);
      }
    },
    { capture: true },
  );
  input.addEventListener("blur", () => queueMicrotask(close));

  return { close, update };
}
