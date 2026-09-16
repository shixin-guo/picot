// ABOUTME: Compares provider-scoped model identities for composer selection state.
// ABOUTME: Keeps duplicate model IDs from different providers distinguishable.

export function isSelectedModel(model, selection) {
  return Boolean(
    model?.provider &&
      model?.id &&
      model.provider === selection?.provider &&
      model.id === selection?.modelId,
  );
}

/**
 * Split visibility-filtered models into the starred (scoped) section and the
 * remaining enabled models. Scoped order follows the stored enabledModels
 * order; ids that no longer resolve to a visible model are dropped so hidden
 * or unavailable stars never render.
 */
export function splitModelsByScope(models, scopedModelIds) {
  if (!Array.isArray(models)) return { scoped: [], remaining: [] };
  const byId = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const scoped = (Array.isArray(scopedModelIds) ? scopedModelIds : [])
    .map((id) => byId.get(id))
    .filter(Boolean);
  const scopedIds = new Set(scoped.map((model) => `${model.provider}/${model.id}`));
  return {
    scoped,
    remaining: models.filter((model) => !scopedIds.has(`${model.provider}/${model.id}`)),
  };
}
