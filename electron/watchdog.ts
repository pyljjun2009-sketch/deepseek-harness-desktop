import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const [, , parentPidText, token, controlFile, executable] = process.argv;
const parentPid = Number(parentPidText);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wasCleanShutdown(): Promise<boolean> {
  try {
    return (await readFile(controlFile, "utf8")).trim() === token;
  } catch {
    return false;
  }
}

async function monitor(): Promise<void> {
  while (isAlive(parentPid)) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (await wasCleanShutdown()) return;

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ["--recovered-from-crash"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env
  });
  child.unref();
}

void monitor();
