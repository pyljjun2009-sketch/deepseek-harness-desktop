const { spawn } = require("node:child_process");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function waitForUrl(child, timeoutMs, stage, expectedMarker) {
  return await new Promise((resolve, reject) => {
    let combined = "";
    const buffers = { stdout: "", stderr: "" };
    const timer = setTimeout(() => reject(new Error(`${stage} web startup timed out (pid ${child.pid}): ${combined}${buffers.stdout}${buffers.stderr}`)), timeoutMs);
    const consume = (stream, chunk) => {
      buffers[stream] += String(chunk);
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) {
        combined += `${line}\n`;
        const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/\?\S+)?)(?=\s|$)/i.exec(line);
        if (match) {
          clearTimeout(timer);
          if (expectedMarker && !combined.includes(expectedMarker)) {
            reject(new Error(`${stage} became available without registering ${expectedMarker}: ${combined}`));
            return;
          }
          resolve(match[1]);
          return;
        }
      }
    };
    child.stdout.on("data", (chunk) => consume("stdout", chunk));
    child.stderr.on("data", (chunk) => consume("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`web process exited early with ${code}: ${combined}`));
    });
  });
}

async function terminate(child) {
  if (!child.pid) return;
  child.kill();
  if (process.platform !== "win32") return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.once("exit", resolve);
    killer.once("error", resolve);
  });
}

function assertBrowsePickerConfig(config) {
  const marker = "- id: directory-picker";
  const start = config.indexOf(marker);
  const next = config.indexOf("\n- id:", start + marker.length);
  const autoRow = start < 0 ? "" : config.slice(start, next < 0 ? undefined : next);
  if (!/\bdisabled: true\b/.test(autoRow) ||
      !config.includes("name: '@deepseek-ai/dsh-host-directory-picker-browse'") ||
      !config.includes("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'")) {
    throw new Error("Packaged runtime did not compose the safe in-app directory picker");
  }
}

