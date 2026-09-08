// Inline card for one Claude Code (ACP) subagent run, rendered inside the Pi
// message list (#messages). The card owns no state — callers pass a `run`
// snapshot ({ id, taskText, status, startedAt, finishedAt, resultText, expanded,
// state }) and call `update(run)` as `acp_session_update` events fold into
// `run.state` (see acp-store.js).
//
// Reuses Picot's own presentation: agent replies render through the shared
// Markdown renderer, tool calls through ToolCardRenderer — so a subagent turn
// reads like a normal Pi turn. A fullscreen overlay gives the run's result and
// transcript room to breathe. Permission prompts reuse the shared native
// dialog.

import { createIcon } from "../../icons.js";
import { initCodeCopyDelegation, renderMarkdown } from "../../ui/markdown.js";
import { parseSanitizedMarkup } from "../../ui/sanitize-markup.js";
import { ToolCardRenderer } from "../../ui/tool-card.js";
import { showNativeDialog } from "../extensions/dialog.js";
import { finalAgentText } from "./acp-store.js";

const CHEVRON =
  '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M2 1l4 3-4 3z"/></svg>';

const STATUS_LABEL = { running: "Working…", done: "Done", error: "Failed" };

// ACP ToolCallStatus -> ToolCardRenderer status (drives the `tools.*` label).
const TOOL_STATUS = {
  pending: "pending",
  in_progress: "streaming",
  completed: "complete",
  failed: "error",
};

