import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeManager } from "../electron/runtime-manager";
import type { RuntimeRef } from "../shared/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-runtime-test-"));
  roots.push(root);
  const binPath = path.join(root, "fake-dsh.cjs");
  await writeFile(binPath, `
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) { console.log("0.2.0"); process.exit(0); }
if (process.argv.includes("--dump-config")) {
  fs.writeFileSync(path.join(process.env.DSH_HOME, "cli-marker.txt"), "candidate checked");
  process.exit(0);
}
if (process.argv.includes("web")) {
  const server = require("node:http").createServer((_request, response) => {
    response.statusCode = 401;
    response.end();
  });
  server.listen(0, "127.0.0.1", () => console.log("dsh web: http://127.0.0.1:" + server.address().port));
  return;
}
process.exit(1);
`, "utf8");
  const bundled: RuntimeRef = { source: "bundled", version: "0.1.1", binPath };
  const managed: RuntimeRef = { source: "managed", version: "0.2.0", binPath };
  const manager = new RuntimeManager(root, () => {}, bundled);
  await manager.initialize();
  return { root, manager, bundled, managed };
}

describe("runtime profile isolation", () => {
  it("keeps the safe directory browser active when token saving is disabled", async () => {
    const { manager } = await fixture();
    expect(manager.getWebPatchArguments()).toEqual([
      "--patch", manager.desktopCompatPatchPath,
      "--patch", manager.optimizationPatchPath
    ]);
    await manager.setTokenSaving(false);
    expect(manager.getWebPatchArguments()).toEqual(["--patch", manager.desktopCompatPatchPath]);
  });

  it("activates a cloned home and rolls runtime and home back together", async () => {
    const { manager, managed } = await fixture();
    await writeFile(path.join(manager.harnessHome, "session.txt"), "stable session", "utf8");
    await manager.activateCandidate(managed);
    const candidateHome = manager.getHarnessEnvironment().DSH_HOME!;
    expect(candidateHome).not.toBe(manager.harnessHome);
    expect(await readFile(path.join(candidateHome, "session.txt"), "utf8")).toBe("stable session");
    expect(await readFile(path.join(candidateHome, "cli-marker.txt"), "utf8")).toBe("candidate checked");
    await writeFile(path.join(candidateHome, "session.txt"), "candidate session", "utf8");
    expect(await readFile(path.join(manager.harnessHome, "session.txt"), "utf8")).toBe("stable session");
    expect(await manager.recordFailure()).toBe("retry");
    expect(await manager.recordFailure()).toBe("rollback");
    expect(manager.getState().activeHomeId).toBe("default");
    expect(manager.getHarnessEnvironment().DSH_HOME).toBe(manager.harnessHome);
    expect(await readFile(path.join(candidateHome, "session.txt"), "utf8")).toBe("candidate session");
  });

  it("migrates persisted version-one state on startup", async () => {
    const { root, manager, bundled } = await fixture();
    const legacy = {
      schemaVersion: 1,
      channel: "stable",
      active: bundled,
      lastKnownGood: bundled,
      crashTimestamps: [],
      rollbackCount: 0,
      tokenSavingEnabled: true,
      updatedAt: new Date().toISOString()
    };
    const recoveryRoot = path.join(root, "recovery");
    await mkdir(recoveryRoot, { recursive: true });
    await writeFile(path.join(recoveryRoot, "state.json"), JSON.stringify(legacy), "utf8");
    const reloaded = new RuntimeManager(root, () => {}, bundled);
    await reloaded.initialize();
    expect(reloaded.getState().schemaVersion).toBe(2);
    expect(reloaded.getState().activeHomeId).toBe("default");
    expect(manager.getState().schemaVersion).toBe(2);
  });

  it("repairs a missing last-known-good data slot before a candidate can fail", async () => {
    const { root, manager, bundled, managed } = await fixture();
    await manager.activateCandidate(managed);
    const state = { ...manager.getState(), lastKnownGoodHomeId: "slot-missing" };
    await writeFile(path.join(root, "recovery", "state.json"), JSON.stringify(state), "utf8");
    const reloaded = new RuntimeManager(root, () => {}, bundled);
    await reloaded.initialize();
    expect(reloaded.getState().activeHomeId).toBe(state.activeHomeId);
    expect(reloaded.getState().lastKnownGoodHomeId).toBe("default");
  });

  it("does not copy DSH-generated dependency projections into a new home", async () => {
    const { manager, managed } = await fixture();
    const generated = path.join(manager.harnessHome, "profiles", "node_modules");
    await mkdir(generated, { recursive: true });
    await writeFile(path.join(generated, "stale-link.txt"), "old runtime", "utf8");
    await manager.activateCandidate(managed);
    const candidateHome = manager.getHarnessEnvironment().DSH_HOME!;
    expect(existsSync(path.join(candidateHome, "profiles", "node_modules", "stale-link.txt"))).toBe(false);
    expect(existsSync(path.join(generated, "stale-link.txt"))).toBe(true);
  });

  it("rejects a cached candidate with a broken Web before switching the active slot", async () => {
    const { root, manager, bundled } = await fixture();
    const candidateBin = path.join(root, "runtimes", "0.2.0", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    await mkdir(path.dirname(candidateBin), { recursive: true });
    await writeFile(candidateBin, `
if (process.argv.includes("--version")) { console.log("0.2.0"); process.exit(0); }
if (process.argv.includes("--dump-config")) process.exit(0);
console.error("BROKEN_WEB_DEPENDENCY");
process.exit(1);
`, "utf8");
    await expect(manager.installCandidate("0.2.0")).rejects.toThrow(/BROKEN_WEB_DEPENDENCY/);
    expect(manager.getActive()).toEqual(bundled);
    expect(manager.getState().activeHomeId).toBe("default");
    expect(manager.getState().candidate).toBeUndefined();
  });
});
