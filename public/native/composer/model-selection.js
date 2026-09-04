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
