import { describe, expect, test } from "vitest";
import { classifyFilePath, languageExtensionForPath } from "./file-language.js";

describe("classifyFilePath", () => {
  test("classifies markdown files", () => {
    expect(classifyFilePath("README.md").contentType).toBe("markdown");
    expect(classifyFilePath("guide.markdown").contentType).toBe("markdown");
    expect(classifyFilePath("notes.mdown").contentType).toBe("markdown");
    expect(classifyFilePath("docs.mkd").contentType).toBe("markdown");
  });

  test("classifies markdown as editable", () => {
    expect(classifyFilePath("README.md").editable).toBe(true);
  });

  test("classifies JavaScript", () => {
    const result = classifyFilePath("main.js");
    expect(result.contentType).toBe("text");
    expect(result.editable).toBe(true);
    expect(result.languageId).toBe("javascript");
  });

  test("classifies TypeScript", () => {
    expect(classifyFilePath("app.ts").languageId).toBe("typescript");
    expect(classifyFilePath("component.tsx").languageId).toBe("tsx");
  });

  test("classifies JSON", () => {
    const result = classifyFilePath("data.json");
    expect(result.contentType).toBe("text");
    expect(result.languageId).toBe("json");
  });

  test("classifies YAML", () => {
    expect(classifyFilePath("config.yaml").languageId).toBe("yaml");
    expect(classifyFilePath("config.yml").languageId).toBe("yaml");
  });

  test("classifies Python", () => {
    expect(classifyFilePath("script.py").languageId).toBe("python");
  });

  test("classifies R scripts as editable text", () => {
    const result = classifyFilePath("analysis.R");
    expect(result.contentType).toBe("text");
    expect(result.editable).toBe(true);
    expect(result.languageId).toBe("r");
  });

  test("classifies lowercase .r as editable text", () => {
    const result = classifyFilePath("analysis.r");
    expect(result.contentType).toBe("text");
    expect(result.editable).toBe(true);
    expect(result.languageId).toBe("r");
  });

  test("classifies shell scripts", () => {
    expect(classifyFilePath("deploy.sh").languageId).toBe("shell");
    expect(classifyFilePath("setup.bash").languageId).toBe("shell");
  });

  test("classifies images", () => {
    expect(classifyFilePath("photo.png").contentType).toBe("image");
    expect(classifyFilePath("photo.jpg").contentType).toBe("image");
    expect(classifyFilePath("photo.jpeg").contentType).toBe("image");
    expect(classifyFilePath("anim.gif").contentType).toBe("image");
    expect(classifyFilePath("icon.svg").contentType).toBe("image");
    expect(classifyFilePath("favicon.ico").contentType).toBe("image");
    expect(classifyFilePath("photo.webp").contentType).toBe("image");
  });

  test("classifies images as non-editable", () => {
    expect(classifyFilePath("photo.png").editable).toBe(false);
  });

  test("classifies PDF", () => {
    const result = classifyFilePath("document.pdf");
    expect(result.contentType).toBe("pdf");
    expect(result.editable).toBe(false);
  });

  test("classifies unknown text as editable with null language", () => {
    const result = classifyFilePath("data.xyz");
    expect(result.contentType).toBe("text");
    expect(result.editable).toBe(true);
    expect(result.languageId).toBeNull();
  });

  test("handles files with no extension", () => {
    const result = classifyFilePath("Makefile");
    expect(result.contentType).toBe("text");
    expect(result.languageId).toBeNull();
  });

  test("handles dotfiles", () => {
    const result = classifyFilePath(".env");
    expect(result.contentType).toBe("text");
    expect(result.languageId).toBeNull();
  });
});

describe("languageExtensionForPath", () => {
  test("returns extension for JavaScript", () => {
    expect(languageExtensionForPath("main.js")).not.toBeNull();
  });

  test("returns extension for TypeScript", () => {
    expect(languageExtensionForPath("app.ts")).not.toBeNull();
  });

  test("handles dotfiles", () => {
    const result = classifyFilePath(".env");
    // .env is a dotfile — getExtension returns "" for dotfiles,
    // so it classifies as plain text with no language mode.
    expect(result.contentType).toBe("text");
    expect(result.languageId).toBeNull();
  });

  test("returns extension for Python", () => {
    expect(languageExtensionForPath("script.py")).not.toBeNull();
  });

  test("returns extension for Markdown", () => {
    expect(languageExtensionForPath("README.md")).not.toBeNull();
  });

  test("returns extension for CSS", () => {
    expect(languageExtensionForPath("styles.css")).not.toBeNull();
  });

  test("returns extension for HTML", () => {
    expect(languageExtensionForPath("index.html")).not.toBeNull();
  });

  test("returns extension for Shell", () => {
    expect(languageExtensionForPath("deploy.sh")).not.toBeNull();
  });

  test("returns an extension for R", () => {
    expect(languageExtensionForPath("analysis.R")).not.toBeNull();
    expect(languageExtensionForPath("analysis.r")).not.toBeNull();
  });

  test("returns null for unknown extensions", () => {
    expect(languageExtensionForPath("data.xyz")).toBeNull();
  });
});
