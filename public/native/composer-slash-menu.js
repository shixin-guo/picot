function commandInvocation(command) {
  const name = command?.name ?? command?.command ?? "";
  if (!name) return "";
  return name.startsWith("/") ? name : `/${name}`;
}

export function titleCaseCommandName(name) {
  return String(name ?? "")
    .replace(/^\//, "")
    .replace(/^skill:/, "")
    .split(/[-_:\s/]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function activeSlashQuery(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const beforeCursor = input.value.slice(0, cursor);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return null;
  return { query: match[1].toLowerCase(), end: cursor };
}

function scopeLabel(scope) {
  if (scope === "project") return "Project";
  if (scope === "temporary") return "Temporary";
  if (scope === "picot") return "Picot";
  return "Personal";
}

function typeLabel(command) {
  if (command.type === "skill" || command.source === "skill") return "Skill";
  if (command.type === "prompt" || command.source === "prompt") return "Prompt";
  if (command.type === "builtin") return "Picot";
  return "Command";
}

function cubeIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" />
      <path d="m4.3 7.6 7.7 4.5 7.7-4.5M12 12.1v8.7M8 5.1l8 4.6" />
    </svg>`;
}

function normalizeCommands(commands) {
  return Array.from(commands ?? [])
    .map((command) => ({ ...command, command: commandInvocation(command) }))
    .filter((command) => command.command && command.capabilityState !== "disabled");
}

export function setupComposerSlashMenu({ input, container, commandButton = null, getCommands }) {
  if (!input || !container) return { close() {}, update() {}, openAll() {} };

  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let updateGeneration = 0;

  container.setAttribute("role", "listbox");
  container.setAttribute("aria-label", "Slash commands");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", container.id);
  input.setAttribute("aria-expanded", "false");

  function close() {
    updateGeneration += 1;
    open = false;
    matches = [];
    selectedIndex = 0;
    container.classList.add("hidden");
    container.innerHTML = "";
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }

  function ensureSlashQuery() {
    const slash = activeSlashQuery(input);
    if (slash) return slash;
    if (input.value.trim().length === 0) {
      input.value = "/";
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return { query: "", end: 1 };
    }
    return null;
  }

  function select(index) {
    const command = matches[index];
    const slash = activeSlashQuery(input);
    if (!command || !slash) return;
    const suffix = input.value.slice(slash.end);
    const invocation = command.command;
    input.value = `${invocation} ${suffix}`;
    input.setSelectionRange(invocation.length + 1, invocation.length + 1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    close();
  }

  function updateSelection() {
    const options = container.querySelectorAll(".skill-slash-option");
    options.forEach((option, index) => {
      const selected = index === selectedIndex;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    if (matches.length > 0) {
      input.setAttribute("aria-activedescendant", `skill-slash-option-${selectedIndex}`);
      options[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }

  function commandMatches(command, query) {
    if (!query) return true;
    return [
      command.name,
      command.command,
      command.description,
      titleCaseCommandName(command.name),
      typeLabel(command),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  }

  function render() {
    const slash = activeSlashQuery(input);
    if (!slash) {
      close();
      return;
    }

    matches = normalizeCommands(getCommands()).filter((command) =>
      commandMatches(command, slash.query),
    );
    selectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

    container.innerHTML = "";
    const heading = document.createElement("div");
    heading.className = "skill-slash-heading";
    heading.textContent = "Slash commands";
    container.appendChild(heading);

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "skill-slash-empty";
      empty.textContent = "No matching commands";
      container.appendChild(empty);
    } else {
      matches.forEach((command, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.id = `skill-slash-option-${index}`;
        option.className = "skill-slash-option";
        option.classList.toggle("selected", index === selectedIndex);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === selectedIndex));
        option.innerHTML = `
          <span class="skill-slash-icon">${cubeIcon()}</span>
          <span class="skill-slash-name"></span>
          <span class="skill-slash-description"></span>
          <span class="skill-slash-scope"></span>`;
        option.querySelector(".skill-slash-name").textContent = titleCaseCommandName(command.name);
        option.querySelector(".skill-slash-description").textContent =
          command.description || typeLabel(command);
        option.querySelector(".skill-slash-scope").textContent = scopeLabel(command.scope);
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
    input.setAttribute("aria-expanded", "true");
    updateSelection();
  }

  async function update() {
    const generation = ++updateGeneration;
    if (!activeSlashQuery(input)) {
      close();
      return;
    }
    await Promise.resolve();
    if (generation === updateGeneration && activeSlashQuery(input)) render();
  }

  async function openAll() {
    if (!ensureSlashQuery()) return;
    await update();
    input.focus();
  }

  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("keydown", (event) => {
    const isImeComposing = event.isComposing || event.keyCode === 229;
    if (isImeComposing) return;
    if (event.key === "Escape" && (open || activeSlashQuery(input))) {
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
  });
  input.addEventListener("blur", () => queueMicrotask(close));
  commandButton?.addEventListener("click", () => openAll());

  return { close, update, openAll };
}
