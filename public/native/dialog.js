export function showNativeDialog(request, container = document.getElementById("dialog-container")) {
  return new Promise((resolve) => {
    const content = parseDialogContent(request);
    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("div");
    title.className = "dialog-title";
    if (content.header) {
      const badge = document.createElement("span");
      badge.className = "dialog-header-badge";
      badge.textContent = content.header;
      title.appendChild(badge);
    }
    const titleText = document.createElement("span");
    titleText.textContent = content.title || defaultTitle(request.method);
    title.appendChild(titleText);
    dialog.appendChild(title);
    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    let input = null;
    if (request.method === "select") {
      if (content.body) dialog.appendChild(createMessage(content.body));
      const body = document.createElement("div");
      body.className =
        content.previews.length > 0 ? "dialog-body dialog-body--with-preview" : "dialog-body";
      const options = document.createElement("div");
      options.className = "dialog-options";
      for (const value of request.options ?? []) {
        const optionContent = parseOption(value);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "dialog-option";
        if (optionContent.number) {
          const index = document.createElement("span");
          index.className = "dialog-option-index";
          index.textContent = optionContent.number;
          option.appendChild(index);
        }
        const label = document.createElement("span");
        label.className = "dialog-option-label";
        label.textContent = optionContent.label;
        option.appendChild(label);
        if (optionContent.description) {
          const description = document.createElement("span");
          description.className = "dialog-option-description";
          description.textContent = optionContent.description;
          option.appendChild(description);
        }
        option.addEventListener("click", () => finish({ value }));
        options.appendChild(option);
      }
      body.appendChild(options);
      if (content.previews.length > 0) body.appendChild(createPreviews(content.previews));
      dialog.appendChild(body);
    } else if (request.method === "confirm") {
      dialog.appendChild(createMessage(request.message || ""));
      addButton(actions, "No", () => finish({ confirmed: false }));
      addButton(actions, "Yes", () => finish({ confirmed: true }));
    } else {
      if (content.body) dialog.appendChild(createMessage(content.body));
      input = document.createElement(request.method === "editor" ? "textarea" : "input");
      input.className = request.method === "editor" ? "dialog-textarea" : "dialog-input";
      input.value = request.prefill || "";
      if (request.placeholder) input.placeholder = request.placeholder;
      dialog.appendChild(input);
      addButton(actions, request.method === "editor" ? "Save" : "Submit", () =>
        finish({ value: input.value }),
      );
    }
    addButton(actions, "Cancel", () => finish({ cancelled: true }));
    dialog.appendChild(actions);
    container.replaceChildren(dialog);
    container.classList.remove("hidden");
    input?.focus();

    let timeout = null;
    if (request.timeout) timeout = setTimeout(() => finish({ cancelled: true }), request.timeout);
    const keyHandler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish({ cancelled: true });
      }
      if (input && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        finish({ value: input.value });
      }
    };
    document.addEventListener("keydown", keyHandler);
    function finish(result) {
      if (timeout) clearTimeout(timeout);
      document.removeEventListener("keydown", keyHandler);
      container.replaceChildren();
      container.classList.add("hidden");
      resolve(result);
    }
  });
}

export function parseDialogContent(request) {
  const rawTitle = String(request.title || "");
  const previewStart = rawTitle.search(/\n\n--- \d+\. .+? preview ---\n/);
  const visibleTitle = previewStart >= 0 ? rawTitle.slice(0, previewStart) : rawTitle;
  const previews = previewStart >= 0 ? parsePreviewBlocks(rawTitle.slice(previewStart)) : [];
  const lines = visibleTitle.split(/\n+/).map((line) => line.trim());
  const titleLine = lines.shift() || "";
  const headerMatch = titleLine.match(/^\[([^\]]+)]\s*(.*)$/);
  return {
    header: headerMatch?.[1] ?? "",
    title: headerMatch?.[2] ?? titleLine,
    body: lines.filter(Boolean).join("\n\n"),
    previews,
  };
}

export function parseOption(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d+)\.\s+(.+?)(?:\s+[—-]\s+(.+))?$/);
  if (!match) return { number: "", label: text, description: "" };
  return {
    number: match[1],
    label: match[2],
    description: match[3] ?? "",
  };
}

function parsePreviewBlocks(text) {
  return [
    ...text.matchAll(
      /\n\n--- (\d+)\. (.+?) preview ---\n([\s\S]*?)(?=\n\n--- \d+\. .+? preview ---\n|$)/g,
    ),
  ].map((match) => ({
    number: match[1],
    label: match[2],
    content: match[3].trim(),
  }));
}

function createMessage(value) {
  const message = document.createElement("div");
  message.className = "dialog-message";
  message.textContent = value;
  return message;
}

function createPreviews(previews) {
  const panel = document.createElement("div");
  panel.className = "dialog-preview-panel";
  for (const preview of previews) {
    const section = document.createElement("section");
    section.className = "dialog-preview";
    const title = document.createElement("div");
    title.className = "dialog-preview-title";
    title.textContent = `${preview.number}. ${preview.label}`;
    const body = document.createElement("pre");
    body.className = "dialog-preview-body";
    body.textContent = preview.content;
    section.append(title, body);
    panel.appendChild(section);
  }
  return panel;
}

function addButton(container, label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  container.appendChild(button);
}

function defaultTitle(method) {
  return method === "confirm" ? "Confirm" : method === "editor" ? "Editor" : "Input";
}
