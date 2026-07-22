// ABOUTME: Verifies cross-platform local filesystem path normalization for browser consumers.
// ABOUTME: Covers POSIX, Windows drive, UNC, basename, and parent-path behavior.
import { expect, test } from "vitest";
import { basenameLocalPath, normalizeLocalPath, parentLocalPath } from "./path-utils.js";

test("normalizes Windows separators while preserving a drive root", () => {
  expect(normalizeLocalPath("C:\\Users\\Lin\\repo\\..\\picot\\")).toBe("C:/Users/Lin/picot");
  expect(parentLocalPath("C:\\Users\\Lin\\picot")).toBe("C:/Users/Lin");
  expect(basenameLocalPath("C:\\Users\\Lin\\picot\\README.md")).toBe("README.md");
});

test("normalizes UNC paths without losing the share root", () => {
  expect(normalizeLocalPath("\\\\server\\share\\repo\\src\\..\\")).toBe("//server/share/repo");
  expect(parentLocalPath("\\\\server\\share\\repo")).toBe("//server/share");
  expect(basenameLocalPath("\\\\server\\share\\repo\\file.ts")).toBe("file.ts");
});

test("keeps POSIX root semantics", () => {
  expect(normalizeLocalPath("/Users//Lin/../repo/")).toBe("/Users/repo");
  expect(parentLocalPath("/")).toBe("/");
  expect(basenameLocalPath("/Users/Lin/file.ts")).toBe("file.ts");
});
