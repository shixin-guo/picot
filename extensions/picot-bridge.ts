import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import projectTrust from "./project-trust";

export const PICOT_BRIDGE_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  operations: Object.freeze({
    "picot.navigateTree": "Pi ctx.navigateTree",
    "picot.reloadResources": "Pi ctx.reload",
    "picot.projectTrust": "Pi project_trust event",
  }),
});

type NavigateArguments = {
  targetId: string;
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
};

export default function picotBridge(pi: ExtensionAPI) {
  projectTrust(pi);

  pi.registerCommand("picot-capabilities", {
    description: "Describe the namespaced Picot bridge operations",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(PICOT_BRIDGE_CAPABILITIES), "info");
    },
  });

  pi.registerCommand("picot-reload-resources", {
    description: "Reload Pi extensions, skills, prompts, themes, and context",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  pi.registerCommand("picot-navigate-tree", {
    description: "Navigate the Pi session tree using a JSON argument",
    handler: async (rawArguments, ctx) => {
      const args = JSON.parse(rawArguments) as NavigateArguments;
      if (!args.targetId || typeof args.targetId !== "string") {
        throw new Error("picot.navigateTree requires targetId");
      }
      await ctx.navigateTree(args.targetId, {
        summarize: args.summarize,
        customInstructions: args.customInstructions,
        replaceInstructions: args.replaceInstructions,
        label: args.label,
      });
    },
  });
}
