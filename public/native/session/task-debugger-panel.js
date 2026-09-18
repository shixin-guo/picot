// ABOUTME: Task debugger dialog - one click after a task ends explains where the
// ABOUTME: time went, what failed, what got stuck, and which steps were redundant.

import { t as translate } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import { analyzeTurns, formatMs, formatShare } from "./turn-analysis.js";

const PHASE_ORDER = ["model", "tool", "compaction", "idle"];
const MAX_TIMELINE_STEPS = 60;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Turn a report into a paste-ready Markdown summary (bug reports, issues). */
export function buildMarkdownReport(report, t = translate) {
  const lines = [];
  lines.push(`# ${t("taskDebugger.title")}`);
  lines.push("");
  lines.push(
    `- ${t("taskDebugger.statusLabel")}: ${t(`taskDebugger.status.${report.status}`)}`,
    `- ${t("taskDebugger.totalTime")}: ${formatMs(report.totals.wallMs)}`,
    `- ${t("taskDebugger.phase.model")}: ${formatMs(report.totals.modelMs)}`,
    `- ${t("taskDebugger.phase.tool")}: ${formatMs(report.totals.toolMs)} (${report.totals.toolCalls})`,
    `- ${t("taskDebugger.phase.idle")}: ${formatMs(report.totals.idleMs)}`,
  );
  if (report.totals.wastedMs > 0) {
    lines.push(`- ${t("taskDebugger.wasted")}: ${formatMs(report.totals.wastedMs)}`);
  }
  lines.push("", `## ${t("taskDebugger.findings")}`);
  for (const finding of report.findings) {
    lines.push(
      `- **${t(`taskDebugger.severity.${finding.severity}`)}** ${findingText(finding, t)}`,
    );
  }
  if (report.slowest.length) {
    lines.push("", `## ${t("taskDebugger.slowest")}`);
    for (const step of report.slowest) {
      lines.push(
        `- ${step.label}${step.detail ? ` (${step.detail})` : ""} - ${formatMs(step.durationMs)} (${formatShare(step.share)})`,
      );
    }
  }
  if (report.failures.length) {
    lines.push("", `## ${t("taskDebugger.failures")}`);
    for (const failure of report.failures) {
      lines.push(`- ${failure.label}: ${failure.error || t("taskDebugger.unknownError")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function findingText(finding, t) {
  return t(`taskDebugger.finding.${finding.code}`, finding.params || {});
}

function renderSummary(report, t) {
  const section = element("section", "task-debugger-summary");
  const status = element("span", `task-debugger-status task-debugger-status--${report.status}`);
  status.textContent = t(`taskDebugger.status.${report.status}`);
  const headline = element("div", "task-debugger-headline");
  headline.append(status, element("strong", "", formatMs(report.totals.wallMs)));
  section.appendChild(headline);

  const stats = element("dl", "task-debugger-stats");
  const rows = [
    [t("taskDebugger.turns"), String(report.totals.turns)],
    [t("taskDebugger.toolCalls"), String(report.totals.toolCalls)],
    [t("taskDebugger.failures"), String(report.totals.failureCount)],
    [t("taskDebugger.wasted"), formatMs(report.totals.wastedMs)],
  ];
  if (report.totals.usage.cost > 0) {
    rows.push([t("taskDebugger.cost"), `$${report.totals.usage.cost.toFixed(4)}`]);
  }
  for (const [label, value] of rows) {
    stats.append(element("dt", "", label), element("dd", "", value));
  }
  section.appendChild(stats);
  return section;
}

function renderPhases(report, t) {
  const section = element("section", "task-debugger-section");
  section.appendChild(element("h3", "task-debugger-heading", t("taskDebugger.timeSplit")));

  const bar = element("div", "task-debugger-bar");
  for (const kind of PHASE_ORDER) {
    const phase = report.phases.find((entry) => entry.kind === kind);
    if (!phase || phase.ms <= 0) continue;
    const segment = element("span", `task-debugger-bar-segment task-debugger-bar-segment--${kind}`);
    segment.style.flexGrow = String(phase.ms);
    segment.title = `${t(`taskDebugger.phase.${kind}`)} ${formatMs(phase.ms)}`;
    bar.appendChild(segment);
  }
  if (!bar.childElementCount) bar.appendChild(element("span", "task-debugger-bar-empty"));
  section.appendChild(bar);

  const legend = element("ul", "task-debugger-legend");
  for (const kind of PHASE_ORDER) {
    const phase = report.phases.find((entry) => entry.kind === kind);
    if (!phase) continue;
    const item = element("li", `task-debugger-legend-item task-debugger-legend-item--${kind}`);
    item.append(
      element("span", "task-debugger-legend-label", t(`taskDebugger.phase.${kind}`)),
      element(
        "span",
        "task-debugger-legend-value",
        `${formatMs(phase.ms)} · ${formatShare(phase.share)}`,
      ),
    );
    legend.appendChild(item);
  }
  section.appendChild(legend);
  return section;
}

function renderFindings(report, t) {
  const section = element("section", "task-debugger-section");
  section.appendChild(element("h3", "task-debugger-heading", t("taskDebugger.findings")));
  const list = element("ul", "task-debugger-findings");
  for (const finding of report.findings) {
    const item = element("li", `task-debugger-finding task-debugger-finding--${finding.severity}`);
    item.append(
      element(
        "span",
        "task-debugger-finding-severity",
        t(`taskDebugger.severity.${finding.severity}`),
      ),
      element("span", "task-debugger-finding-text", findingText(finding, t)),
    );
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

function renderSteps(report, t) {
  const section = element("section", "task-debugger-section");
  section.appendChild(element("h3", "task-debugger-heading", t("taskDebugger.slowest")));
  if (!report.slowest.length) {
    section.appendChild(element("p", "task-debugger-empty", t("taskDebugger.noSteps")));
    return section;
  }
  const list = element("ol", "task-debugger-steps");
  for (const step of report.slowest) {
    list.appendChild(stepRow(step, t));
  }
  section.appendChild(list);
  return section;
}

function stepRow(step, t) {
  const item = element("li", `task-debugger-step task-debugger-step--${step.status}`);
  const head = element("div", "task-debugger-step-head");
  head.append(
    element("span", "task-debugger-step-label", step.label),
    element("span", "task-debugger-step-duration", formatMs(step.durationMs)),
  );
  item.appendChild(head);
  if (step.detail) item.appendChild(element("div", "task-debugger-step-detail", step.detail));
  if (step.error) item.appendChild(element("div", "task-debugger-step-error", step.error));
  if (step.status === "unfinished") {
    item.appendChild(element("div", "task-debugger-step-error", t("taskDebugger.neverFinished")));
  }
  return item;
}

function renderTimeline(turns, t) {
  const section = element("section", "task-debugger-section");
  section.appendChild(element("h3", "task-debugger-heading", t("taskDebugger.timeline")));
  const list = element("ol", "task-debugger-timeline");
  let rendered = 0;
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (rendered >= MAX_TIMELINE_STEPS) break;
      rendered += 1;
      list.appendChild(stepRow({ ...step, durationMs: step.durationMs ?? 0 }, t));
    }
  }
  if (!rendered) {
    section.appendChild(element("p", "task-debugger-empty", t("taskDebugger.noSteps")));
    return section;
  }
  section.appendChild(list);
  return section;
}

/**
 * Wire the task debugger button + dialog.
 *
 * The button is always visible, and disabled only while a turn streams:
 * analysing one in flight would report its own open spans as "stuck". With
 * nothing recorded yet the dialog opens on an explanation instead, since only
 * turns this app instance actually watched are traced -- history loaded from
 * disk carries no timings.
 *
 * @param {{
 *   button: HTMLElement,
 *   overlay: HTMLElement,
 *   dialog: HTMLElement,
 *   body: HTMLElement,
 *   closeButton?: HTMLElement,
 *   copyButton?: HTMLElement,
 *   scopeInputs?: Iterable<HTMLInputElement>,
 *   getTurns: () => Array<object>,
 *   analyze?: (turns: Array<object>, options?: object) => object,
 *   t?: (key: string, params?: object) => string,
 *   writeText?: (text: string) => Promise<void> | void,
 * }} options
 */
export function setupTaskDebuggerPanel({
  button,
  overlay,
  dialog,
  body,
  closeButton,
  copyButton,
  scopeInputs = [],
  getTurns,
  analyze = analyzeTurns,
  t = translate,
  writeText = (text) => navigator.clipboard?.writeText(text),
} = {}) {
  if (!button || !overlay || !dialog || !body || typeof getTurns !== "function") {
    return { open() {}, close() {}, setStreaming() {}, refreshAvailability() {} };
  }

  let unbindEscape = null;
  let streaming = false;
  let scope = "last";
  let lastReport = null;

  const scopeList = [...scopeInputs];
  for (const input of scopeList) {
    if (input.checked) scope = input.value;
  }

  function selectedTurns() {
    const turns = getTurns() ?? [];
    if (scope === "session") return turns;
    const finished = turns.filter((turn) => turn.status !== "running");
    const last = finished.length ? finished[finished.length - 1] : turns[turns.length - 1];
    return last ? [last] : [];
  }

  function refreshAvailability() {
    // The button stays visible even with nothing recorded yet: a control that
    // only appears once its precondition holds is a control nobody discovers.
    // Opening it then explains why there is nothing to show. Only a streaming
    // turn disables it, because analysing one reports its own open spans as
    // stuck.
    button.classList.remove("hidden");
    button.disabled = streaming;
    button.title = streaming ? t("taskDebugger.buttonBusy") : t("taskDebugger.buttonTitle");
    button.setAttribute("aria-label", button.title);
  }

  function render() {
    const turns = selectedTurns();
    body.replaceChildren();
    if (!turns.length) {
      body.appendChild(element("p", "task-debugger-empty", t("taskDebugger.noTurns")));
      lastReport = null;
      if (copyButton) copyButton.disabled = true;
      return;
    }
    const report = analyze(turns);
    lastReport = report;
    if (copyButton) copyButton.disabled = false;
    body.append(
      renderSummary(report, t),
      renderFindings(report, t),
      renderPhases(report, t),
      renderSteps(report, t),
      renderTimeline(turns, t),
    );
  }

  function open() {
    if (button.disabled) return;
    render();
    overlay.classList.remove("hidden");
    dialog.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    unbindEscape = bindDialogEscape(close, {
      isActive: () => !dialog.classList.contains("hidden"),
    });
    (closeButton ?? dialog).focus?.();
  }

  function close() {
    overlay.classList.add("hidden");
    dialog.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
    unbindEscape?.();
    unbindEscape = null;
  }

  button.addEventListener("click", () => {
    if (dialog.classList.contains("hidden")) open();
    else close();
  });
  overlay.addEventListener("click", close);
  closeButton?.addEventListener("click", close);
  for (const input of scopeList) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      scope = input.value;
      render();
    });
  }
  copyButton?.addEventListener("click", async () => {
    if (!lastReport) return;
    const label = copyButton.textContent;
    try {
      const result = writeText?.(buildMarkdownReport(lastReport, t));
      if (!result) throw new Error("Clipboard unavailable");
      await result;
      copyButton.textContent = t("taskDebugger.copied");
    } catch {
      copyButton.textContent = t("taskDebugger.copyFailed");
    }
    setTimeout(() => {
      copyButton.textContent = label;
    }, 1500);
  });

  refreshAvailability();

  return {
    open,
    close,
    /** Streaming turns are excluded: their open spans are not "stuck" yet. */
    setStreaming(value) {
      streaming = Boolean(value);
      refreshAvailability();
      if (streaming) close();
    },
    refreshAvailability,
    getReport: () => lastReport,
  };
}
