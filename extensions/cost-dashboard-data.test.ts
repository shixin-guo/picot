// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildCostDashboardPayload } from "./cost-dashboard-data.ts";

describe("buildCostDashboardPayload infobar aggregation", () => {
  it("adds an infobar payload with overview, models, projects, and usage", () => {
    const payload = buildCostDashboardPayload(
      [
        {
          id: "s1",
          title: "Session 1",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-06-05T10:00:00.000Z",
          totalCost: 4.5,
          inputTokens: 1000,
          outputTokens: 500,
          cacheRead: 250,
          cacheWrite: 100,
          totalTokens: 1850,
          toolCalls: 3,
          userMessages: 2,
          assistantMessages: 2,
          costPerUserMessage: 2.25,
          toolCostByName: { read_file: 1.2, edit_file: 0.8 },
        },
        {
          id: "s2",
          title: "Session 2",
          workspace: "/work/pi-beta",
          model: "gpt-4.1-mini",
          time: "2026-06-06T09:00:00.000Z",
          totalCost: 1.5,
          inputTokens: 400,
          outputTokens: 300,
          cacheRead: 50,
          cacheWrite: 20,
          totalTokens: 770,
          toolCalls: 1,
          userMessages: 1,
          assistantMessages: 1,
          costPerUserMessage: 1.5,
          toolCostByName: { read_file: 0.4 },
        },
        {
          id: "s3",
          title: "Session 3",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-06-06T11:30:00.000Z",
          totalCost: 3,
          inputTokens: 600,
          outputTokens: 200,
          cacheRead: 100,
          cacheWrite: 30,
          totalTokens: 930,
          toolCalls: 2,
          userMessages: 3,
          assistantMessages: 3,
          costPerUserMessage: 1,
          toolCostByName: { edit_file: 0.6, grep: 0.2 },
        },
      ],
      {
        from: new Date("2026-06-01T00:00:00.000Z"),
        to: new Date("2026-06-30T23:59:59.999Z"),
        granularity: "day",
        scope: "all",
        range: "30d",
        models: new Set(),
      } as any,
      new Date("2026-06-06T18:00:00.000Z"),
    );

    expect(payload.infobar.overview).toMatchObject({
      totalCost: 9,
      sessionCount: 3,
      messageCount: 12,
      daysActive: 2,
      todayCost: 4.5,
    });
    expect(payload.infobar.overview.avgCostPerDay).toBeCloseTo(4.5, 6);

    expect(payload.infobar.models[0]).toMatchObject({
      name: "gpt-4.1",
      cost: 7.5,
      count: 2,
    });

    expect(payload.infobar.projects[0]).toMatchObject({
      name: "pi-alpha",
      path: "/work/pi-alpha",
      cost: 7.5,
      sessions: 2,
    });

    expect(payload.infobar.usage).toMatchObject({
      totalTokens: 3550,
      inputTokens: 2000,
      outputTokens: 1000,
      cacheRead: 400,
      cacheWrite: 150,
      toolCalls: 6,
    });
    expect(payload.infobar.usage.tools[0]).toMatchObject({
      name: "read_file",
      count: 2,
      cost: 1.6,
    });
  });
});
