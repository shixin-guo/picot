// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildProjectAgentPrompt,
  buildSuperAgentNotificationPrompt,
  buildTaskComposerPrompt,
  markTaskFinished,
  markTaskForDispatch,
  markTaskNeedsInput,
  normalizeSuperAgentTasks,
} from "./task-state.js";

describe("super-agent task state", () => {
  it("normalizes legacy tasks with source, result, dispatch, and event fields", () => {
    const [task] = normalizeSuperAgentTasks([
      {
        id: "task-1",
        status: "pending",
        title: "Fix login",
        targetProject: "/repo",
      },
    ]);

    expect(task.source).toEqual({
      channel: "local",
      conversationId: null,
      userId: null,
      messageId: null,
    });
    expect(task.result).toEqual({
      status: null,
      summary: null,
      completedAt: null,
      failReason: null,
    });
    expect(task.dispatch).toEqual({
      targetProject: "/repo",
      superAgentPort: null,
      childPort: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(task.events).toEqual([]);
  });

  it("records dispatch metadata and an auditable status event", () => {
    const task = markTaskForDispatch(
      {
        id: "task-1",
        status: "pending",
        title: "Fix login",
        targetProject: "/repo",
      },
      { superAgentPort: 3001, childPort: 3002, now: "2026-07-10T12:00:00.000Z" },
    );

    expect(task.status).toBe("running");
    expect(task.dispatch).toMatchObject({
      targetProject: "/repo",
      superAgentPort: 3001,
      childPort: 3002,
      startedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(task.events).toContainEqual({
      at: "2026-07-10T12:00:00.000Z",
      type: "dispatched",
      status: "running",
      message: "Dispatched to project agent on port 3002.",
    });
  });

  it("records a structured completion result without losing source binding", () => {
    const task = markTaskFinished(
      {
        id: "task-1",
        status: "running",
        title: "Fix login",
        source: {
          channel: "telegram",
          conversationId: "chat-42",
          userId: "user-7",
          messageId: "msg-9",
        },
        dispatch: {
          targetProject: "/repo",
          superAgentPort: 3001,
          childPort: 3002,
          startedAt: "2026-07-10T12:00:00.000Z",
          finishedAt: null,
        },
      },
      {
        status: "done",
        summary: "Project agent ended. Review the child session for details.",
        now: "2026-07-10T12:05:00.000Z",
      },
    );

    expect(task.source.channel).toBe("telegram");
    expect(task.status).toBe("done");
    expect(task.result).toMatchObject({
      status: "done",
      summary: "Project agent ended. Review the child session for details.",
      completedAt: "2026-07-10T12:05:00.000Z",
      failReason: null,
    });
    expect(task.dispatch.finishedAt).toBe("2026-07-10T12:05:00.000Z");
    expect(task.events.at(-1)).toMatchObject({
      type: "completed",
      status: "done",
    });
  });

  it("builds project and Super Agent prompts with task identity and reply routing", () => {
    const task = {
      id: "task-1",
      status: "running",
      title: "Fix login",
      description: "Investigate the failed OAuth redirect.",
      targetProject: "/repo",
      source: {
        channel: "telegram",
        conversationId: "chat-42",
        userId: "user-7",
        messageId: "msg-9",
      },
    };

    expect(buildProjectAgentPrompt(task)).toContain("Task ID: task-1");
    expect(buildProjectAgentPrompt(task)).toContain("If you need clarification");
    expect(
      buildSuperAgentNotificationPrompt(task, { status: "done", summary: "Finished" }),
    ).toContain("Reply target: telegram/chat-42");
  });

  it("builds a main-chat task prompt with the task snapshot and source binding", () => {
    expect(
      buildTaskComposerPrompt({
        id: "task-1",
        status: "pending",
        title: "Fix login",
        description: "Investigate OAuth.",
        targetProject: "/repo",
        source: { channel: "telegram", conversationId: "chat-42" },
      }),
    ).toContain("Task ID: task-1");
    expect(
      buildTaskComposerPrompt({
        id: "task-1",
        source: { channel: "telegram", conversationId: "chat-42" },
      }),
    ).toContain("Source: telegram/chat-42");
  });

  it("records a clarification request without losing the original Telegram source", () => {
    const task = markTaskNeedsInput(
      {
        id: "task-1",
        status: "pending",
        title: "Fix login",
        source: {
          channel: "telegram",
          conversationId: "chat-42",
          userId: "user-7",
          messageId: "msg-9",
        },
      },
      {
        question: "Which tenant should the agent use?",
        now: "2026-07-10T12:03:00.000Z",
      },
    );

    expect(task.status).toBe("needs_input");
    expect(task.source).toMatchObject({
      channel: "telegram",
      conversationId: "chat-42",
      userId: "user-7",
    });
    expect(task.result.failReason).toBe("Which tenant should the agent use?");
    expect(task.events.at(-1)).toEqual({
      at: "2026-07-10T12:03:00.000Z",
      type: "needs_input",
      status: "needs_input",
      message: "Which tenant should the agent use?",
    });
  });
});
