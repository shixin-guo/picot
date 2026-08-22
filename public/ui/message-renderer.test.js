import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "../i18n.js";
import { MessageRenderer } from "./message-renderer.js";

const enMessages = {
  messages: {
    copyMessage: "Copy message",
    thinking: "Thinking",
    attachedImage: "Attached image",
    copy: "Copy",
    copied: "Copied!",
  },
  app: {
    welcome: "Welcome to Picot",
    welcomeHint: "Type a message...",
    currentWorkspace: "Current workspace:",
  },
  shortcuts: { focusInput: "Focus input", abort: "Abort" },
};
const zhMessages = {
  messages: {
    copyMessage: "复制消息",
    thinking: "思考中",
    attachedImage: "附件图片",
    copy: "复制",
    copied: "已复制！",
  },
  app: {
    welcome: "欢迎使用 Picot",
    welcomeHint: "输入消息...",
    currentWorkspace: "当前工作区：",
  },
  shortcuts: { focusInput: "聚焦输入", abort: "中止" },
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      if (u.includes("/locales/zh.json")) {
        return { ok: true, status: 200, json: async () => zhMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

describe("MessageRenderer streaming markdown preview", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders markdown live during streaming updates", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "hello **bold te");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold te</strong>");
  });

  it("finalizes from the raw text, not the rendered DOM", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** word and `code`");
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.innerHTML).toContain("<code>code</code>");
  });

  it("preserves streamed text when message_end carries only tool_use blocks", () => {
    // Regression: task ends with content=[{type:"tool_use"}], which yields
    // text="" from splitStreamingContent. Previously this overwrote
    // _streamingRawText with "" and cleared the contentDiv.
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "I will call a tool now.");
    // Simulate message_end passing full content that has no text blocks
    renderer.updateStreamingMessage(el, [{ type: "tool_use", id: "x", name: "bash", input: {} }]);
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.textContent.trim()).toBe("I will call a tool now.");
    // Footer exists because there is copyable text
    expect(el.querySelector(".message-copy-btn")).not.toBeNull();
  });

  it("does not add a copy footer to empty finalized streaming messages", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);

    renderer.finalizeStreamingMessage(el);

    expect(el.querySelector(".message-footer")).toBeNull();
    expect(el.querySelector(".message-copy-btn")).toBeNull();
  });

  it("keeps a partial code block previewing as a code block", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "```js\nconst a = 1;");

    const content = el.querySelector(".message-content");
    expect(content.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(content.textContent).toContain("const a = 1;");
  });

  it("preserves the thinking block while streaming text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "pondering...");
    renderer.updateStreamingMessage(el, "some *italic");

    expect(el.querySelector(".streaming-thinking")).not.toBeNull();
    expect(el.querySelector(".streaming-text").innerHTML).toContain("<em>italic</em>");
  });

  it("does not render raw HTML from streamed text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "`<script>alert(1)</script>`");

    const content = el.querySelector(".message-content");
    expect(content.querySelector("script")).toBeNull();
  });

  it("copies assistant text without thinking label or content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible answer" },
        ],
      },
      false,
      true,
    );

    el.querySelector(".message-copy-btn").click();

    expect(writeText).toHaveBeenCalledWith("Visible answer");
  });

  it("removes unsafe HTML attributes and URL schemes from user markdown", () => {
    const el = renderer.renderUserMessage({
      content:
        '<img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)">link</a>',
    });

    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img").getAttribute("src")).toBeNull();
    expect(el.querySelector("img").getAttribute("onerror")).toBeNull();
    expect(el.querySelector("a").getAttribute("href")).toBeNull();
  });

  it("renders a fork action for user messages with an entry id", () => {
    const events = [];
    container.addEventListener("messagefork", (event) => events.push(event.detail));

    renderer.renderUserMessage({ content: "Try this path", entryId: "entry-user-1" }, true);
    container.querySelector(".message-fork-btn").click();

    expect(events).toEqual([{ entryId: "entry-user-1" }]);
  });

  it("highlights keyword matches across rendered messages", () => {
    renderer.renderUserMessage({ content: "Alpha beta gamma" }, true);
    renderer.renderAssistantMessage({ content: "Beta appears twice: beta." }, false, true);

    const count = renderer.highlightSearchQuery("beta");
    const marks = container.querySelectorAll("mark");

    expect(count).toBe(3);
    expect(marks).toHaveLength(3);
    expect(marks[0].textContent.toLowerCase()).toBe("beta");
  });

  it("scrolls the first highlighted match into view", () => {
    renderer.renderAssistantMessage({ content: "jump to keyword" }, false, true);

    let scrolled = false;
    Element.prototype.scrollIntoView = () => {
      scrolled = true;
    };

    const count = renderer.highlightSearchQuery("keyword");

    expect(count).toBe(1);
    expect(scrolled).toBe(true);
  });

  it("can force-scroll after rendering session history", async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1200 });

    try {
      renderer.forceScrollToBottom();

      expect(container.scrollTop).toBe(1200);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });

  it("stops auto-scrolling when the user scrolls up within the old near-bottom threshold", () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      callback();
      return 0;
    };
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 650 },
    });
    container.scrollTop = 0;

    try {
      container.dispatchEvent(new Event("scroll"));
      renderer.scrollToBottom();

      expect(container.scrollTop).toBe(0);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    }
  });
});

