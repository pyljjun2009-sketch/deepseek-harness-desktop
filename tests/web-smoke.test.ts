import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { smokeWebRuntime } from "../electron/web-smoke";

it("rejects a runtime that passes CLI checks but cannot boot Web", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-web-smoke-test-"));
  try {
    const binPath = path.join(root, "broken.cjs");
    await writeFile(binPath, 'console.error("MISSING_DEPENDENCY"); process.exit(1);', "utf8");
    await expect(smokeWebRuntime(process.execPath, binPath, root, [], () => {}, 2_000))
      .rejects.toThrow(/MISSING_DEPENDENCY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
