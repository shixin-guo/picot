import { parseDialogContent, parseOption } from "./dialog.js";

const MULTI_SELECT_HINT = "Enter the numbers of all that apply";
const CUSTOM_ANSWER_HINT = "Type your answer";
const pendingCustomAnswers = [];

export function showInlineExtensionPrompt(
  request,
  { container = document.getElementById("messages") } = {},
) {
  if (!container || !isInlineAskUserQuestionRequest(request)) return null;
  const content = parseDialogContent(request);
  if (
    request.method === "input" &&
    isCustomAnswerInput(content) &&
    pendingCustomAnswers.length > 0
  ) {
    return Promise.resolve({ value: pendingCustomAnswers.shift() });
  }
  removeWelcome(container);
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "inline-prompt-card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Extension question");

    const header = document.createElement("div");
    header.className = "inline-prompt-header";
    const eyebrow = document.createElement("span");
    eyebrow.className = "inline-prompt-eyebrow";
    eyebrow.textContent = content.header || "Question";
    const title = document.createElement("div");
    title.className = "inline-prompt-title";
    title.textContent = content.title || "Choose an option";
    header.append(eyebrow, title);
    card.appendChild(header);

    let finish;
    if (request.method === "select") {
      finish = renderSelectPrompt(card, request, content, resolve);
    } else {
      finish = renderInputPrompt(card, request, content, resolve);
    }

    container.appendChild(card);
    scrollTimeline(container);

    return finish;
  });
}

export function isInlineAskUserQuestionRequest(request) {
  if (request?.type !== "extension_ui_request") return false;
  if (request.method === "select") {
    const options = request.options ?? [];
    return options.length > 0 && options.every((option) => parseOption(option).number);
  }
  if (request.method !== "input") return false;
  const content = parseDialogContent(request);
  if (isCustomAnswerInput(content) && pendingCustomAnswers.length > 0) return true;
  return Boolean(
    content.header &&
      (content.body.includes(MULTI_SELECT_HINT) ||
        content.title.includes(CUSTOM_ANSWER_HINT) ||
        content.body.includes(CUSTOM_ANSWER_HINT)),
  );
}

function renderSelectPrompt(card, request, content, resolve) {
  const layout = document.createElement("div");
  layout.className =
    content.previews.length > 0
      ? "inline-prompt-layout inline-prompt-layout--with-preview"
      : "inline-prompt-layout";
  const options = document.createElement("div");
  options.className = "inline-prompt-options";

  const previewPanel = content.previews.length > 0 ? createPreviewPanel(content.previews) : null;
  const previewByNumber = new Map(content.previews.map((preview) => [preview.number, preview]));

  for (const value of request.options ?? []) {
    const option = parseOption(value);
    const button = createOptionButton(option);
    button.addEventListener("mouseenter", () => {
      if (previewPanel && option.number)
        setPreview(previewPanel, previewByNumber.get(option.number));
    });
    button.addEventListener("focus", () => {
      if (previewPanel && option.number)
        setPreview(previewPanel, previewByNumber.get(option.number));
    });
    button.addEventListener("click", () => {
      if (isTypeSomethingOption(option)) {
        renderCustomAnswerInSelect(card, layout, actions, value, finish);
        return;
      }
      finish({ value });
    });
    options.appendChild(button);
  }
  layout.appendChild(options);
  if (previewPanel) layout.appendChild(previewPanel);
  card.appendChild(layout);

  const actions = createActions(() => finish({ cancelled: true }));
  card.appendChild(actions);

  function finish(result) {
    markAnswered(card, result);
    resolve(result);
  }
}

function renderInputPrompt(card, request, content, resolve) {
  const multiOptions = parseOptionsFromBody(content.body);
  if (multiOptions.length > 0) {
    renderMultiSelectInput(card, multiOptions, resolve);
    return;
  }

  const input = document.createElement("input");
  input.className = "inline-prompt-input";
  input.type = "text";
  input.placeholder = request.placeholder || "";
  card.appendChild(input);
  const actions = createActions(
    () => finish({ cancelled: true }),
    () => finish({ value: input.value }),
  );
  card.appendChild(actions);
  input.focus();

  function finish(result) {
    markAnswered(card, result);
    resolve(result);
  }
}

