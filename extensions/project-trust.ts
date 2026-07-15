import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

export const PROJECT_TRUST_CHOICES = [
  "Trust once",
  "Trust and remember",
  "Open untrusted",
  "Cancel workspace opening",
] as const;

export default function projectTrust(pi: ExtensionAPI) {
  pi.on("project_trust", async (event, ctx): Promise<ProjectTrustEventResult> => {
    if (!ctx.hasUI) return { trusted: "no" };
    const choice = await ctx.ui.select(`Project resources require trust:\n${event.cwd}`, [
      ...PROJECT_TRUST_CHOICES,
    ]);
    if (choice === "Trust once") return { trusted: "yes" };
    if (choice === "Trust and remember") return { trusted: "yes", remember: true };
    return { trusted: "no" };
  });
}