describe("MessageRenderer message toolbar timestamps", () => {
  let container;
  let renderer;

  beforeEach(async () => {
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    renderer = new MessageRenderer(container);
  });

  it("formats same-day times as HH:MM and cross-day as MM/DD HH:MM", async () => {
    const { formatMessageTime } = await import("./message-renderer.js");
    const now = new Date();
    const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime();
    expect(formatMessageTime(sameDay)).toBe("09:05");

    // A fixed past date: guaranteed to be a different calendar day, so the
    // assertion is deterministic regardless of the test run date.
    const otherDay = new Date(2020, 0, 15, 14, 30).getTime();
    expect(formatMessageTime(otherDay)).toBe("01/15 14:30");
  });

  it("returns an empty label for missing, invalid, or out-of-range timestamps", async () => {
    const { formatMessageTime } = await import("./message-renderer.js");
    expect(formatMessageTime(null)).toBe("");
    expect(formatMessageTime(undefined)).toBe("");
    expect(formatMessageTime("not-a-number")).toBe("");
    expect(formatMessageTime(NaN)).toBe("");
    expect(formatMessageTime(1e20)).toBe("");
  });

  it("renders the message time first in the user message footer", () => {
    const ts = new Date(2020, 0, 15, 10, 30).getTime();
    renderer.renderUserMessage({ content: "hello", timestamp: ts });

    const footer = container.querySelector(".message.user .message-footer");
    expect(footer).not.toBeNull();
    const time = footer.querySelector(".message-time");
    expect(time?.textContent).toBe("01/15 10:30");
    expect(time?.title).toContain("2020-01-15 10:30");
    // Order: time, then copy.
    expect(footer.querySelector(".message-copy-btn")).not.toBeNull();
    expect(footer.firstElementChild).toBe(time);
  });

  it("omits the time span when a user message carries no timestamp", () => {
    renderer.renderUserMessage({ content: "hello" });
    const footer = container.querySelector(".message.user .message-footer");
    expect(footer?.querySelector(".message-time")).toBeNull();
    expect(footer?.querySelector(".message-copy-btn")).not.toBeNull();
  });

  it("renders copy, time, then cost in the assistant footer", () => {
    const ts = new Date(2020, 0, 15, 9, 5).getTime();
    renderer.renderAssistantMessage({
      content: [{ type: "text", text: "answer" }],
      usage: { cost: { total: 0.0123 } },
      timestamp: ts,
    });

    const footer = container.querySelector(".message.assistant .message-footer");
    expect(footer?.querySelector(".message-copy-btn")).not.toBeNull();
    const time = footer?.querySelector(".message-time");
    expect(time?.textContent).toBe("01/15 09:05");
    expect(footer?.querySelector(".message-usage")?.textContent).toBe("$0.0123");
    const children = [...footer.children].map((el) => el.className);
    expect(children.indexOf("message-copy-btn")).toBeLessThan(children.indexOf("message-time"));
    expect(children.indexOf("message-time")).toBeLessThan(children.indexOf("message-usage"));
  });

  it("attaches the completion time when streaming finalizes", () => {
    const el = renderer.renderAssistantMessage(
      { content: [{ type: "text", text: "done" }], timestamp: 1 },
      true,
    );
    expect(el.querySelector(".message-footer")).toBeNull();

    renderer.finalizeStreamingMessage(el, { cost: { total: 0.01 } });
    const footer = el.querySelector(".message-footer");
    expect(footer?.querySelector(".message-time")).not.toBeNull();
  });

  it("reveals the user footer via the visible class on hover", () => {
    const el = renderer.renderUserMessage({ content: "hello", timestamp: 1 });
    const footer = el.querySelector(".message-footer");
    expect(footer.classList.contains("visible")).toBe(false);
    el.querySelector(".message-content").dispatchEvent(new MouseEvent("mouseenter"));
    expect(footer.classList.contains("visible")).toBe(true);
  });
});

