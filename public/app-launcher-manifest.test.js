import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicDir = join(process.cwd(), "public");

describe("app launcher manifest", () => {
  it("installs from the canonical /app entry", () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.json"), "utf8"));
    const index = readFileSync(join(publicDir, "index.html"), "utf8");

    expect(manifest.start_url).toBe("/app");
    expect(manifest.scope).toBe("/app");
    expect(index).toContain('<link rel="manifest" href="/manifest.json" />');
  });
});
