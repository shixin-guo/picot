import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handlePicotConfig } from "./picot-config";
import projectTrust from "./project-trust";

export const PICOT_BRIDGE_CAPABILITIES = Object.freeze({
  protocolVersion: 1,
  operations: Object.freeze({
    "picot.navigateTree": "Pi ctx.navigateTree",
    "picot.reloadResources": "Pi ctx.reload",
    "picot.projectTrust": "Pi project_trust event",
    "picot.config": "Configuration data plane (model catalog, API keys, config files)",
  }),
});

type ConfigRequest = {
  id?: string;
  op?: string;
  params?: Record<string, unknown>;
};

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

  // Configuration data plane. Invoked by the WebView via a native RPC prompt
  // (`/picot-config <json>`); extension commands run immediately without
  // hitting the LLM or session history. The result is streamed back through
  // `ctx.ui.notify(JSON)` and correlated by request id on the frontend
  // (see public/native/config-gateway.js).
  pi.registerCommand("picot-config", {
    description: "Picot Settings → Configuration data plane",
    handler: async (rawArguments, ctx) => {
      let request: ConfigRequest;
      try {
        request = JSON.parse(rawArguments) as ConfigRequest;
      } catch {
        return;
      }
      const id = typeof request.id === "string" ? request.id : "";
      if (!id) return;
      const respond = (payload: Record<string, unknown>) => {
        ctx.ui.notify(JSON.stringify({ __picotConfig: id, ...payload }), "info");
      };
      const op = typeof request.op === "string" ? request.op : "";
      const params = request.params && typeof request.params === "object" ? request.params : {};
      try {
        const result = await handlePicotConfig(op, params, ctx);
        respond(result as unknown as Record<string, unknown>);
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
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
