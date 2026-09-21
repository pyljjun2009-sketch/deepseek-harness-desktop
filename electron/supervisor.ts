import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AvailableUpdate, HarnessSnapshot, HarnessStatus } from "../shared/contracts";
import { FileRingLogger } from "./logger";
import { isHealthyHttpStatus } from "./health";
import { RuntimeManager } from "./runtime-manager";

const START_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 5_000;
const PROBATION_MS = 45_000;

export class HarnessSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private status: HarnessStatus = "stopped";
  private message = "等待启动";
  private url?: string;
  private startedAt?: Date;
  private manualStop = false;
  private generation = 0;
  private healthTimer?: NodeJS.Timeout;
  private probationTimer?: NodeJS.Timeout;
  private healthFailures = 0;
  private latestUpdate?: AvailableUpdate;
  private autoStart = false;

  constructor(
    private readonly runtime: RuntimeManager,
    private readonly logger: FileRingLogger,
    private readonly desktopVersion: string
  ) {
    super();
  }

  setAutoStart(enabled: boolean): void {
    this.autoStart = enabled;
    this.emitSnapshot();
  }

  setLatestUpdate(update: AvailableUpdate): void {
    this.latestUpdate = update;
    this.emitSnapshot();
  }

  snapshot(): HarnessSnapshot {
    const state = this.runtime.getState();
    return {
      status: this.status,
      message: this.message,
      activeVersion: state.active.version,
      activeSource: state.active.source,
      lastKnownGoodVersion: state.lastKnownGood.version,
      candidateVersion: state.candidate?.version,
      desktopVersion: this.desktopVersion,
      profile: "web",
      url: this.url,
      startedAt: this.startedAt?.toISOString(),
      uptimeSeconds: this.startedAt ? Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1000)) : 0,
      crashCount: state.crashTimestamps.length,
      rollbackCount: state.rollbackCount,
      channel: state.channel,
      autoStart: this.autoStart,
      tokenSavingEnabled: state.tokenSavingEnabled,
      latestUpdate: this.latestUpdate,
      logs: this.logger.recent()
    };
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.manualStop = false;
    await this.launch();
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.clearTimers();
    this.status = "stopping";
    this.message = "正在停止运行时";
    this.emitSnapshot();
    await this.terminateChild();
    this.status = "stopped";
    this.message = "运行时已停止";
    this.url = undefined;
    this.startedAt = undefined;
    this.emitSnapshot();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.manualStop = false;
    await this.launch();
  }

  async activateInstalledCandidate(version: string): Promise<void> {
    const previousStatus = this.status;
    const previousMessage = this.message;
    this.status = "updating";
    this.message = `正在安装 ${version}`;
    this.emitSnapshot();
    try {
      await this.runtime.installCandidate(version);
      await this.restart();
    } catch (error) {
      this.status = previousStatus;
      this.message = previousMessage;
      this.emitSnapshot();
      throw error;
    }
  }

  private async launch(): Promise<void> {
    const active = this.runtime.getActive();
    const generation = ++this.generation;
    this.status = "starting";
    this.message = `正在启动 DSH ${active.version}`;
    this.url = undefined;
    this.startedAt = undefined;
    this.emitSnapshot();
    this.logger.log("supervisor", `启动 ${active.source}:${active.version}`);

    const child = spawn(
      process.execPath,
      [active.binPath, "web", ...this.runtime.getOptimizationArguments(), "--host", "127.0.0.1", "--port", "0", "--no-open"],
      {
        env: { ...this.runtime.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    this.child = child;

    const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const consumeLine = (scope: string, line: string): void => {
      this.logger.log(scope, line);
      // Wait for a complete line before accepting the URL. Newer DSH releases
      // append a process token; a stream chunk can otherwise end at the port
      // and accidentally drop the credential from the workbench URL.
      const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+(?:\/\?\S+)?)(?=\s|$)/i.exec(line);
      if (match && generation === this.generation) {
        this.url = match[1];
        void this.awaitHealthy(generation, match[1]);
      }
    };
    const consume = (stream: "stdout" | "stderr", scope: string, chunk: Buffer): void => {
      buffers[stream] += chunk.toString("utf8");
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() ?? "";
      for (const line of lines) consumeLine(scope, line);
      this.emitSnapshot();
    };

    child.stdout.on("data", (chunk: Buffer) => consume("stdout", "harness", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", "harness:error", chunk));
    child.on("error", (error) => this.logger.log("supervisor", `进程错误：${error.message}`));
    child.on("exit", (code, signal) => {
      if (buffers.stdout) consumeLine("harness", buffers.stdout);
      if (buffers.stderr) consumeLine("harness:error", buffers.stderr);
      this.logger.log("supervisor", `运行时退出 code=${code ?? "null"} signal=${signal ?? "none"}`);
      if (generation === this.generation) void this.handleExit();
    });

    setTimeout(() => {
      if (generation === this.generation && this.status === "starting") {
        this.logger.log("supervisor", "启动超时，终止候选进程");
        void this.terminateChild();
      }
    }, START_TIMEOUT_MS);
  }

  private async awaitHealthy(generation: number, url: string): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    // Never fetch the launch URL: DSH 0.1.5+ tokens are one-use and belong to
    // the first workbench navigation, not to the desktop health monitor.
    const healthUrl = new URL(url).origin + "/";
    while (Date.now() < deadline && generation === this.generation && this.child) {
      if (await this.probe(healthUrl)) {
        this.status = "online";
        this.message = "运行正常，恢复保护已启用";
        this.startedAt = new Date();
        this.healthFailures = 0;
        this.emitSnapshot();
        this.startHealthMonitor(generation, healthUrl);
        this.probationTimer = setTimeout(() => {
          if (generation === this.generation && this.status === "online") {
            void this.runtime.markHealthy().then(() => this.emitSnapshot());
          }
        }, PROBATION_MS);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  private startHealthMonitor(generation: number, url: string): void {
    this.healthTimer = setInterval(() => {
      void (async () => {
        if (generation !== this.generation || !this.child) return;
        if (await this.probe(url)) {
          this.healthFailures = 0;
          return;
        }
        this.healthFailures += 1;
        this.logger.log("health", `健康检查失败 ${this.healthFailures}/3`);
        if (this.healthFailures >= 3) await this.terminateChild();
      })();
    }, HEALTH_INTERVAL_MS);
  }

  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      return isHealthyHttpStatus(response.status);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleExit(): Promise<void> {
    this.child = undefined;
    this.clearTimers();
    this.url = undefined;
    this.startedAt = undefined;
    if (this.manualStop) return;

    const action = await this.runtime.recordFailure();
    if (action === "stop") {
      this.status = "faulted";
      this.message = "捆绑运行时连续失败，已安全停止；请查看日志";
      this.emitSnapshot();
      return;
    }

    this.status = "recovering";
    this.message =
      action === "rollback"
        ? "候选版本异常，正在回滚到上一稳定版"
        : action === "fallback-bundled"
          ? "托管版本连续异常，正在恢复捆绑稳定版"
          : "运行时异常，正在自动重启";
    this.emitSnapshot();

    const delay = action === "retry"
      ? Math.min(8_000, 2_000 * Math.max(1, this.runtime.getState().crashTimestamps.length))
      : 800;
    setTimeout(() => {
      if (!this.manualStop && !this.child) void this.launch();
    }, delay);
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    child.kill();
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    }
  }

  private clearTimers(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.probationTimer) clearTimeout(this.probationTimer);
    this.healthTimer = undefined;
    this.probationTimer = undefined;
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.snapshot());
  }
}
