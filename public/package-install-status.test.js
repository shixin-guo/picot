import { beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { renderPackageInstallFailure, summarizePackageError } from "./package-install-status.js";

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          extensions: {
            permissionDenied: "Permission denied in ~/.pi/agent/npm (check owner/permissions).",
            installFailed: "Install failed",
            uninstallFailed: "Uninstall failed",
            installFailedNote:
              "This extension requires npm. Make sure npm is installed and available to Picot, then try again.",
            uninstallFailedNote:
              "Picot could not remove this extension package. Check the error details, then try again.",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

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