function elapsedText(run) {
  const start = Date.parse(run.startedAt || "");
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  if (Number.isNaN(start)) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function truncate(text, max = 120) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// Flatten an ACP tool-call `content` (array of ToolCallContent, or a string)
// into plain text for the tool card's output area.
function toolOutputText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((part) => {
      if (part?.type === "content") {
        const inner = part.content;
        if (inner?.type === "text") return inner.text ?? "";
        return typeof inner === "string" ? inner : JSON.stringify(inner);
      }
      if (part?.type === "text") return part.text ?? "";
      if (part?.type === "diff") {
        return `${part.path ?? ""}\n${part.oldText ?? ""}\n---\n${part.newText ?? ""}`.trim();
      }
      return typeof part === "string" ? part : JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function toolExecutionFrom(block) {
  const args = block.rawInput && typeof block.rawInput === "object" ? block.rawInput : {};
  return {
    toolCallId: block.toolCallId,
    toolName: block.title || block.toolKind || "tool",
    args,
    status: TOOL_STATUS[block.status] ?? "pending",
    output: toolOutputText(block.content),
  };
}

function markdownContent(text) {
  const el = document.createElement("div");
  el.className = "message-content";
  el.appendChild(parseSanitizedMarkup(renderMarkdown(text || "")));
  return el;
}

// Render `blocks` into `container` in order: tool calls via `toolRenderer`
// (whose own container must be `container`), everything else via renderBlock.
function renderBlocksInto(container, blocks, toolRenderer) {
  for (const block of blocks) {
    if (block.kind === "tool_call" && block.toolCallId) {
      const execution = toolExecutionFrom(block);
      toolRenderer.updateToolCard(execution);
      if (execution.status === "complete" || execution.status === "error") {
        toolRenderer.finalizeToolCard(
          execution.toolCallId,
          { content: [{ type: "text", text: execution.output }] },
          execution.status === "error",
        );
      }
      continue;
    }
    const el = renderBlock(block);
    if (el) container.appendChild(el);
  }
}

/**
 * @param {object} opts
 * @param {object} opts.run
 * @param {(run: object) => void} [opts.onSendResult]
 * @param {(requestId: string, optionId: string|undefined) => void} [opts.onRespondPermission]
 */
export function createSubagentCard({ run, onSendResult, onRespondPermission }) {
  const wrapper = document.createElement("div");
  wrapper.className = "subagent-card";
  wrapper.dataset.runId = run.id;

  const head = document.createElement("div");
  head.className = "subagent-card-head";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "subagent-card-toggle";

  const chevron = document.createElement("span");
  chevron.className = "subagent-card-chevron";
  chevron.innerHTML = CHEVRON;

  const title = document.createElement("span");
  title.className = "subagent-card-title";

  const status = document.createElement("span");
  status.className = "subagent-card-status";

  const elapsed = document.createElement("span");
  elapsed.className = "subagent-card-elapsed";

  toggle.append(chevron, title, status, elapsed);

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "subagent-card-expand";
  expandBtn.title = "View fullscreen";
  expandBtn.setAttribute("aria-label", "View fullscreen");
  expandBtn.appendChild(createIcon("maximize", { size: 13 }) ?? document.createTextNode("⤢"));
  expandBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openFullscreen();
  });

  head.append(toggle, expandBtn);

  const body = document.createElement("div");
  body.className = "subagent-card-body";
  initCodeCopyDelegation(body);

  const footer = document.createElement("div");
  footer.className = "subagent-card-footer";
  footer.hidden = true;

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "subagent-card-send";
  sendBtn.textContent = "Send result to Pi";
  sendBtn.addEventListener("click", () => {
    sendBtn.disabled = true;
    sendBtn.textContent = "Sent to Pi";
    onSendResult?.(current);
  });
  footer.append(sendBtn);

  wrapper.append(head, body, footer);

  let current = run;
  const agentName = () => current.agentLabel || "Claude Code";
  // Lazily created — a run with no tool calls never pays for the renderer (and
  // its locale subscription).
  let toolRenderer = null;
  function getToolRenderer() {
    if (!toolRenderer) toolRenderer = new ToolCardRenderer(body);
    return toolRenderer;
  }

  toggle.addEventListener("click", () => {
    current.expanded = !current.expanded;
    applyExpanded();
  });

  function applyExpanded() {
    wrapper.classList.toggle("expanded", Boolean(current.expanded));
    toggle.setAttribute("aria-expanded", String(Boolean(current.expanded)));
  }

  function renderBody() {
    // Full rebuild each update: the reduced blocks already carry each tool
    // call's merged state, so re-emitting the cards keeps them correct and in
    // order relative to the message blocks.
    toolRenderer?.clear();
    body.replaceChildren();

    const blocks = current.state?.blocks ?? [];
    if (blocks.length > 0) renderBlocksInto(body, blocks, getToolRenderer());

    if (current.state?.error) {
      const err = document.createElement("div");
      err.className = "subagent-block subagent-error";
      err.textContent = current.state.error;
      body.appendChild(err);
    }
    if (blocks.length === 0 && !current.state?.error) {
      const hint = document.createElement("div");
      hint.className = "subagent-block subagent-empty";
      hint.textContent = current.status === "running" ? `Starting ${agentName()}…` : "No output.";
      body.appendChild(hint);
    }
  }

  function update(next) {
    current = next;
    title.textContent = `${agentName()} · ${truncate(current.taskText)}`;
    title.title = current.taskText;
    status.textContent = STATUS_LABEL[current.status] ?? current.status;
    wrapper.dataset.status = current.status;
    elapsed.textContent = elapsedText(current);
    applyExpanded();
    renderBody();
    const settled = current.status === "done" || current.status === "error";
    footer.hidden = !(settled && Boolean((current.resultText ?? "").trim()));
    presentPendingPermissions();
    if (fullscreen) renderFullscreen();
  }

  // ── Fullscreen overlay ────────────────────────────────────────────────
  let fullscreen = null;

  function openFullscreen() {
    if (fullscreen) return;
    const overlay = document.createElement("div");
    overlay.className = "subagent-fullscreen";

    const panel = document.createElement("div");
    panel.className = "subagent-fullscreen-panel";

    const fsHead = document.createElement("div");
    fsHead.className = "subagent-fullscreen-head";
    const fsTitle = document.createElement("span");
    fsTitle.className = "subagent-fullscreen-title";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "subagent-fullscreen-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.appendChild(createIcon("x", { size: 18 }) ?? document.createTextNode("✕"));
    closeBtn.addEventListener("click", closeFullscreen);
    fsHead.append(fsTitle, closeBtn);

    const fsBody = document.createElement("div");
    fsBody.className = "subagent-fullscreen-body";
    initCodeCopyDelegation(fsBody);

    panel.append(fsHead, fsBody);
    overlay.appendChild(panel);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) closeFullscreen();
    });
    document.addEventListener("keydown", onFullscreenKey);
    document.body.appendChild(overlay);

    fullscreen = { overlay, fsTitle, fsBody, toolRenderer: null };
    requestAnimationFrame(() => overlay.classList.add("open"));
    renderFullscreen();
  }

  function onFullscreenKey(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeFullscreen();
    }
  }

  function closeFullscreen() {
    if (!fullscreen) return;
    document.removeEventListener("keydown", onFullscreenKey);
    fullscreen.toolRenderer?.destroy();
    fullscreen.overlay.remove();
    fullscreen = null;
  }

  function renderFullscreen() {
    if (!fullscreen) return;
    const { fsTitle, fsBody } = fullscreen;
    fsTitle.textContent = `${agentName()} · ${truncate(current.taskText, 200)}`;

    fullscreen.toolRenderer?.clear();
    fsBody.replaceChildren();

    const resultText = (current.resultText || finalAgentText(current.state) || "").trim();
    if (resultText) {
      const result = document.createElement("div");
      result.className = "subagent-fullscreen-result message assistant";
      result.appendChild(markdownContent(resultText));
      fsBody.appendChild(result);
    }

    const blocks = current.state?.blocks ?? [];
    if (blocks.length > 0) {
      const details = document.createElement("details");
      details.className = "subagent-fullscreen-transcript";
      if (!resultText) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = resultText ? "Full transcript" : "Transcript";
      details.appendChild(summary);
      const transcript = document.createElement("div");
      transcript.className = "subagent-fullscreen-transcript-body";
      details.appendChild(transcript);
      fsBody.appendChild(details);
      if (!fullscreen.toolRenderer) fullscreen.toolRenderer = new ToolCardRenderer(transcript);
      renderBlocksInto(transcript, blocks, fullscreen.toolRenderer);
    }

    if (current.state?.error) {
      const err = document.createElement("div");
      err.className = "subagent-block subagent-error";
      err.textContent = current.state.error;
      fsBody.appendChild(err);
    }
    if (!resultText && blocks.length === 0 && !current.state?.error) {
      const hint = document.createElement("div");
      hint.className = "subagent-block subagent-empty";
      hint.textContent = current.status === "running" ? "Waiting for output…" : "No output.";
      fsBody.appendChild(hint);
    }
  }

  const dialogsInFlight = new Set();
  function presentPendingPermissions() {
    for (const request of current.state?.permissionRequests ?? []) {
      if (dialogsInFlight.has(request.requestId)) continue;
      dialogsInFlight.add(request.requestId);
      presentPermission(request, onRespondPermission, agentName()).finally(() => {
        dialogsInFlight.delete(request.requestId);
      });
    }
  }

  function destroy() {
    closeFullscreen();
    toolRenderer?.destroy();
    toolRenderer = null;
  }

  update(run);
  return { element: wrapper, update, destroy };
}

