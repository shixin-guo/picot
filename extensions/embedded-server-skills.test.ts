import { describe, expect, test } from "vitest";
import { normalizeSkillCommands } from "./embedded-server.ts";

describe("normalizeSkillCommands", () => {
  test("returns only invokable skills with canonical scope metadata", () => {
    expect(
      normalizeSkillCommands([
        {
          name: "skill:release-notes",
          description: "  Cut a release  ",
          source: "skill",
          sourceInfo: { scope: "project" },
        },
        {
          name: "skill:research",
          source: "skill",
          sourceInfo: { scope: "user" },
        },
        { name: "compact", source: "extension" },
      ]),
    ).toEqual([
      {
        command: "/skill:release-notes",
        name: "release-notes",
        description: "Cut a release",
        scope: "project",
      },
      {
        command: "/skill:research",
        name: "research",
        description: "",
        scope: "personal",
      },
    ]);
  });
});
