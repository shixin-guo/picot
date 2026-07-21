import { afterEach, describe, expect, test, vi } from "vitest";
import { isSupportedImageMime, processImagePayload } from "./image-attachments.js";

// Stub Image so processImagePayload can exercise the canvas encode path
// without a real browser image decoder. Each test installs a factory that
// produces an Image mock whose onload fires synchronously on the next tick.
function stubImage({ width = 100, height = 100 } = {}) {
  const origImage = globalThis.Image;
  function MockImage() {
    const self = this;
    self.width = width;
    self.height = height;
    self.src = "";
    Object.defineProperty(self, "onload", {
      set(fn) {
        // Fire on next microtask, mirroring real Image load timing closely
        // enough for the promise chain to work.
        Promise.resolve().then(() => fn?.call(self));
      },
      get() {
        return null;
      },
      configurable: true,
    });
    Object.defineProperty(self, "onerror", {
      set() {},
      get() {
        return null;
      },
      configurable: true,
    });
  }
  globalThis.Image = MockImage;
  return () => {
    globalThis.Image = origImage;
  };
}

// Stub canvas.getContext + toDataURL so encodeLoadedImage produces
// deterministic output without a real canvas implementation.
function stubCanvas({ encodedBase64 = "encoded", encodedMime = null } = {}) {
  const origCreate = document.createElement.bind(document);
  const createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag) => {
    const el = origCreate(tag);
    if (tag === "canvas") {
      el.width = 0;
      el.height = 0;
      el.getContext = vi.fn(() => ({
        drawImage: vi.fn(),
      }));
      el.toDataURL = vi.fn((mime) => {
        const usedMime = encodedMime || mime;
        return `data:${usedMime};base64,${encodedBase64}`;
      });
    }
    return el;
  });
  return () => createElementSpy.mockRestore();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isSupportedImageMime", () => {
  test("returns true for supported image types", () => {
    expect(isSupportedImageMime("image/png")).toBe(true);
    expect(isSupportedImageMime("image/jpeg")).toBe(true);
    expect(isSupportedImageMime("image/gif")).toBe(true);
    expect(isSupportedImageMime("image/webp")).toBe(true);
  });

  test("returns false for unsupported types", () => {
    expect(isSupportedImageMime("application/pdf")).toBe(false);
    expect(isSupportedImageMime("text/plain")).toBe(false);
    expect(isSupportedImageMime("image/bmp")).toBe(false);
    expect(isSupportedImageMime("")).toBe(false);
    expect(isSupportedImageMime(undefined)).toBe(false);
  });
});

describe("processImagePayload", () => {
  test("rejects when data is missing", async () => {
    await expect(processImagePayload({ mimeType: "image/png" })).rejects.toThrow(
      "Missing image data",
    );
    await expect(processImagePayload({})).rejects.toThrow("Missing image data");
    await expect(processImagePayload(null)).rejects.toThrow("Missing image data");
  });

  test("rejects unsupported mimeType", async () => {
    await expect(processImagePayload({ data: "AAAA", mimeType: "text/plain" })).rejects.toThrow(
      "Unsupported image type: text/plain",
    );

    await expect(
      processImagePayload({ data: "AAAA", mimeType: "application/pdf" }),
    ).rejects.toThrow("Unsupported image type: application/pdf");

    await expect(processImagePayload({ data: "AAAA", mimeType: undefined })).rejects.toThrow(
      "Unsupported image type: undefined",
    );
  });

  test("decodes and returns JPEG as JPEG for a supported payload", async () => {
    const restoreImage = stubImage({ width: 800, height: 600 });
    const restoreCanvas = stubCanvas({ encodedBase64: "jpeg-encoded" });

    const result = await processImagePayload({ data: "AAAA", mimeType: "image/jpeg" });

    expect(result).toEqual({ data: "jpeg-encoded", mimeType: "image/jpeg" });

    restoreCanvas();
    restoreImage();
  });

  test("re-encodes non-JPEG types as PNG", async () => {
    const restoreImage = stubImage({ width: 800, height: 600 });
    const restoreCanvas = stubCanvas({ encodedBase64: "png-encoded" });

    const result = await processImagePayload({ data: "AAAA", mimeType: "image/webp" });

    expect(result).toEqual({ data: "png-encoded", mimeType: "image/png" });

    restoreCanvas();
    restoreImage();
  });

  test("re-encodes PNG as PNG", async () => {
    const restoreImage = stubImage({ width: 500, height: 500 });
    const restoreCanvas = stubCanvas({ encodedBase64: "png-out" });

    const result = await processImagePayload({ data: "AAAA", mimeType: "image/png" });

    expect(result).toEqual({ data: "png-out", mimeType: "image/png" });

    restoreCanvas();
    restoreImage();
  });

  test("rejects when canvas toDataURL produces no base64 data", async () => {
    const restoreImage = stubImage({ width: 100, height: 100 });
    const restoreCanvas = stubCanvas({ encodedBase64: "" });

    await expect(processImagePayload({ data: "AAAA", mimeType: "image/png" })).rejects.toThrow(
      "Failed to encode image",
    );

    restoreCanvas();
    restoreImage();
  });
});
