const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const rounds = Number(process.env.DSH_STRESS_ROUNDS ?? 8);
const concurrency = Number(process.env.DSH_STRESS_CONCURRENCY ?? 50);
const supervisorRounds = Number(process.env.DSH_SUPERVISOR_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20 ||
    !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200 ||
    !Number.isInteger(supervisorRounds) || supervisorRounds < 0 || supervisorRounds > 10) {
  throw new Error("Invalid stress settings: rounds 1-20, concurrency 1-200, supervisor rounds 0-10");
}

async function terminate(child) {
  if (!child?.pid) return;
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

async function startWeb(manager) {
  const args = [manager.getActive().binPath, "web", ...manager.getWebPatchArguments(),
    "--host", "127.0.0.1", "--port", "0", "--no-open"];
  const child = spawn(process.execPath, args, {
    env: { ...manager.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = "";
      let lineBuffer = "";
      const timer = setTimeout(() => reject(new Error(`Web startup timed out: ${output}`)), 45_000);
      child.stdout.on("data", (chunk) => {
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          output = (output + line + "\n").slice(-8000);
          const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/\?\S+)?)(?=\s|$)/i.exec(line);
          if (match) {
            clearTimeout(timer);
          resolve(match[1]);
            return;
          }
        }
        if (lineBuffer.length > 4096) lineBuffer = lineBuffer.slice(-4096);
      });
      child.stderr.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-8000); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Web exited ${code}: ${output}`)); });
    });
    return { child, origin: new URL(url).origin };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}

async function probeBurst(origin, count) {
  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: count }, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual", signal: controller.signal });
      if (response.status < 200 || (response.status >= 400 && response.status !== 401)) {
        throw new Error(`Unexpected HTTP ${response.status}`);
      }
      await response.arrayBuffer();
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  }));
  return { requests: responses.length, elapsedMs: Date.now() - started };
}

async function waitForStatus(supervisor, status, timeoutMs) {
  if (supervisor.snapshot().status === status) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      supervisor.off("snapshot", onSnapshot);
      reject(new Error(`Supervisor did not reach ${status}; actual=${supervisor.snapshot().status}`));
    }, timeoutMs);
    const onSnapshot = (snapshot) => {
      if (snapshot.status !== status) return;
      clearTimeout(timer);
      supervisor.off("snapshot", onSnapshot);
      resolve();
    };
    supervisor.on("snapshot", onSnapshot);
  });
}

async function main() {
  const appRoot = path.resolve(process.argv[2]);
  const { RuntimeManager } = require(path.join(appRoot, "dist-electron", "electron", "runtime-manager.js"));
  const { HarnessSupervisor } = require(path.join(appRoot, "dist-electron", "electron", "supervisor.js"));
  const { FileRingLogger } = require(path.join(appRoot, "dist-electron", "electron", "logger.js"));
  const stressRoot = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-stress-"));
  let child;
  const samples = [];
  try {
    for (let round = 1; round <= rounds; round++) {
      const roundRoot = path.join(stressRoot, `round-${round}`);
      const manager = new RuntimeManager(roundRoot, () => {});
      await manager.initialize();
      let running = await startWeb(manager);
      child = running.child;
      const initialBurst = await probeBurst(running.origin, concurrency);
      await terminate(child);
      child = undefined;
      if (await manager.recordFailure() !== "retry" || manager.getState().tokenSavingEnabled) {
        throw new Error(`Round ${round}: failure did not disable token-saving mode`);
      }
      running = await startWeb(manager);
      child = running.child;
      const recoveryBurst = await probeBurst(running.origin, concurrency);
      await terminate(child);
      child = undefined;
      const reloaded = new RuntimeManager(roundRoot, () => {});
      await reloaded.initialize();
      if (reloaded.getState().tokenSavingEnabled || reloaded.getActive().source !== "bundled") {
        throw new Error(`Round ${round}: recovered state did not survive restart`);
      }
      samples.push({ round, initialMs: initialBurst.elapsedMs, recoveredMs: recoveryBurst.elapsedMs });
      process.stdout.write(`round ${round}/${rounds}: ${concurrency * 2} requests, runtime and recovery passed\n`);
    }
    for (let round = 1; round <= supervisorRounds; round++) {
      const roundRoot = path.join(stressRoot, `supervisor-${round}`);
      const manager = new RuntimeManager(roundRoot, () => {});
      await manager.initialize();
      const logger = new FileRingLogger(path.join(roundRoot, "logs", "supervisor.log"));
      await logger.initialize();
      const supervisor = new HarnessSupervisor(manager, logger, "stress");
      try {
        await supervisor.start();
        await waitForStatus(supervisor, "online", 45_000);
        await terminate(supervisor.child);
        await waitForStatus(supervisor, "recovering", 10_000);
        await waitForStatus(supervisor, "online", 45_000);
        if (manager.getState().tokenSavingEnabled || supervisor.snapshot().status !== "online") {
          throw new Error(`Supervisor round ${round}: token-saving recovery failed after crash`);
        }
      } finally {
        await supervisor.stop();
      }
      process.stdout.write(`supervisor ${round}/${supervisorRounds}: crash and automatic recovery passed\n`);
    }
    process.stdout.write(JSON.stringify({ rounds, concurrency, requests: rounds * concurrency * 2,
      failureRecoveryPasses: rounds, supervisorCrashRecoveryPasses: supervisorRounds, samples }) + "\n");
  } finally {
    if (child) await terminate(child);
    await rm(stressRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
