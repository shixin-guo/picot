// "No context available" fires when the backend's per-session context is
// momentarily unbound — e.g. mid new_session/switch_session/fork reload,
// between that session's shutdown and the next session_start. It's
// transient, so retry a few times before surfacing it as a real failure.
const CONTEXT_RETRY_DELAYS_MS = [300, 800, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function selectModel({ model, rpcCommand, refreshModelInfo, applySelectedModel }) {
  const display = model.id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const cmd = { type: "set_model", provider: model.provider, modelId: model.id };

  let result = await rpcCommand(cmd, `Switching to ${display}…`);
  for (const delay of CONTEXT_RETRY_DELAYS_MS) {
    if (result?.success || result?.error !== "No context available") break;
    await sleep(delay);
    result = await rpcCommand(cmd, `Switching to ${display}…`, true);
  }

  if (!result?.success) {
    await refreshModelInfo();
    if (result?.error === "No context available") {
      return {
        success: false,
        error: "Session is still starting up — please try again in a moment.",
      };
    }
    return { success: false, error: result?.error || "Model switch failed" };
  }

  applySelectedModel(model);
  return result;
}
