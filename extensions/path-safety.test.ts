// ABOUTME: Verifies filesystem containment checks used by static and workspace file serving.
// ABOUTME: Covers traversal and sibling-prefix escapes without depending on a real filesystem.
import { expect, test } from "vitest";
import { isPathWithinRoot } from "./path-safety";

test("accepts a path inside the root and the root itself", () => {
  expect(isPathWithinRoot("/app/public", "/app/public")).toBe(true);
  expect(isPathWithinRoot("/app/public", "/app/public/index.html")).toBe(true);
});

test("rejects traversal and sibling-prefix paths", () => {
  expect(isPathWithinRoot("/app/public", "/app/public/../secret")).toBe(false);
  expect(isPathWithinRoot("/app/public", "/app/public-assets/index.html")).toBe(false);
});

test("handles Windows drive paths case-insensitively", () => {
  expect(isPathWithinRoot("C:\\Users\\Lin\\Public", "c:/users/lin/public/index.html")).toBe(true);
  expect(isPathWithinRoot("C:\\Users\\Lin\\Public", "C:/Users/Lin/Public-assets/index.html")).toBe(
    false,
  );
  expect(isPathWithinRoot("C:\\Users\\Lin\\Public", "D:/Users/Lin/Public/index.html")).toBe(false);
});

test("handles UNC paths with a share boundary", () => {
  expect(isPathWithinRoot("\\\\server\\share\\public", "//SERVER/share/public/index.html")).toBe(
    true,
  );
  expect(
    isPathWithinRoot("\\\\server\\share\\public", "//server/share/public-assets/index.html"),
  ).toBe(false);
});
