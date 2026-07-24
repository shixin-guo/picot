import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupComposerImageAttachments } from "./composer-images.js";

describe("composer image attachments", () => {
  let dom;
  let input;
  let attachButton;
  let imageInput;
  let previews;
  let dropTarget;

  beforeEach(() => {
    dom = new JSDOM(`
      <textarea id="message-input"></textarea>
      <button id="attach-btn" type="button"></button>
      <input id="image-input" type="file" />
      <div id="composer-card"></div>
      <div id="image-previews" class="hidden"></div>
    `);
    globalThis.document = dom.window.document;
    globalThis.File = dom.window.File;
    input = document.getElementById("message-input");
    attachButton = document.getElementById("attach-btn");
    imageInput = document.getElementById("image-input");
    previews = document.getElementById("image-previews");
    dropTarget = document.getElementById("composer-card");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.document;
    delete globalThis.File;
  });

  it("opens the file picker from the attach button and tracks previews", async () => {
    const clickPicker = vi.spyOn(imageInput, "click").mockImplementation(() => {});
    const controller = setupComposerImageAttachments({
      input,
      attachButton,
      imageInput,
      previewContainer: previews,
      dropTarget,
      processImageFile: async (file) => ({
        type: "image",
        data: `encoded-${file.name}`,
        mimeType: "image/png",
      }),
    });

    attachButton.click();
    await controller.addFiles([new File(["fake"], "screen.png", { type: "image/png" })]);

    expect(clickPicker).toHaveBeenCalledOnce();
    expect(controller.getImages()).toEqual([
      { type: "image", data: "encoded-screen.png", mimeType: "image/png" },
    ]);
    expect(previews.classList.contains("hidden")).toBe(false);
    expect(previews.querySelectorAll(".image-preview")).toHaveLength(1);
  });
});
