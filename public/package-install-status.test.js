import { describe, expect, test } from "vitest";
import { renderPackageInstallFailure, summarizePackageError } from "./package-install-status.js";

describe("package install failure status", () => {
  test("renders npm dependency guidance and the real error visibly", () => {
    const status = document.createElement("div");
    const error = new Error("spawn npm ENOENT\nnpm executable was not found");

    renderPackageInstallFailure(status, error);

    expect(status.hidden).toBe(false);
    expect(status.classList.contains("is-error")).toBe(true);
    expect(status.textContent).toContain("Install failed");
    expect(status.textContent).toContain("This extension requires npm");
    expect(status.textContent).toContain("spawn npm ENOENT");
    expect(status.textContent).toContain("npm executable was not found");
  });

  test("labels uninstall failures as uninstall failures", () => {
    const status = document.createElement("div");
    const error = new Error("remove failed");

    renderPackageInstallFailure(status, error, "uninstall");

    expect(status.textContent).toContain("Uninstall failed");
    expect(status.textContent).not.toContain("Install failed");
    expect(status.textContent).not.toContain("This extension requires npm");
    expect(status.textContent).toContain("remove failed");
  });

  test("keeps permission errors actionable", () => {
    expect(summarizePackageError("EACCES: permission denied, open ~/.pi/agent/npm")).toBe(
      "Permission denied in ~/.pi/agent/npm (check owner/permissions).",
    );
  });

  test("does not truncate unknown install errors", () => {
    const longError = `install failed: ${"npm output ".repeat(40)}`;

    expect(summarizePackageError(longError)).toBe(longError);
  });
});