async function main() {
  const appRoot = path.resolve(process.argv[2]);
  const version = process.argv[3] ?? "bundled";
  const { RuntimeManager } = require(path.join(appRoot, "dist-electron", "electron", "runtime-manager.js"));
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-update-"));
  let child;
  try {
    const manager = new RuntimeManager(testRoot, (scope, message) => {
      if (/error|warn/i.test(message)) process.stderr.write(`[${scope}] ${message}\n`);
    });
    await manager.initialize();
    await new Promise((resolve, reject) => {
      let config = "";
      let errors = "";
      const setup = spawn(process.execPath, [
        manager.getActive().binPath,
        "--profile", "web",
        ...manager.getWebPatchArguments(),
        "--dump-config"
      ], {
        env: { ...manager.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      setup.stdout.on("data", (chunk) => { config += String(chunk); });
      setup.stderr.on("data", (chunk) => { errors += String(chunk); });
      setup.once("error", reject);
      setup.once("exit", (code) => {
        if (code !== 0) return reject(new Error(`Bundled profile setup exited ${code}: ${errors}`));
        try { assertBrowsePickerConfig(config); resolve(); } catch (error) { reject(error); }
      });
    });
    const pluginHome = path.join(testRoot, "sub2api-plugin-smoke");
    await mkdir(pluginHome, { recursive: true });
    child = spawn(process.execPath, [manager.getActive().binPath, "web", ...manager.getWebPatchArguments(true), "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      env: { ...manager.getHarnessEnvironment(pluginHome), ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const pluginUrl = await waitForUrl(child, 45_000, "Sub2API plugin", '[sub2api-personal] registered "sub2api_personal" — listed=true');
    const pluginResponse = await fetch(pluginUrl, { redirect: "manual" });
    if (pluginResponse.status < 200 || pluginResponse.status >= 400) {
      throw new Error(`Packaged Sub2API plugin returned HTTP ${pluginResponse.status}`);
    }
    const { executeSub2Api } = await import(pathToFileURL(path.join(appRoot, "vendor", "dsh-sub2api-personal", "dist", "core.js")).href);
    const previousAllowlist = process.env.SUB2API_PERSONAL_ALLOWED_PROFILES;
    try {
      process.env.SUB2API_PERSONAL_ALLOWED_PROFILES = "personal";
      const blocked = await executeSub2Api({ action: "test_profile", profileName: "blocked" });
      if (blocked.ok || blocked.exitCode !== 2 || !blocked.error.includes("not allowed")) {
        throw new Error("Packaged Sub2API tool did not enforce the account allowlist");
      }
    } finally {
      if (previousAllowlist === undefined) delete process.env.SUB2API_PERSONAL_ALLOWED_PROFILES;
      else process.env.SUB2API_PERSONAL_ALLOWED_PROFILES = previousAllowlist;
    }
    await terminate(child);
    child = undefined;
    await writeFile(path.join(manager.harnessHome, "smoke-session.txt"), "stable");
    const brokenBin = path.join(testRoot, "runtimes", "0.2.0", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    await mkdir(path.dirname(brokenBin), { recursive: true });
    await writeFile(brokenBin, `
if (process.argv.includes("--version")) { console.log("0.2.0"); process.exit(0); }
if (process.argv.includes("--dump-config")) process.exit(0);
console.error("PACKAGED_BROKEN_WEB"); process.exit(1);
`, "utf8");
    let rejected = false;
    try {
      await manager.installCandidate("0.2.0");
    } catch (error) {
      rejected = /PACKAGED_BROKEN_WEB/.test(String(error));
    }
    if (!rejected || manager.getState().activeHomeId !== "default" || manager.getActive().source !== "bundled") {
      throw new Error("Broken candidate was not rejected before profile activation");
    }
    const candidate = version === "bundled"
      ? { source: "managed", version: manager.bundled.version, binPath: manager.bundled.binPath }
      : await manager.installCandidate(version);
    await manager.activateCandidate(candidate);
    const candidateHome = manager.getHarnessEnvironment().DSH_HOME;
    if (candidateHome === manager.harnessHome || await readFile(path.join(candidateHome, "smoke-session.txt"), "utf8") !== "stable") {
      throw new Error("Candidate profile was not isolated and cloned");
    }
    await writeFile(path.join(candidateHome, "smoke-session.txt"), "candidate");
    if (await readFile(path.join(manager.harnessHome, "smoke-session.txt"), "utf8") !== "stable") {
      throw new Error("Candidate changed stable profile data");
    }
    child = spawn(process.execPath, [candidate.binPath, "web", ...manager.getWebPatchArguments(), "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      env: { ...manager.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const url = await waitForUrl(child, 45_000, "candidate");
    const bareResponse = await fetch(new URL(url).origin + "/", { redirect: "manual" });
    if (bareResponse.status < 200 || (bareResponse.status >= 400 && bareResponse.status !== 401)) {
      throw new Error(`Bare-origin HTTP probe returned ${bareResponse.status}`);
    }
    const response = await fetch(url, { redirect: "manual" });
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`HTTP probe returned ${response.status}`);
    }
    await terminate(child);
    child = undefined;
    if (await manager.recordFailure() !== "retry" || await manager.recordFailure() !== "rollback") {
      throw new Error("Candidate did not roll back after failed probation");
    }
    if (manager.getHarnessEnvironment().DSH_HOME !== manager.harnessHome ||
        await readFile(path.join(candidateHome, "smoke-session.txt"), "utf8") !== "candidate") {
      throw new Error("Rollback did not restore stable profile and preserve candidate data");
    }
    child = spawn(process.execPath, [manager.getActive().binPath, "web", ...manager.getWebPatchArguments(), "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      env: { ...manager.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const restoredUrl = await waitForUrl(child, 45_000, "restored stable");
    const restoredResponse = await fetch(restoredUrl, { redirect: "manual" });
    if (restoredResponse.status < 200 || restoredResponse.status >= 400) {
      throw new Error(`Restored stable runtime returned HTTP ${restoredResponse.status}`);
    }
    process.stdout.write(JSON.stringify({ version: candidate.version, origin: new URL(url).origin, bareStatus: bareResponse.status, tokenStatus: response.status, browsePicker: true, sub2apiPluginLoaded: true, sub2apiAllowlist: true, brokenCandidateRejected: true, profileIsolation: true, rollback: true, restoredStatus: restoredResponse.status }) + "\n");
  } finally {
    if (child) await terminate(child);
    await rm(testRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
