function titleCaseSkillName(name) {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function activeSlashQuery(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const beforeCursor = input.value.slice(0, cursor);
  const match = beforeCursor.match(/^\/([^\s/]*)$/);
  if (!match) return null;
  return { query: match[1].toLowerCase(), end: cursor };
}

function scopeLabel(scope) {
  if (scope === "project") return "Project";
  if (scope === "temporary") return "Temporary";
  return "Personal";
}

function cubeIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Z" />
      <path d="m4.3 7.6 7.7 4.5 7.7-4.5M12 12.1v8.7M8 5.1l8 4.6" />
    </svg>`;
}

export function setupSkillSlashCommand({ input, container, loadSkills }) {
  let skills = [];
  let loadPromise = null;
  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let updateGeneration = 0;

  container.setAttribute("role", "listbox");
  container.setAttribute("aria-label", "Skills");

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

  function select(index) {
    const skill = matches[index];
    const slash = activeSlashQuery(input);
    if (!skill || !slash) return;
    const suffix = input.value.slice(slash.end);
    const nextValue = `${skill.command} ${suffix}`;
    input.value = nextValue;
    input.setSelectionRange(skill.command.length + 1, skill.command.length + 1);
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

  function render() {
    const slash = activeSlashQuery(input);
    if (!slash) {
      close();
      return;
    }

    matches = skills.filter((skill) => {
      if (!slash.query) return true;
      return (
        skill.name.toLowerCase().includes(slash.query) ||
        skill.command.toLowerCase().includes(slash.query) ||
        skill.description.toLowerCase().includes(slash.query)
      );
    });
    selectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

    container.innerHTML = "";
    const heading = document.createElement("div");
    heading.className = "skill-slash-heading";
    heading.textContent = "Skills";
    container.appendChild(heading);

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "skill-slash-empty";
      empty.textContent = "No matching skills";
      container.appendChild(empty);
    } else {
      matches.forEach((skill, index) => {
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
        option.querySelector(".skill-slash-name").textContent = titleCaseSkillName(skill.name);
        option.querySelector(".skill-slash-description").textContent = skill.description;
        option.querySelector(".skill-slash-scope").textContent = scopeLabel(skill.scope);
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

  async function ensureSkills() {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(loadSkills)
        .then((loaded) => {
          skills = Array.isArray(loaded) ? loaded : [];
          return skills;
        });
    }
    const pendingLoad = loadPromise;
    try {
      await pendingLoad;
      return true;
    } catch (error) {
      console.warn("[Skills] Failed to load slash commands:", error);
      if (loadPromise === pendingLoad) loadPromise = null;
      skills = [];
      return false;
    }
  }

  async function update() {
    const generation = ++updateGeneration;
    if (!activeSlashQuery(input)) {
      close();
      return;
    }
    const loaded = await ensureSkills();
    if (loaded && generation === updateGeneration && activeSlashQuery(input)) render();
  }

  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", container.id);
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("input", update);
  input.addEventListener("click", update);
  input.addEventListener("keydown", (event) => {
    const isImeComposing = event.isComposing;
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

  return { close, update };
}

export { activeSlashQuery, titleCaseSkillName };
