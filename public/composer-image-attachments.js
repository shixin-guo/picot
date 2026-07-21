// ABOUTME: Reusable image-attachment composer setup: attach button, file input,
// ABOUTME: preview rendering, paste handler, and pending-image collection with cleanup.

/**
 * Wires the attach-button / file-input / preview / paste flow for a composer.
 * Returns a cleanup function and a getter for the current pending images.
 * Used by both the main chat (app.js) and ephemeral chats so both surfaces
 * share the exact same attachment behavior without duplicating DOM wiring.
 *
 * opts:
 *   doc              Document instance
 *   composerCard     the composer-card element (drag & drop target)
 *   textarea         the input/textarea (paste target + focus return)
 *   attachBtn        button element that opens the picker
 *   imageInput       hidden <input type="file"> element
 *   imagePreviews    container where preview chips render
 *   processImageFile(file)    Promise<{data, mimeType}> from image-attachments.js
 *   processImagePayload(p)    ditto, for native picker payloads
 *   pickImageFiles?(cwd)      optional native picker; invoked when available
 *   getWorkspacePath?()       optional cwd hint for the native picker
 *   isNativeAvailable?()      gates native vs. browser file input
 *   onError?(message)         optional error sink (e.g. messageRenderer.renderError)
 *   i18n                       error-message lookup; expects { key, fallback } shape via t()
 */
export function setupComposerImageAttachments(opts) {
  const {
    doc,
    composerCard,
    textarea,
    attachBtn,
    imageInput,
    imagePreviews,
    processImageFile,
    processImagePayload,
    pickImageFiles,
    getWorkspacePath,
    isNativeAvailable,
    onError,
    t,
  } = opts;

  let pendingImages = [];

  if (!composerCard || !textarea || !attachBtn || !imageInput || !imagePreviews) {
    return {
      getPendingImages: () => [],
      renderPreviews: () => {},
      destroy: () => {},
    };
  }

  async function addImageFiles(files) {
    for (const file of files) {
      if (!file?.type?.startsWith("image/")) continue;
      try {
        const img = await processImageFile(file);
        pendingImages.push(img);
      } catch (e) {
        console.error("[composer-attachments] Image processing failed:", e);
      }
    }
    renderPreviews();
  }

  async function addImagePayloads(payloads) {
    for (const payload of payloads) {
      try {
        const img = await processImagePayload(payload);
        pendingImages.push(img);
      } catch (e) {
        console.error("[composer-attachments] Native image processing failed:", e);
      }
    }
    renderPreviews();
  }

  function onAttachClick() {
    if (
      typeof isNativeAvailable === "function" &&
      isNativeAvailable() &&
      typeof pickImageFiles === "function"
    ) {
      const workspacePath = (typeof getWorkspacePath === "function" && getWorkspacePath()) || null;
      pickImageFiles(workspacePath)
        .then((result) => {
          if (Array.isArray(result) && result.length > 0) return addImagePayloads(result);
          return undefined;
        })
        .catch((err) => {
          console.error("[composer-attachments] Native image picker failed:", err);
          onError?.(t?.("errors.failedToAttachImage", { error: err }) || "Failed to attach image");
        });
      return;
    }
    imageInput.click();
  }

  function onInputChange() {
    addImageFiles(imageInput.files);
    imageInput.value = "";
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function onDrop(e) {
    e.preventDefault();
    addImageFiles(e.dataTransfer.files);
  }

  function onPaste(e) {
    const files = [];
    for (const item of e.clipboardData?.items || []) {
      if (!item.type?.startsWith("image/")) continue;
      files.push(item.getAsFile());
    }
    if (files.length) addImageFiles(files);
  }

  function renderPreviews() {
    imagePreviews.replaceChildren();
    if (pendingImages.length === 0) {
      imagePreviews.classList.add("hidden");
      return;
    }
    imagePreviews.classList.remove("hidden");
    pendingImages.forEach((img, i) => {
      const preview = doc.createElement("div");
      preview.className = "image-preview";
      const image = doc.createElement("img");
      image.src = `data:${img.mimeType};base64,${img.data}`;
      image.alt = "";
      const removeButton = doc.createElement("button");
      removeButton.type = "button";
      removeButton.className = "image-preview-remove";
      removeButton.dataset.index = String(i);
      removeButton.textContent = "✕";
      removeButton.addEventListener("click", () => {
        pendingImages.splice(i, 1);
        renderPreviews();
      });
      preview.append(image, removeButton);
      imagePreviews.appendChild(preview);
    });
  }

  attachBtn.addEventListener("click", onAttachClick);
  imageInput.addEventListener("change", onInputChange);
  composerCard.addEventListener("dragover", onDragOver);
  composerCard.addEventListener("drop", onDrop);
  textarea.addEventListener("paste", onPaste);

  function consumePendingImages() {
    const out = pendingImages.map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType || "image/png",
    }));
    pendingImages = [];
    renderPreviews();
    return out;
  }

  return {
    getPendingImages: () => pendingImages,
    consumePendingImages,
    renderPreviews,
    destroy: () => {
      attachBtn.removeEventListener("click", onAttachClick);
      imageInput.removeEventListener("change", onInputChange);
      composerCard.removeEventListener("dragover", onDragOver);
      composerCard.removeEventListener("drop", onDrop);
      textarea.removeEventListener("paste", onPaste);
      pendingImages = [];
      imagePreviews.replaceChildren();
      imagePreviews.classList.add("hidden");
    },
  };
}
