export async function selectModel({ model, rpcCommand, refreshModelInfo, applySelectedModel }) {
  const display = model.id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const result = await rpcCommand(
    { type: "set_model", provider: model.provider, modelId: model.id },
    `Switching to ${display}...`,
  );

  if (!result?.success) {
    await refreshModelInfo();
    return result;
  }

  applySelectedModel(model);
  return result;
}
