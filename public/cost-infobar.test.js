import { describe, expect, it } from "vitest";
import {
  renderCostInfobar,
  renderInfobarModels,
  renderInfobarOverview,
  renderInfobarProjects,
  renderInfobarToolCost,
  renderInfobarUsage,
} from "./cost-infobar.js";

describe("cost infobar renderers", () => {
  it("renders overview cards", () => {
    const target = document.createElement("div");
    renderInfobarOverview(
      target,
      {
        totalCost: 9,
        sessions: 7,
        messages: 22,
        totalTokens: 3550,
        activeDays: 4,
        currentStreak: 1,
        longestStreak: 3,
        peakHour: "3 PM",
        favoriteModel: "gpt-4.1",
      },
      {
        inputTokens: 2000,
        outputTokens: 1000,
        cacheRead: 400,
        cacheWrite: 150,
        toolCalls: 6,
      },
    );

    expect(target.querySelectorAll(".infobar-stat-card")).toHaveLength(12);
    expect(target.textContent).toContain("Total cost");
    expect(target.textContent).toContain("$9.00");
    expect(target.textContent).not.toContain("Peak hour");
    expect(target.textContent).toContain("Sessions");
    expect(target.textContent).toContain("Messages");
    expect(target.textContent).toContain("Tool Calls");
  });

  it("renders ranked model and project rows plus usage totals", () => {
    const models = document.createElement("div");
    const projects = document.createElement("div");
    const usage = document.createElement("div");
    const toolCost = document.createElement("div");
    const toolCostMeta = document.createElement("span");
    const OriginalChart = window.Chart;

    window.Chart = function MockChart() {
      return {
        destroy() {},
      };
    };

    try {
      renderInfobarModels(
        models,
        [
          { name: "gpt-4.1", cost: 7.5, count: 2, fraction: 1 },
          { name: "gpt-4.1-mini", cost: 1.5, count: 1, fraction: 0.2 },
        ],
        {
          sessions: [
            {
              model: "gpt-4.1",
              time: "2026-06-05T10:00:00.000Z",
              totalTokens: 3200,
              inputTokens: 2000,
              outputTokens: 900,
            },
            {
              model: "gpt-4.1-mini",
              time: "2026-06-06T10:00:00.000Z",
              totalTokens: 1200,
              inputTokens: 600,
              outputTokens: 400,
            },
          ],
        },
      );
      renderInfobarProjects(projects, [
        { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
      ]);
      renderInfobarUsage(usage, {
        totalTokens: 3550,
        inputTokens: 2000,
        outputTokens: 1000,
        cacheRead: 400,
        cacheWrite: 150,
        toolCalls: 6,
        tools: [
          { name: "read_file", count: 2, cost: 1.6, fraction: 1 },
          { name: "edit_file", count: 2, cost: 1.4, fraction: 0.875 },
        ],
      });
      renderInfobarToolCost(
        toolCost,
        {
          totalTokens: 3550,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
          tools: [
            { name: "read_file", count: 2, cost: 1.6, fraction: 1 },
            { name: "edit_file", count: 2, cost: 1.4, fraction: 0.875 },
          ],
        },
        toolCostMeta,
      );

      expect(models.querySelectorAll(".infobar-model-legend-row")).toHaveLength(2);
      expect(projects.querySelector(".infobar-projects-chart")).not.toBeNull();
      expect(usage.textContent).toContain("Total Tokens");
      expect(usage.textContent).toContain("3.6K");
      expect(toolCost.textContent).toContain("read_file");
      expect(toolCostMeta.textContent).toContain("2 tracked");
    } finally {
      window.Chart = OriginalChart;
    }
  });

  it("uses the same model palette for chart bars and legend dots", () => {
    const models = document.createElement("div");
    const chartCalls = [];
    const OriginalChart = window.Chart;

    window.Chart = function MockChart(_canvas, config) {
      chartCalls.push(config);
      return {
        destroy() {},
      };
    };

    try {
      renderInfobarModels(
        models,
        [
          { name: "claude-sonnet-4-6", cost: 7.5, count: 2, fraction: 1 },
          { name: "claude-opus-4-7", cost: 3.1, count: 1, fraction: 0.4 },
          { name: "claude-opus-4-8", cost: 1.2, count: 1, fraction: 0.16 },
        ],
        {
          sessions: [
            {
              model: "claude-sonnet-4-6",
              time: "2026-06-05T10:00:00.000Z",
              totalTokens: 3200,
              inputTokens: 2000,
              outputTokens: 900,
            },
            {
              model: "claude-opus-4-7",
              time: "2026-06-06T10:00:00.000Z",
              totalTokens: 1200,
              inputTokens: 600,
              outputTokens: 400,
            },
            {
              model: "claude-opus-4-8",
              time: "2026-06-07T10:00:00.000Z",
              totalTokens: 900,
              inputTokens: 500,
              outputTokens: 300,
            },
          ],
        },
      );

      expect(chartCalls).toHaveLength(1);
      const datasets = chartCalls[0].data.datasets;
      expect(datasets[0].backgroundColor).toBe("#3b82f6");
      expect(datasets[1].backgroundColor).toBe("#10b981");
      expect(datasets[2].backgroundColor).toBe("#f59e0b");
      expect(datasets[0].borderRadius({ dataIndex: 0 })).toEqual({
        topLeft: 6,
        topRight: 6,
        bottomLeft: 6,
        bottomRight: 6,
      });
      expect(datasets[1].borderRadius({ dataIndex: 0 })).toBe(0);
    } finally {
      window.Chart = OriginalChart;
    }
  });

  it("renders the single-page infobar sections including sessions", () => {
    const section = document.createElement("section");
    section.innerHTML = `
      <span id="infobar-page-title"></span>
      <div class="infobar-tabs">
        <a class="infobar-tab" href="#usage-overview">Overview</a>
        <a class="infobar-tab" href="#usage-models">Models</a>
        <a class="infobar-tab" href="#usage-tool-cost">Tool Cost</a>
        <a class="infobar-tab" href="#usage-projects">Projects</a>
        <a class="infobar-tab" href="#usage-sessions">Sessions</a>
      </div>
      <div class="infobar-panel is-active" data-infobar-panel="overview">
        <div id="infobar-overview-grid"></div>
        <div id="infobar-activity-panel"></div>
        <div id="infobar-overview-note"></div>
      </div>
      <div class="infobar-panel is-active" data-infobar-panel="tool-cost">
        <div id="infobar-tool-cost-panel"></div>
      </div>
      <div class="infobar-panel is-active" data-infobar-panel="models"><div id="infobar-models-list"></div></div>
      <div class="infobar-panel is-active" data-infobar-panel="projects"><div id="infobar-projects-list"></div></div>
      <div class="infobar-panel is-active" data-infobar-panel="sessions"><div id="infobar-sessions-panel"></div></div>
      <span id="infobar-range-meta"></span>
    `;

    renderCostInfobar(section, {
      range: {
        range: "30d",
        scope: "all",
        from: "2026-05-11T00:00:00.000Z",
        to: "2026-06-06T00:00:00.000Z",
      },
      series: [
        { bucket: "2026-06-05", cost: 2.4, tokens: 1000 },
        { bucket: "2026-06-06", cost: 5.1, tokens: 3000 },
      ],
      sessions: [
        {
          title: "Session 1",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-05-18T10:00:00.000Z",
          totalCost: 1.2,
          totalTokens: 900,
          toolCalls: 1,
          userMessages: 1,
          assistantMessages: 1,
        },
        {
          title: "Session 2",
          workspace: "/work/pi-alpha",
          model: "gpt-4.1",
          time: "2026-06-06T10:00:00.000Z",
          totalCost: 4.2,
          totalTokens: 3200,
          toolCalls: 6,
          userMessages: 2,
          assistantMessages: 2,
        },
        {
          title: "Session 3",
          workspace: "/work/pi-beta",
          model: "gpt-4.1-mini",
          time: "2026-06-05T08:30:00.000Z",
          totalCost: 2.4,
          totalTokens: 1400,
          toolCalls: 3,
          userMessages: 2,
          assistantMessages: 2,
        },
      ],
      summary: {
        totalTokens: 5500,
      },
      infobar: {
        overview: {
          totalCost: 9,
          sessionCount: 7,
          messageCount: 22,
          daysActive: 4,
        },
        models: [{ name: "gpt-4.1", cost: 7.5, count: 2, fraction: 1 }],
        projects: [
          { name: "pi-alpha", path: "/work/pi-alpha", cost: 7.5, sessions: 2, fraction: 1 },
        ],
        usage: {
          totalTokens: 3550,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheRead: 400,
          cacheWrite: 150,
          toolCalls: 6,
          tools: [{ name: "read_file", count: 2, cost: 1.6, fraction: 1 }],
        },
      },
    });

    expect(section.querySelectorAll("#infobar-overview-grid .infobar-stat-card")).toHaveLength(12);
    expect(section.querySelector("#infobar-overview-grid").textContent).toContain("Total cost");
    expect(section.querySelector("#infobar-overview-grid").textContent).toContain("$9.00");
    expect(section.querySelector("#infobar-overview-grid").textContent).not.toContain("Peak hour");
    expect(
      section.querySelector("#infobar-activity-panel").querySelectorAll(".infobar-activity-cell")
        .length,
    ).toBeGreaterThan(0);
    expect(section.querySelector("#infobar-overview-note").textContent).toContain("War and Peace");
    expect(section.querySelector("#infobar-models-list").textContent).toContain("gpt-4.1");
    expect(section.querySelector("#infobar-tool-cost-panel").textContent).toContain("read_file");
    expect(section.querySelector("#infobar-sessions-panel").textContent).toContain("Session 1");
  });
});