describe("MessageRenderer locale change", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("updates copy button aria-label and title on locale change without re-rendering content", async () => {
    const el = renderer.renderAssistantMessage({ content: "hello **world**" }, false);
    const copyBtn = el.querySelector(".message-copy-btn");
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy message");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(copyBtn.getAttribute("aria-label")).toBe("复制消息");
    expect(copyBtn.title).toBe("复制消息");
    // Content must not be re-rendered on locale change.
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });

  it("toggles thinking content within its own message element", () => {
    const el = renderer.renderAssistantMessage({
      content: [{ type: "thinking", thinking: "pondering" }],
    });
    const toggle = el.querySelector("[data-thinking-toggle]");
    const content = el.querySelector(".thinking-content");
    expect(toggle.getAttribute("id")).toBeNull();
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(true);
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(false);
  });

  it("updates thinking label text on locale change", async () => {
    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "pondering" },
        ],
      },
      false,
    );
    const labelEl = el.querySelector(".thinking-label-text");
    expect(labelEl.textContent).toBe("Thinking");

    await setLocale("zh");

    expect(labelEl.textContent).toBe("思考中");
  });

  it("re-renders welcome on locale change when .welcome exists", async () => {
    renderer.renderWelcome({ workspacePath: "/home/user/project" });
    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("Welcome to Picot");

    await setLocale("zh");

    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("欢迎使用 Picot");
  });

  it("does not re-render streaming content on locale change and preserves _streamingRawText", async () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "partial **bold** text");
    expect(el._streamingRawText).toBe("partial **bold** text");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(el._streamingRawText).toBe("partial **bold** text");
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });
});

describe("MessageRenderer teardown", () => {
  it("clear() keeps the renderer live so a locale change still re-renders", async () => {
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    renderer.clear();
    renderer.renderWelcome({});
    await setLocale("zh");
    expect(container.querySelector(".welcome p").textContent).toBe("欢迎使用 Picot");
  });

  it("destroy() stops locale re-renders, removes the scroll listener, and is idempotent", async () => {
    const container = document.createElement("div");
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    const welcomeP = container.querySelector(".welcome p");
    expect(welcomeP.textContent).toBe("Welcome to Picot");

    renderer.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    expect(removeSpy).toHaveBeenCalled();
    // No re-render after destroy: the welcome stays English.
    await setLocale("zh");
    expect(welcomeP.textContent).toBe("Welcome to Picot");
  });
});
