import * as path from "node:path";

type SearchMatch = {
  role: string;
  snippet: string;
};

export function projectSearchText(workspacePath: string): string {
  const trimmed = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!trimmed) return "";
  return [path.basename(trimmed), trimmed].join(" ").toLowerCase();
}

export function buildProjectSearchMatch(query: string, workspacePath: string): SearchMatch | null {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q || !projectSearchText(workspacePath).includes(q)) return null;

  const projectName = path.basename(workspacePath) || workspacePath;
  return {
    role: "project",
    snippet: `Project: ${projectName}`,
  };
}