function renderCustomAnswerInSelect(card, layout, actions, sentinelValue, finish) {
  layout.hidden = true;
  actions.hidden = true;

  const customPanel = document.createElement("div");
  customPanel.className = "inline-prompt-custom";
  const input = document.createElement("input");
  input.className = "inline-prompt-input";
  input.type = "text";
  input.placeholder = "Type a custom answer";
  const customActions = document.createElement("div");
  customActions.className = "inline-prompt-actions";

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "inline-prompt-submit";
  submit.textContent = "Submit";
  submit.addEventListener("click", () => {
    pendingCustomAnswers.push(input.value);
    finish({ value: sentinelValue });
  });

  const back = document.createElement("button");
  back.type = "button";
  back.className = "inline-prompt-cancel";
  back.textContent = "Back";
  back.addEventListener("click", () => {
    customPanel.remove();
    layout.hidden = false;
    actions.hidden = false;
  });

  customActions.append(submit, back);
  customPanel.append(input, customActions);
  card.appendChild(customPanel);
  input.focus();
}

function renderMultiSelectInput(card, options, resolve) {
  const list = document.createElement("div");
  list.className = "inline-prompt-options";
  const selected = new Set();
  for (const option of options) {
    const label = document.createElement("label");
    label.className = "inline-prompt-option inline-prompt-option--checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = option.number;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(option.number);
      else selected.delete(option.number);
    });
    const body = createOptionBody(option);
    label.append(checkbox, body);
    list.appendChild(label);
  }
  card.appendChild(list);

  const custom = document.createElement("input");
  custom.className = "inline-prompt-input";
  custom.type = "text";
  custom.placeholder = "Type a custom answer";
  custom.addEventListener("input", () => {
    for (const checkbox of list.querySelectorAll("input[type='checkbox']")) {
      checkbox.disabled = custom.value.trim().length > 0;
    }
  });
  card.appendChild(custom);

  const actions = createActions(
    () => finish({ cancelled: true }),
    () => {
      const customValue = custom.value.trim();
      finish({
        value: customValue || [...selected].sort((a, b) => Number(a) - Number(b)).join(","),
      });
    },
  );
  card.appendChild(actions);

  function finish(result) {
    markAnswered(card, result);
    resolve(result);
  }
}

function createOptionButton(option) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "inline-prompt-option";
  button.appendChild(createOptionBody(option));
  return button;
}

function createOptionBody(option) {
  const body = document.createElement("span");
  body.className = "inline-prompt-option-body";
  if (option.number) {
    const index = document.createElement("span");
    index.className = "inline-prompt-option-index";
    index.textContent = option.number;
    body.appendChild(index);
  }
  const text = document.createElement("span");
  text.className = "inline-prompt-option-text";
  const label = document.createElement("span");
  label.className = "inline-prompt-option-label";
  label.textContent = option.label;
  text.appendChild(label);
  if (option.description) {
    const description = document.createElement("span");
    description.className = "inline-prompt-option-description";
    description.textContent = option.description;
    text.appendChild(description);
  }
  body.appendChild(text);
  return body;
}

function createPreviewPanel(previews) {
  const panel = document.createElement("div");
  panel.className = "inline-prompt-preview";
  setPreview(panel, previews[0]);
  return panel;
}

function setPreview(panel, preview) {
  panel.replaceChildren();
  if (!preview) {
    const empty = document.createElement("div");
    empty.className = "inline-prompt-preview-empty";
    empty.textContent = "No preview";
    panel.appendChild(empty);
    return;
  }
  const title = document.createElement("div");
  title.className = "inline-prompt-preview-title";
  title.textContent = `${preview.number}. ${preview.label}`;
  const body = document.createElement("pre");
  body.className = "inline-prompt-preview-body";
  body.textContent = preview.content;
  panel.append(title, body);
}

function createActions(onCancel, onSubmit) {
  const actions = document.createElement("div");
  actions.className = "inline-prompt-actions";
  if (onSubmit) {
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "inline-prompt-submit";
    submit.textContent = "Submit";
    submit.addEventListener("click", onSubmit);
    actions.appendChild(submit);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "inline-prompt-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", onCancel);
  actions.appendChild(cancel);
  return actions;
}

function parseOptionsFromBody(body) {
  return String(body)
    .split("\n")
    .map((line) => parseOption(line.trim()))
    .filter((option) => option.number);
}

function isTypeSomethingOption(option) {
  return option.label.replace(/\.$/, "").toLowerCase() === "type something";
}

function isCustomAnswerInput(content) {
  return content.title.includes(CUSTOM_ANSWER_HINT) || content.body.includes(CUSTOM_ANSWER_HINT);
}

function markAnswered(card, result) {
  card.classList.add("answered");
  card.querySelectorAll("button, input").forEach((control) => {
    control.disabled = true;
  });
  card.querySelectorAll(".inline-prompt-actions").forEach((actions) => {
    actions.remove();
  });
  const status = document.createElement("div");
  status.className = "inline-prompt-status";
  status.textContent = result.cancelled ? "Cancelled" : "Answered";
  card.appendChild(status);
}

function removeWelcome(container) {
  container.querySelector(".welcome")?.remove();
}

function scrollTimeline(container) {
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}
