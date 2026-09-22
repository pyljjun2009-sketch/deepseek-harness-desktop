import { spawn } from "node:child_process";
import { isHealthyHttpStatus } from "./health";

type LogFunction = (scope: string, message: string) => void;

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  } else {
    child.kill();
  }
}

export async function smokeWebRuntime(
  executable: string,
  binPath: string,
  homePath: string,
  optimizationArgs: string[],
  log: LogFunction,
  timeoutMs = 45_000
): Promise<void> {
  const child = spawn(
    executable,
    [binPath, "web", ...optimizationArgs, "--host", "127.0.0.1", "--port", "0", "--no-open"],
    {
      env: { ...process.env, DSH_HOME: homePath, DSH_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  let lineBuffer = "";
  let exitDescription: string | undefined;
  const deadline = Date.now() + timeoutMs;
  const launchUrl = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`候选 Web 在 ${timeoutMs / 1000} 秒内未启动`)), timeoutMs);
    const onLine = (line: string): void => {
      const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/\?\S+)?)(?=\s|$)/i.exec(line);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
      if (lineBuffer.length > 4096) lineBuffer = lineBuffer.slice(-4096);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exitDescription = `code=${code ?? "null"} signal=${signal ?? "none"}`;
      if (lineBuffer) onLine(lineBuffer);
      clearTimeout(timer);
      reject(new Error(`候选 Web 提前退出 (${exitDescription}): ${output}`));
    });
  });

  try {
    const origin = new URL(await launchUrl).origin + "/";
    while (Date.now() < deadline) {
      if (exitDescription) throw new Error(`候选 Web 提前退出 (${exitDescription}): ${output}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_500);
      try {
        const response = await fetch(origin, { signal: controller.signal, redirect: "manual" });
        if (isHealthyHttpStatus(response.status)) {
          log("update", "候选 Web HTTP 预检通过");
          return;
        }
      } catch {
        // Continue until the startup deadline; the server may still be binding.
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`候选 Web HTTP 在 ${timeoutMs / 1000} 秒内未就绪: ${output}`);
  } finally {
    await terminate(child);
  }
}
