import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  activeSlashQuery,
  setupSkillSlashCommand,
  titleCaseSkillName,
} from "./skill-slash-command.js";

describe("skill slash command", () => {
  let dom;
  let input;
  let container;

  beforeEach(() => {
    dom = new JSDOM(`
      <textarea id="input"></textarea>
      <div id="skills" class="hidden"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.queueMicrotask = (callback) => callback();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    input = document.getElementById("input");
    container = document.getElementById("skills");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.queueMicrotask;
  });

  test("recognizes a slash query only at the start of the composer", () => {
    input.value = "/code";
    input.setSelectionRange(5, 5);
    expect(activeSlashQuery(input)).toEqual({ query: "code", end: 5 });

    input.value = "please /code";
    input.setSelectionRange(input.value.length, input.value.length);
    expect(activeSlashQuery(input)).toBeNull();
  });

  test("renders and filters skills by name or description", async () => {
    const picker = setupSkillSlashCommand({
      input,
      container,
      loadSkills: vi.fn(async () => [
        {
          command: "/skill:code-review",
          name: "code-review",
          description: "Review a diff",
          scope: "personal",
        },
        {
          command: "/skill:research",
          name: "research",
          description: "Investigate primary sources",
          scope: "project",
        },
      ]),
    });

    input.value = "/diff";
    input.setSelectionRange(5, 5);
    await picker.update();

    expect(container.classList.contains("hidden")).toBe(false);
    expect(container.querySelectorAll(".skill-slash-option")).toHaveLength(1);
    expect(container.textContent).toContain("Code Review");
    expect(container.textContent).toContain("Personal");
  });

  test("supports keyboard selection and inserts the native Pi command", async () => {
    const send = vi.fn();
    const picker = setupSkillSlashCommand({
      input,
      container,
      loadSkills: async () => [
        {
          command: "/skill:code-review",
          name: "code-review",
          description: "Review a diff",
          scope: "personal",
        },
        {
          command: "/skill:research",
          name: "research",
          description: "Investigate primary sources",
          scope: "project",
        },
      ],
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") send();
    });

    input.value = "/";
    input.setSelectionRange(1, 1);
    await picker.update();
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }),
    );
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
    );

    expect(input.value).toBe("/skill:research ");
    expect(container.classList.contains("hidden")).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  test("does not select a skill while IME composition is active", async () => {
    const picker = setupSkillSlashCommand({
      input,
      container,
      loadSkills: async () => [
        {
          command: "/skill:research",
          name: "research",
          description: "Investigate primary sources",
          scope: "project",
        },
      ],
    });

    input.value = "/";
    input.setSelectionRange(1, 1);
    await picker.update();
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
        isComposing: true,
      }),
    );

    expect(input.value).toBe("/");
    expect(container.classList.contains("hidden")).toBe(false);
  });

  test("retries loading skills after a transient failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempts = 0;
    const picker = setupSkillSlashCommand({
      input,
      container,
      loadSkills: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Pi is reloading");
        return [
          {
            command: "/skill:research",
            name: "research",
            description: "Investigate primary sources",
            scope: "project",
          },
        ];
      },
    });

    input.value = "/";
    input.setSelectionRange(1, 1);
    await picker.update();
    await picker.update();

    expect(attempts).toBe(2);
    expect(container.textContent).toContain("Research");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("does not reopen after blur while skills are loading", async () => {
    let resolveSkills;
    const picker = setupSkillSlashCommand({
      input,
      container,
      loadSkills: () =>
        new Promise((resolve) => {
          resolveSkills = resolve;
        }),
    });

    input.value = "/";
    input.setSelectionRange(1, 1);
    input.focus();
    const pendingUpdate = picker.update();
    await Promise.resolve();
    input.blur();
    resolveSkills([
      {
        command: "/skill:research",
        name: "research",
        description: "Investigate primary sources",
        scope: "project",
      },
    ]);
    await pendingUpdate;

    expect(container.classList.contains("hidden")).toBe(true);
  });

  test("filters when the user types the native skill prefix", async () => {
    const picker = setupSkillSlashCommand({
      input,
      container,
      loadSkills: async () => [
        {
          command: "/skill:research",
          name: "research",
          description: "Investigate primary sources",
          scope: "project",
        },
      ],
    });

    input.value = "/skill:res";
    input.setSelectionRange(input.value.length, input.value.length);
    await picker.update();

    expect(container.querySelectorAll(".skill-slash-option")).toHaveLength(1);
    expect(container.textContent).toContain("Research");
  });

  test("formats kebab-case names for display", () => {
    expect(titleCaseSkillName("agent-evaluation")).toBe("Agent Evaluation");
  });
});
