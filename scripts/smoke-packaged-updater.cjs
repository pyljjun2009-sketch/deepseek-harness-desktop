const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function waitForUrl(child, timeoutMs) {
  return await new Promise((resolve, reject) => {
    let combined = "";
    const buffers = { stdout: "", stderr: "" };
    const timer = setTimeout(() => reject(new Error(`web startup timed out: ${combined}`)), timeoutMs);
    const consume = (stream, chunk) => {
      buffers[stream] += String(chunk);
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) {
        combined += `${line}\n`;
        const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/\?\S+)?)(?=\s|$)/i.exec(line);
        if (match) {
          clearTimeout(timer);
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

async function main() {
  const appRoot = path.resolve(process.argv[2]);
  const version = process.argv[3] ?? "0.1.5-rc.2";
  const { RuntimeManager } = require(path.join(appRoot, "dist-electron", "electron", "runtime-manager.js"));
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-update-"));
  let child;
  try {
    const manager = new RuntimeManager(testRoot, (scope, message) => {
      if (/error|warn/i.test(message)) process.stderr.write(`[${scope}] ${message}\n`);
    });
    await manager.initialize();
    const candidate = await manager.installCandidate(version);
    child = spawn(process.execPath, [candidate.binPath, "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
      env: { ...manager.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const url = await waitForUrl(child, 45_000);
    const bareResponse = await fetch(new URL(url).origin + "/", { redirect: "manual" });
    if (bareResponse.status < 200 || (bareResponse.status >= 400 && bareResponse.status !== 401)) {
      throw new Error(`Bare-origin HTTP probe returned ${bareResponse.status}`);
    }
    const response = await fetch(url, { redirect: "manual" });
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`HTTP probe returned ${response.status}`);
    }
    process.stdout.write(JSON.stringify({ version: candidate.version, origin: new URL(url).origin, bareStatus: bareResponse.status, tokenStatus: response.status }) + "\n");
  } finally {
    if (child) await terminate(child);
    await rm(testRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