/**
 * Renders one non-tool reduced ACP block (see acp-store.js). Tool calls are
 * handled by ToolCardRenderer, not here.
 */
export function renderBlock(block) {
  if (block.kind === "user") {
    return textBlock("subagent-user", block.text);
  }
  if (block.kind === "message") {
    // Agent reply — same Markdown pipeline and classes as a Pi assistant turn.
    const el = document.createElement("div");
    el.className = "subagent-block message assistant";
    el.appendChild(markdownContent(block.text));
    return el;
  }
  if (block.kind === "thought") {
    return textBlock("subagent-thought", block.text);
  }
  if (block.kind === "plan") {
    const el = document.createElement("div");
    el.className = "subagent-block subagent-plan";
    const list = document.createElement("ul");
    for (const entry of block.entries ?? []) {
      const item = document.createElement("li");
      item.textContent = entry.content ?? entry.title ?? JSON.stringify(entry);
      list.appendChild(item);
    }
    el.appendChild(list);
    return el;
  }
  return null;
}

function textBlock(className, text) {
  const el = document.createElement("div");
  el.className = `subagent-block ${className}`;
  el.textContent = text;
  return el;
}

/**
 * Surfaces an ACP `session/request_permission` through the shared native dialog
 * and calls `respond(requestId, optionId)` with the chosen option (or undefined
 * when dismissed).
 */
export async function presentPermission(request, respond, agentLabel = "Claude Code") {
  const options = request.params?.options ?? [];
  const toolCall = request.params?.toolCall ?? {};
  const labels = options.map(
    (option, index) => `${index + 1}. ${option.name ?? option.optionId ?? "Option"}`,
  );
  const result = await showNativeDialog({
    method: "select",
    title: toolCall.title || `${agentLabel} — permission requested`,
    options: labels,
  });
  let optionId;
  if (result?.value) {
    const index = labels.indexOf(result.value);
    optionId = index >= 0 ? options[index]?.optionId : undefined;
  }
  respond?.(request.requestId, optionId);
}
