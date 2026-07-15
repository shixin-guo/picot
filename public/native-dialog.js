export function showNativeDialog(request, container = document.getElementById("dialog-container")) {
  return new Promise((resolve) => {
    const dialog = document.createElement("div");
    dialog.className = "dialog";
    const title = document.createElement("div");
    title.className = "dialog-title";
    title.textContent = request.title || defaultTitle(request.method);
    dialog.appendChild(title);
    const actions = document.createElement("div");
    actions.className = "dialog-actions";

    let input = null;
    if (request.method === "select") {
      const options = document.createElement("div");
      options.className = "dialog-options";
      for (const value of request.options ?? []) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "dialog-option";
        option.textContent = value;
        option.addEventListener("click", () => finish({ value }));
        options.appendChild(option);
      }
      dialog.appendChild(options);
    } else if (request.method === "confirm") {
      const message = document.createElement("div");
      message.className = "dialog-message";
      message.textContent = request.message || "";
      dialog.appendChild(message);
      addButton(actions, "No", () => finish({ confirmed: false }));
      addButton(actions, "Yes", () => finish({ confirmed: true }));
    } else {
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
    function finish(result) {
      if (timeout) clearTimeout(timeout);
      container.replaceChildren();
      container.classList.add("hidden");
      resolve(result);
    }
  });
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
