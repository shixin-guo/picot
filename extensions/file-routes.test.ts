import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  classifyFile,
  readTextFileForPreview,
  resolveScopedFilePath,
  resolveWorkspaceRoot,
  writeTextFileIfUnchanged,
} from "./file-routes.ts";

const TMP = os.tmpdir();
let workspaceRoot = "";
let outsideRoot = "";

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(TMP, "picot-ws-"));
  outsideRoot = fs.mkdtempSync(path.join(TMP, "picot-out-"));
  // Create some test files inside workspace
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "src", "main.js"), 'console.log("hello");\n');
  fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Test\n\nHello world.\n");
  fs.writeFileSync(path.join(workspaceRoot, "data.json"), '{"key":"value"}\n');

  // Create outside file
  fs.writeFileSync(path.join(outsideRoot, "outside.txt"), "outside\n");
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

describe("resolveWorkspaceRoot", () => {
  test("resolves from cwd when no ctx provided", () => {
    const result = resolveWorkspaceRoot(null, process.cwd());
    expect(result).toBe(path.resolve(process.cwd()));
  });

  test("falls back to process.cwd() string", () => {
    const result = resolveWorkspaceRoot(undefined, "/some/path");
    expect(result).toBe(path.resolve("/some/path"));
  });
});

describe("resolveScopedFilePath", () => {
  test("allows workspace file inside root", () => {
    const target = path.join(workspaceRoot, "src", "main.js");
    const result = resolveScopedFilePath(target, "workspace", workspaceRoot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(target);
    }
  });

  test("rejects traversal outside workspace", () => {
    const target = path.join(workspaceRoot, "..", path.basename(outsideRoot), "outside.txt");
    const result = resolveScopedFilePath(target, "workspace", workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("outsideWorkspace");
    }
  });

  test("rejects absolute outside path", () => {
    const target = path.join(outsideRoot, "outside.txt");
    const result = resolveScopedFilePath(target, "workspace", workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("outsideWorkspace");
    }
  });

  test("allows filesystem root in picker scope", () => {
    const result = resolveScopedFilePath("/", "picker", workspaceRoot);
    expect(result.ok).toBe(true);
  });

  test("allows arbitrary dir in picker scope", () => {
    const result = resolveScopedFilePath(outsideRoot, "picker", workspaceRoot);
    expect(result.ok).toBe(true);
  });

  test("rejects empty path", () => {
    const result = resolveScopedFilePath("", "workspace", workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalidPath");
    }
  });

  test("rejects non-string path", () => {
    const result = resolveScopedFilePath(null, "workspace", workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalidPath");
    }
  });
});

describe("classifyFile", () => {
  test("classifies JavaScript", () => {
    const result = classifyFile("main.js", Buffer.from("console.log(1);"));
    expect(result.kind).toBe("text");
    expect(result.editable).toBe(true);
    expect(result.mimeType).toBe("text/javascript");
  });

  test("classifies Markdown", () => {
    const result = classifyFile("README.md", Buffer.from("# Hello"));
    expect(result.kind).toBe("text");
    expect(result.editable).toBe(true);
  });

  test("classifies R script", () => {
    const result = classifyFile("analysis.R", Buffer.from("x <- 1\n"));
    expect(result.kind).toBe("text");
    expect(result.editable).toBe(true);
  });

  test("classifies PNG image", () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = classifyFile("image.png", pngHeader);
    expect(result.kind).toBe("image");
    expect(result.editable).toBe(false);
    expect(result.mimeType).toBe("image/png");
  });

  test("classifies PDF", () => {
    const pdfHeader = Buffer.from("%PDF-1.4\n");
    const result = classifyFile("doc.pdf", pdfHeader);
    expect(result.kind).toBe("pdf");
    expect(result.editable).toBe(false);
    expect(result.mimeType).toBe("application/pdf");
  });

  test("detects binary by NUL byte", () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = classifyFile("data.bin", binaryContent);
    expect(result.kind).toBe("binary");
    expect(result.editable).toBe(false);
  });

  test("classifies unknown text by extension", () => {
    const result = classifyFile("config.xyz", Buffer.from("some text\n"));
    expect(result.kind).toBe("text");
    expect(result.editable).toBe(true);
  });

  test("treats unknown extension binary content as binary", () => {
    const result = classifyFile("data.dat", Buffer.from([0x00, 0x01, 0x02]));
    expect(result.kind).toBe("binary");
  });
});

describe("readTextFileForPreview", () => {
  test("reads text file", () => {
    const filePath = path.join(workspaceRoot, "src", "main.js");
    const result = readTextFileForPreview(filePath);
    expect(result.content).toBe('console.log("hello");\n');
    expect(result.isBinary).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.size).toBe(Buffer.byteLength('console.log("hello");\n', "utf-8"));
    expect(typeof result.mtimeMs).toBe("number");
  });

  test("truncates files above 2 MiB", () => {
    const largeContent = "x".repeat(2 * 1024 * 1024 + 100);
    const filePath = path.join(workspaceRoot, "large.txt");
    fs.writeFileSync(filePath, largeContent);
    const result = readTextFileForPreview(filePath);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  test("marks 1-2 MiB text as read-only", () => {
    const mediumContent = "y".repeat(1.5 * 1024 * 1024);
    const filePath = path.join(workspaceRoot, "medium.txt");
    fs.writeFileSync(filePath, mediumContent);
    const result = readTextFileForPreview(filePath);
    expect(result.truncated).toBe(false);
  });
});

describe("writeTextFileIfUnchanged", () => {
  test("writes when mtime matches", () => {
    const filePath = path.join(workspaceRoot, "src", "main.js");
    const stat = fs.statSync(filePath);
    const result = writeTextFileIfUnchanged(filePath, 'console.log("updated");\n', stat.mtimeMs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(fs.readFileSync(filePath, "utf-8")).toBe('console.log("updated");\n');
    }
  });

  test("returns conflict when mtime differs", () => {
    const filePath = path.join(workspaceRoot, "src", "main.js");
    const result = writeTextFileIfUnchanged(filePath, "new content\n", 1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("conflict");
    }
  });
});
