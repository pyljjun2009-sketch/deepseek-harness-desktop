import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AvailableUpdate, RuntimeChannel, RuntimeRef } from "../shared/contracts";
import { AtomicJsonStore } from "./atomic-store";
import {
  createDefaultState,
  decideAfterFailure,
  promoteCandidate,
  type RecoveryAction,
  type RecoveryState
} from "./recovery-policy";
import { compareVersions, isSafeVersion, selectChannelVersion } from "./versioning";

type LogFunction = (scope: string, message: string) => void;

interface RegistryDocument {
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
}

function isRuntimeRef(value: unknown): value is RuntimeRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeRef>;
  return (
    (candidate.source === "bundled" || candidate.source === "managed") &&
    typeof candidate.version === "string" &&
    typeof candidate.binPath === "string"
  );
}

function isRecoveryState(value: unknown): value is RecoveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RecoveryState>;
  return (
    state.schemaVersion === 1 &&
    (state.channel === "stable" || state.channel === "preview") &&
    isRuntimeRef(state.active) &&
    isRuntimeRef(state.lastKnownGood) &&
    (state.candidate === undefined || isRuntimeRef(state.candidate)) &&
    Array.isArray(state.crashTimestamps) &&
    typeof state.rollbackCount === "number" &&
    (state.tokenSavingEnabled === undefined || typeof state.tokenSavingEnabled === "boolean") &&
    typeof state.updatedAt === "string"
  );
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
  log: LogFunction
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令在 ${options.timeoutMs / 1000} 秒后超时`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => log("update", String(chunk)));
    child.stderr.on("data", (chunk) => log("update", String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`命令退出码：${code ?? "unknown"}`));
    });
  });
}

export class RuntimeManager {
  readonly bundled: RuntimeRef;
  readonly harnessHome: string;
  readonly optimizationPatchPath: string;
  private readonly store: AtomicJsonStore<RecoveryState>;
  private state?: RecoveryState;

  constructor(
    private readonly dataRoot: string,
    private readonly log: LogFunction,
    bundledOverride?: RuntimeRef
  ) {
    this.bundled = bundledOverride ?? this.resolveBundledRuntime();
    // The desktop runtime deliberately owns its profile root. Reusing ~/.dsh here
    // would let an incompatible global plugin prevent even the recovery runtime
    // from booting, which defeats the stable-floor guarantee.
    this.harnessHome = path.join(dataRoot, "harness-home");
    this.optimizationPatchPath = path.resolve(__dirname, "..", "..", "config", "token-saving.patch.yml");
    this.store = new AtomicJsonStore(
      path.join(dataRoot, "recovery", "state.json"),
      () => createDefaultState(this.bundled),
      isRecoveryState
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.harnessHome, { recursive: true });
    this.state = await this.store.read();
    if (this.state.tokenSavingEnabled === undefined) {
      this.state = { ...this.state, tokenSavingEnabled: true };
      await this.persist();
    }
    const bundledPointerChanged =
      this.state.active.source === "bundled" &&
      (this.state.active.version !== this.bundled.version ||
        path.resolve(this.state.active.binPath) !== path.resolve(this.bundled.binPath));
    if (!existsSync(this.state.active.binPath) || bundledPointerChanged) {
      this.log("recovery", "活动运行时文件缺失或捆绑版本已变化，重建安全基线");
      this.state = {
        ...createDefaultState(this.bundled),
        channel: this.state.channel,
        tokenSavingEnabled: this.state.tokenSavingEnabled
      };
      await this.persist();
    }
  }

  getState(): RecoveryState {
    if (!this.state) throw new Error("RuntimeManager 尚未初始化");
    return this.state;
  }

  getActive(): RuntimeRef {
    return this.getState().active;
  }

  getHarnessEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DSH_HOME: this.harnessHome,
      DSH_DESKTOP: "1"
    };
  }

  getOptimizationArguments(): string[] {
    return this.getState().tokenSavingEnabled ? ["--patch", this.optimizationPatchPath] : [];
  }

  async setTokenSaving(enabled: boolean): Promise<void> {
    if (enabled && !existsSync(this.optimizationPatchPath)) throw new Error("省 token 配置文件缺失");
    this.state = { ...this.getState(), tokenSavingEnabled: enabled, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  async setChannel(channel: RuntimeChannel): Promise<void> {
    this.state = { ...this.getState(), channel, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  async checkForUpdate(): Promise<AvailableUpdate> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("https://registry.npmjs.org/@deepseek-ai%2Fdsh", {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`);
      const document = (await response.json()) as RegistryDocument;
      const tags = document["dist-tags"] ?? {};
      const latest = selectChannelVersion(tags, this.getState().channel);
      return {
        current: this.getActive().version,
        latest,
        channel: this.getState().channel,
        available: compareVersions(latest, this.getActive().version) > 0,
        publishedAt: document.time?.[latest]
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async installCandidate(version: string): Promise<RuntimeRef> {
    if (!isSafeVersion(version)) throw new Error("拒绝不安全的版本字符串");
    const runtimesRoot = path.join(this.dataRoot, "runtimes");
    const finalRoot = path.join(runtimesRoot, version);
    const binPath = path.join(finalRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

    await mkdir(runtimesRoot, { recursive: true });
    if (!existsSync(binPath)) {
      const stagingRoot = path.join(runtimesRoot, `.staging-${version}-${Date.now()}`);
      await mkdir(stagingRoot, { recursive: true });
      try {
        // npm 11 denies undeclared dependency lifecycle scripts by default.
        // Fail closed on new scripts while allowing the reviewed native helpers
        // used by current DSH releases. A new script requires a desktop update.
        await writeFile(
          path.join(stagingRoot, "package.json"),
          JSON.stringify({
            name: "deepseek-harness-managed-runtime",
            private: true,
            version: "0.0.0",
            allowScripts: {
              "@deepseek-ai/dsh-subprocess-local": true,
              "koffi": true,
              "node-pty": true,
              "@google/genai": false,
              "protobufjs": false
            }
          }),
          "utf8"
        );
        const npmPackagePath = require.resolve("npm/package.json");
        const npmCliPath = path.join(path.dirname(npmPackagePath), "bin", "npm-cli.js");
        await runCommand(
          process.execPath,
          [
            npmCliPath,
            "install",
            "--prefix",
            stagingRoot,
            "--save-exact",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--strict-allow-scripts",
            `@deepseek-ai/dsh@${version}`
          ],
          {
            timeoutMs: 180_000,
            env: { ...this.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" }
          },
          this.log
        );
        await this.smokeTest(
          path.join(stagingRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
        );
        await rename(stagingRoot, finalRoot);
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    } else {
      await this.smokeTest(binPath);
    }

    const candidate: RuntimeRef = { source: "managed", version, binPath };
    this.state = {
      ...this.getState(),
      active: candidate,
      candidate,
      updatedAt: new Date().toISOString()
    };
    await this.persist();
    this.log("update", `候选运行时 ${version} 已激活，等待观察期`);
    return candidate;
  }

  async markHealthy(): Promise<void> {
    const previous = this.getState();
    const wasCandidate = Boolean(previous.candidate);
    const next = promoteCandidate(previous);
    if (wasCandidate || previous.crashTimestamps.length > 0) {
      this.state = next;
      await this.persist();
      this.log(
        "recovery",
        wasCandidate
          ? `${next.active.version} 已晋升为最后稳定版本`
          : `${next.active.version} 已通过观察期，崩溃窗口已清零`
      );
    }
  }

  async recordFailure(): Promise<RecoveryAction> {
    if (this.getState().tokenSavingEnabled) {
      this.state = {
        ...this.getState(),
        tokenSavingEnabled: false,
        updatedAt: new Date().toISOString()
      };
      await this.persist();
      this.log("recovery", "运行时异常：先关闭省 token 层，使用原生配置重试");
      return "retry";
    }
    const decision = decideAfterFailure(this.getState(), this.bundled);
    this.state = decision.state;
    await this.persist();
    this.log("recovery", `故障策略：${decision.action}`);
    return decision.action;
  }

  private async smokeTest(binPath: string): Promise<void> {
    if (!existsSync(binPath)) throw new Error("候选运行时缺少 dsh 入口文件");
    const env = { ...this.getHarnessEnvironment(), ELECTRON_RUN_AS_NODE: "1" };
    await runCommand(process.execPath, [binPath, "--version"], { timeoutMs: 15_000, env }, this.log);
    await runCommand(
      process.execPath,
      [binPath, "--profile", "web", ...this.getOptimizationArguments(), "--dump-config"],
      { timeoutMs: 30_000, env },
      this.log
    );
  }

  private resolveBundledRuntime(): RuntimeRef {
    const packagePath = require.resolve("@deepseek-ai/dsh/package.json");
    const packageDocument = JSON.parse(require("node:fs").readFileSync(packagePath, "utf8")) as {
      version: string;
    };
    return {
      source: "bundled",
      version: packageDocument.version,
      binPath: path.join(path.dirname(packagePath), "lib", "bin.js")
    };
  }

  private async persist(): Promise<void> {
    await this.store.write(this.getState());
  }
}
