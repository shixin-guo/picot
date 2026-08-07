// ABOUTME: Provides in-memory diff content descriptors for FilePreviewPanel integration.
// ABOUTME: Diff identities are workspace-local and never persisted as FileTabState entries.

export function createDiffTabId(comparison, pathBytesBase64) {
  return `diff:${comparison}:${pathBytesBase64}`;
}

export function createDiffContent(descriptor) {
  return {
    kind: "diff",
    id: createDiffTabId(descriptor.comparison, descriptor.pathBytesBase64),
    descriptor,
  };
}
