// ABOUTME: Verifies PDF preview loading and teardown behavior.
// ABOUTME: Covers cancellation without stale errors or worker leaks.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPdfRenderer } from "./file-pdf-preview.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createPdfRenderer", () => {
  test("destroy cancels an in-flight document load without reporting an error", async () => {
    let rejectLoad;
    const loadingTask = {
      promise: new Promise((_resolve, reject) => {
        rejectLoad = reject;
      }),
      destroy: vi.fn(),
    };
    const onError = vi.fn();
    const renderer = createPdfRenderer({
      filePath: "/workspace/report.pdf",
      onError,
      getDocumentImpl: () => loadingTask,
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    renderer.mount(parent);

    renderer.destroy();
    rejectLoad(new Error("cancelled"));
    await Promise.resolve();
    await Promise.resolve();

    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(parent.children).toHaveLength(0);
  });

  test("destroy releases a loaded PDF document", async () => {
    const pdfDoc = { numPages: 0, destroy: vi.fn() };
    const loadingTask = {
      promise: Promise.resolve(pdfDoc),
      destroy: vi.fn(),
    };
    const renderer = createPdfRenderer({
      filePath: "/workspace/report.pdf",
      getDocumentImpl: () => loadingTask,
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    renderer.mount(parent);
    await Promise.resolve();
    await Promise.resolve();

    renderer.destroy();

    expect(pdfDoc.destroy).toHaveBeenCalledOnce();
  });
});
