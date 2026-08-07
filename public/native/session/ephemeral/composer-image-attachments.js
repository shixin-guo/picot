// ABOUTME: Stub for ephemeral chat composer image attachments — image
// ABOUTME: attachment support is not yet wired for ephemeral chats. Returns a
// ABOUTME: no-op controller with the same shape as the real module.

export function setupComposerImageAttachments() {
  return {
    addFiles() {},
    getImages: () => [],
    setImages() {},
    clear() {},
    destroy() {},
  };
}
