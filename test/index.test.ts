import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("OpenCode HeadsDown plugin source", () => {
  it("includes cold-start Wrap-Up instruction mapping", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");

    expect(source).toContain("Execution policy for this task");
    expect(source).toContain("buildWrapUpInstruction");
    expect(source).toContain("wrapUpInstruction");
  });

  it("passes delivery_mode through to SDK proposal input", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");

    expect(source).toContain("delivery_mode");
    expect(source).toContain("deliveryMode: args.delivery_mode");
  });
});
