// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildProjectSearchMatch, projectSearchText } from "./session-search.ts";

describe("session search project matching", () => {
  it("matches project name from a workspace path", () => {
    expect(projectSearchText("/Users/me/work/alpha-dashboard")).toContain("alpha-dashboard");
    expect(buildProjectSearchMatch("alpha-dashboard", "/Users/me/work/alpha-dashboard")).toEqual({
      role: "project",
      snippet: "Project: alpha-dashboard",
    });
  });

  it("does not match unrelated project names", () => {
    expect(buildProjectSearchMatch("billing", "/Users/me/work/alpha-dashboard")).toBeNull();
  });
});
