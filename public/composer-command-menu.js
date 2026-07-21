// ABOUTME: Renders and manages a composer-scoped Commands menu for chat surfaces.
// ABOUTME: Keeps menu lifecycle, disabled actions, and outside-click cleanup consistent.

export function setupComposerCommandMenu({
  button,
  menu,
  list,
  getCommands,
  document: doc,
  overlay = null,
}) {
  const close = () => {
    menu.classList.add("hidden");
    overlay?.classList.add("hidden");
  };
  const open = () => {
    list.replaceChildren();
    for (const command of getCommands()) {
      const item = doc.createElement(command.desc ? "div" : "button");
      item.className = "command-item";
      item.classList.toggle("disabled", Boolean(command.disabled));
      if (command.disabled) item.setAttribute("aria-disabled", "true");
      if (item instanceof HTMLButtonElement) {
        item.type = "button";
        item.textContent = command.label;
        item.disabled = Boolean(command.disabled);
      } else {
        const icon = doc.createElement("div");
        icon.className = "command-icon";
        icon.textContent = command.icon || "";
        const details = doc.createElement("div");
        const label = doc.createElement("div");
        label.className = "command-label";
        label.textContent = command.label;
        const description = doc.createElement("div");
        description.className = "command-desc";
        description.textContent = command.desc;
        details.append(label, description);
        item.append(icon, details);
      }
      item.addEventListener("click", async () => {
        close();
        if (!command.disabled) await command.action();
      });
      list.appendChild(item);
    }
    menu.classList.remove("hidden");
    overlay?.classList.remove("hidden");
  };
  const onButtonClick = () => {
    if (button.disabled) return;
    if (menu.classList.contains("hidden")) open();
    else close();
  };
  const onDocumentClick = (event) => {
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  };
  button.addEventListener("click", onButtonClick);
  doc.addEventListener("click", onDocumentClick);
  return {
    close,
    destroy: () => {
      button.removeEventListener("click", onButtonClick);
      doc.removeEventListener("click", onDocumentClick);
    },
  };
}
