/**
 * PDF.js canvas renderer.
 *
 * Renders PDF pages into canvas elements inside a scrollable container.
 * The worker is configured to use the same-origin vendor bundle.
 * At runtime, the browser import map redirects pdfjs-dist/legacy/build/pdf.mjs
 * to the generated vendor file. In Vitest, the import resolves from node_modules.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Configure the worker to use the same-origin vendor bundle.
// This URL is only used in the browser (not in Vitest).
if (typeof window !== "undefined" && GlobalWorkerOptions) {
  GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.js";
}

export function createPdfRenderer({ filePath, onError, getDocumentImpl = getDocument }) {
  let container = null;
  let pdfDoc = null;
  let loadingTask = null;
  let renderTask = null;
  let destroyed = false;

  async function loadDocument() {
    if (!container || destroyed) return;
    try {
      const url = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
      const task = getDocumentImpl({ url });
      loadingTask = task;
      const loadedDocument = await task.promise;
      if (loadingTask === task) loadingTask = null;

      if (destroyed || !container) {
        void loadedDocument.destroy?.();
        return;
      }
      pdfDoc = loadedDocument;

      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        if (destroyed || !container) return;
        const page = await pdfDoc.getPage(pageNum);
        if (destroyed || !container) return;
        const viewport = page.getViewport({ scale: 1.5 });

        const canvas = document.createElement("canvas");
        canvas.className = "file-pdf-page";
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        container.appendChild(canvas);

        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context is unavailable");
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        renderTask = null;
      }
    } catch (error) {
      if (!destroyed && typeof onError === "function") onError(error);
    } finally {
      loadingTask = null;
    }
  }

  return {
    mount(parent) {
      destroyed = false;
      container = document.createElement("div");
      container.className = "file-pdf-container";
      parent.appendChild(container);
      void loadDocument();
    },

    update() {
      // PDF preview has no props to update.
    },

    destroy() {
      destroyed = true;
      renderTask?.cancel();
      renderTask = null;
      const activeLoadingTask = loadingTask;
      loadingTask = null;
      void activeLoadingTask?.destroy?.();
      const activeDocument = pdfDoc;
      pdfDoc = null;
      void activeDocument?.destroy?.();
      container?.remove();
      container = null;
    },
  };
}
