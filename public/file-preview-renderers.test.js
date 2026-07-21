import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileRenderer } from "./file-preview-renderers.js";
import { initI18n } from "./i18n.js";

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = (_url) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          app: { welcome: "Welcome" },
          messages: { copy: "Copy", copied: "Copied!" },
          files: { loading: "Loading…" },
        }),
    });
  await initI18n();
});

let container;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
});

describe("createFileRenderer — renderer selection", () => {
  test("Markdown → markdown renderer with preview mode", () => {
    const renderer = createFileRenderer({
      filePath: "README.md",
      content: "# Title",
      mode: "preview",
    });
    renderer.mount(container);
    expect(renderer.contentType).toBe("markdown");
    expect(container.querySelector(".file-markdown-preview")).not.toBeNull();
    renderer.destroy();
  });

  test("Markdown edit mode → CodeMirror", () => {
    const renderer = createFileRenderer({
      filePath: "README.md",
      content: "# Title",
      mode: "edit",
    });
    renderer.mount(container);
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    renderer.destroy();
  });

  test("JS text → CodeMirror renderer", () => {
    const renderer = createFileRenderer({
      filePath: "main.js",
      content: "const x = 1;\n",
      readOnly: true,
    });
    renderer.mount(container);
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(renderer.contentType).toBe("text");
    renderer.destroy();
  });

  test("Image → image renderer", () => {
    const renderer = createFileRenderer({
      filePath: "photo.png",
      fileName: "photo.png",
    });
    renderer.mount(container);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img.src).toContain("/api/files/raw?path=");
    renderer.destroy();
  });

  test("Text renderer getValue returns content", () => {
    const renderer = createFileRenderer({
      filePath: "main.js",
      content: "const x = 1;\n",
    });
    renderer.mount(container);
    expect(renderer.getValue()).toBe("const x = 1;\n");
    renderer.destroy();
  });

  test("Text renderer update toggles readOnly", () => {
    const renderer = createFileRenderer({
      filePath: "main.js",
      content: "test\n",
      readOnly: true,
    });
    renderer.mount(container);
    renderer.update({ readOnly: false });
    // Should not throw.
    renderer.destroy();
  });

  test("Text renderer update toggles wrapLines", () => {
    const renderer = createFileRenderer({
      filePath: "main.js",
      content: "test\n",
      wrapLines: false,
    });
    renderer.mount(container);
    renderer.update({ wrapLines: true });
    renderer.destroy();
  });

  test("R script → text renderer (plain text fallback)", () => {
    const renderer = createFileRenderer({
      filePath: "analysis.R",
      content: "x <- 1\n",
    });
    renderer.mount(container);
    expect(renderer.contentType).toBe("text");
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    renderer.destroy();
  });

  test("Unknown text → text renderer", () => {
    const renderer = createFileRenderer({
      filePath: "data.xyz",
      content: "some content\n",
    });
    renderer.mount(container);
    expect(renderer.contentType).toBe("text");
    renderer.destroy();
  });

  test("destroy cleans up DOM", () => {
    const renderer = createFileRenderer({
      filePath: "main.js",
      content: "test\n",
    });
    renderer.mount(container);
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    renderer.destroy();
    expect(container.querySelector(".cm-editor")).toBeNull();
  });
});
