// ABOUTME: Verifies platform-specific OS opener command selection for file and workspace actions.
// ABOUTME: Keeps shell quoting out of the production path by asserting argument-vector output.
import { describe, expect, it } from "vitest";
import { getOpenCommand, resolveHomePath } from "./open-path";

describe("getOpenCommand", () => {
  it.each([
    ["darwin", "open"],
    ["win32", "explorer.exe"],
    ["linux", "xdg-open"],
    ["freebsd", "xdg-open"],
  ])("selects %s opener", (platform, command) => {
    expect(getOpenCommand(platform, "C:/workspace/file.txt")).toEqual({
      command,
      args: ["C:/workspace/file.txt"],
    });
  });

  it("expands tilde paths using the supplied home directory", () => {
    expect(resolveHomePath("~/workspace", "C:/Users/Lin")).toBe("C:/Users/Lin/workspace");
    expect(resolveHomePath("~", "C:/Users/Lin")).toBe("C:/Users/Lin");
    expect(resolveHomePath("/tmp/workspace", "C:/Users/Lin")).toBe("/tmp/workspace");
  });
});
