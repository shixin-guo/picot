import * as path from "node:path";

export interface CostSession {
  time: string;
  model?: string;
  workspace?: string;
  totalCost?: number;
  totalTokens?: number;
  userMessages?: number;
  assistantMessages?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  toolCalls?: number;
  toolCostByName?: Record<string, number>;
  [key: string]: unknown;
}

export interface CostParams {
  from?: Date;
  to?: Date;
  granularity?: string;
  scope?: string;
  range?: string;
}

function bucketForDate(date: Date, granularity: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (granularity === "day") return `${year}-${month}-${day}`;
  if (granularity === "month") return `${year}-${month}`;
  const tmp = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const weekYear = tmp.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${weekYear}-W${String(weekNo).padStart(2, "0")}`;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getProjectName(workspace: string): string {
  const trimmed = typeof workspace === "string" ? workspace.trim() : "";
  if (!trimmed) return "Unknown Project";
  const base = path.basename(trimmed);
  return base || trimmed;
}

export function buildEmptyCostDashboardPayload(params: CostParams = {}) {
  return {
    range: {
      from: params.from?.toISOString?.() || null,
      to: params.to?.toISOString?.() || null,
      granularity: params.granularity || "day",
      scope: params.scope || "all",
      range: params.range || "30d",
    },
    summary: {
      totalCost: 0,
      totalTokens: 0,
      sessionCount: 0,
      userMessageCount: 0,
      avgCostPerSession: 0,
      avgCostPerUserMessage: 0,
    },
    series: [],
    breakdown: { byModel: [], byTool: [] },
    topSessions: [],
    sessions: [],
    infobar: {
      overview: {
        totalCost: 0,
        sessionCount: 0,
        messageCount: 0,
        daysActive: 0,
        avgCostPerDay: 0,
        todayCost: 0,
      },
      models: [],
      projects: [],
      usage: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        toolCalls: 0,
        tools: [],
      },
    },
  };
}

export function buildCostDashboardPayload(
  sessions: CostSession[],
  params: CostParams,
  now = new Date(),
) {
  const payload = buildEmptyCostDashboardPayload(params);
  payload.sessions = [...sessions].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  payload.summary.sessionCount = payload.sessions.length;

  const byModel = new Map<string, { cost: number; count: number }>();
  const byTool = new Map<string, number>();
  const byBucket = new Map<string, { cost: number; tokens: number }>();
  const byProject = new Map<
    string,
    { name: string; path: string; cost: number; sessions: number }
  >();
  const infobarTools = new Map<string, { cost: number; count: number }>();
  const activeDays = new Set<string>();
  const todayKey = dayKey(now);

  for (const s of payload.sessions) {
    payload.summary.totalCost += Number(s.totalCost || 0);
    payload.summary.totalTokens += Number(s.totalTokens || 0);
    payload.summary.userMessageCount += Number(s.userMessages || 0);

    const modelKey = s.model || "unknown";
    const modelStats = byModel.get(modelKey) || { cost: 0, count: 0 };
    modelStats.cost += Number(s.totalCost || 0);
    modelStats.count += 1;
    byModel.set(modelKey, modelStats);

    const time = new Date(s.time);
    const bucket = bucketForDate(time, params.granularity || "day");
    const bucketStats = byBucket.get(bucket) || { cost: 0, tokens: 0 };
    bucketStats.cost += Number(s.totalCost || 0);
    bucketStats.tokens += Number(s.totalTokens || 0);
    byBucket.set(bucket, bucketStats);

    const sessionDay = dayKey(time);
    activeDays.add(sessionDay);
    if (sessionDay === todayKey) {
      payload.infobar.overview.todayCost += Number(s.totalCost || 0);
    }

    const workspacePath = s.workspace || "";
    const projectKey = workspacePath || "unknown-project";
    const projectStats = byProject.get(projectKey) || {
      name: getProjectName(workspacePath),
      path: workspacePath,
      cost: 0,
      sessions: 0,
    };
    projectStats.cost += Number(s.totalCost || 0);
    projectStats.sessions += 1;
    byProject.set(projectKey, projectStats);

    for (const [toolName, toolCost] of Object.entries(s.toolCostByName || {})) {
      const numericCost = Number(toolCost || 0);
      byTool.set(toolName, (byTool.get(toolName) || 0) + numericCost);
      const toolStats = infobarTools.get(toolName) || { cost: 0, count: 0 };
      toolStats.cost += numericCost;
      toolStats.count += 1;
      infobarTools.set(toolName, toolStats);
    }

    payload.infobar.overview.totalCost += Number(s.totalCost || 0);
    payload.infobar.overview.sessionCount += 1;
    payload.infobar.overview.messageCount +=
      Number(s.userMessages || 0) + Number(s.assistantMessages || 0);
    payload.infobar.usage.totalTokens += Number(s.totalTokens || 0);
    payload.infobar.usage.inputTokens += Number(s.inputTokens || 0);
    payload.infobar.usage.outputTokens += Number(s.outputTokens || 0);
    payload.infobar.usage.cacheRead += Number(s.cacheRead || 0);
    payload.infobar.usage.cacheWrite += Number(s.cacheWrite || 0);
    payload.infobar.usage.toolCalls += Number(s.toolCalls || 0);
  }

  payload.summary.avgCostPerSession =
    payload.summary.sessionCount > 0 ? payload.summary.totalCost / payload.summary.sessionCount : 0;
  payload.summary.avgCostPerUserMessage =
    payload.summary.userMessageCount > 0
      ? payload.summary.totalCost / payload.summary.userMessageCount
      : 0;

  payload.series = Array.from(byBucket.entries())
    .map(([bucket, value]) => ({ bucket, cost: value.cost, tokens: value.tokens }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  payload.breakdown.byModel = Array.from(byModel.entries())
    .map(([name, value]) => ({ name, cost: value.cost }))
    .sort((a, b) => b.cost - a.cost);
  payload.breakdown.byTool = Array.from(byTool.entries())
    .map(([name, cost]) => ({ name, cost }))
    .sort((a, b) => b.cost - a.cost);
  payload.topSessions = [...payload.sessions]
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 20);

  payload.infobar.overview.daysActive = activeDays.size;
  payload.infobar.overview.avgCostPerDay =
    activeDays.size > 0 ? payload.infobar.overview.totalCost / activeDays.size : 0;

  const maxModelCost = Math.max(...payload.breakdown.byModel.map((row) => row.cost), 0);
  payload.infobar.models = Array.from(byModel.entries())
    .map(([name, value]) => ({
      name,
      cost: value.cost,
      count: value.count,
      fraction: maxModelCost > 0 ? value.cost / maxModelCost : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  const projects = Array.from(byProject.values()).sort((a, b) => b.cost - a.cost);
  const maxProjectCost = Math.max(...projects.map((row) => row.cost), 0);
  payload.infobar.projects = projects.map((project) => ({
    ...project,
    fraction: maxProjectCost > 0 ? project.cost / maxProjectCost : 0,
  }));

  const tools = Array.from(infobarTools.entries())
    .map(([name, value]) => ({ name, cost: value.cost, count: value.count }))
    .sort((a, b) => b.cost - a.cost);
  const maxToolCost = Math.max(...tools.map((row) => row.cost), 0);
  payload.infobar.usage.tools = tools.map((tool) => ({
    ...tool,
    fraction: maxToolCost > 0 ? tool.cost / maxToolCost : 0,
  }));

  return payload;
}
