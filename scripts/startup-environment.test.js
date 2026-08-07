import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Picot startup environment", () => {
  test("imports the complete login-shell environment", () => {
    const source = readFileSync("src-tauri/src/main.rs", "utf8");
    expect(source).toContain("fix_path_env::fix()");
  });
});
