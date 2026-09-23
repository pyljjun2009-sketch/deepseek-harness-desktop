import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AvailableUpdate, RuntimeChannel, RuntimeRef } from "../shared/contracts";
import { AtomicJsonStore } from "./atomic-store";
import {
  createDefaultState,
  decideAfterFailure,
  migrateRecoveryState,
  promoteCandidate,
  type LegacyRecoveryState,
  type RecoveryAction,
  type RecoveryState
} from "./recovery-policy";
import { compareVersions, isSafeVersion, selectChannelVersion } from "./versioning";
import { smokeWebRuntime } from "./web-smoke";

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

function isSafeHomeId(value: unknown): value is string {
  return value === "default" || (
    typeof value === "string" &&
    /^slot-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(value) &&
    !value.includes("..")
  );
}

function isRecoveryState(value: unknown): value is RecoveryState | LegacyRecoveryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (state.schemaVersion === 1 || state.schemaVersion === 2) &&
    (state.schemaVersion !== 2 ||
      (isSafeHomeId(state.activeHomeId) &&
        isSafeHomeId(state.lastKnownGoodHomeId) &&
        (state.candidateHomeId === undefined || isSafeHomeId(state.candidateHomeId)))) &&
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
  readonly desktopCompatPatchPath: string;
  readonly optimizationPatchPath: string;
  private readonly store: AtomicJsonStore<RecoveryState | LegacyRecoveryState>;
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
    const packagedConfig = path.resolve(__dirname, "..", "..", "config");
    const sourceConfig = path.resolve(__dirname, "..", "config");
    const configRoot = existsSync(packagedConfig) ? packagedConfig : sourceConfig;
    this.desktopCompatPatchPath = path.join(configRoot, "desktop-compat.patch.yml");
    this.optimizationPatchPath = path.join(configRoot, "token-saving.patch.yml");
    this.store = new AtomicJsonStore(
      path.join(dataRoot, "recovery", "state.json"),
      () => createDefaultState(this.bundled),
      isRecoveryState
    );
  }

  async initialize(): Promise<void> {
    await mkdir(this.harnessHome, { recursive: true });
    const stored = await this.store.read();
    const hadLegacySub2Api = Object.prototype.hasOwnProperty.call(stored, "sub2api");
    const migrated = migrateRecoveryState(stored) as RecoveryState & { sub2api?: unknown };
    const { sub2api: _legacySub2Api, ...cleanState } = migrated;
    this.state = cleanState;
    if (stored.schemaVersion === 1 || this.state.tokenSavingEnabled === undefined || hadLegacySub2Api) {
      this.state = {
        ...this.state,
        tokenSavingEnabled: this.state.tokenSavingEnabled ?? true
      };
      await this.persist();
    }
    const bundledPointerChanged =
      this.state.active.source === "bundled" &&
      (this.state.active.version !== this.bundled.version ||
        path.resolve(this.state.active.binPath) !== path.resolve(this.bundled.binPath));
    if (!existsSync(this.state.active.binPath) ||
        !existsSync(this.resolveHomePath(this.state.activeHomeId)) || bundledPointerChanged) {
      this.log("recovery", "活动运行时或数据槽缺失，或捆绑版本已变化；重建安全基线");
      this.state = {
        ...createDefaultState(this.bundled),
        channel: this.state.channel,
        tokenSavingEnabled: this.state.tokenSavingEnabled
      };
      await this.persist();
      return;
    }
    if (!existsSync(this.state.lastKnownGood.binPath) ||
        !existsSync(this.resolveHomePath(this.state.lastKnownGoodHomeId))) {
      this.log("recovery", "上一稳定槽缺失，回滚目标已重建为捆绑版本");
      this.state = {
        ...this.state,
        lastKnownGood: this.bundled,
        lastKnownGoodHomeId: "default",
        updatedAt: new Date().toISOString()
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

  getHarnessEnvironment(homePath = this.resolveHomePath(this.getState().activeHomeId)): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: homePath,
      DSH_DESKTOP: "1"
    };
    return env;
  }

  getWebPatchArguments(): string[] {
    if (!existsSync(this.desktopCompatPatchPath)) throw new Error("桌面兼容配置文件缺失");
    const args = ["--patch", this.desktopCompatPatchPath];
    if (this.getState().tokenSavingEnabled) args.push("--patch", this.optimizationPatchPath);
    return args;
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
    const smokeHome = path.join(this.dataRoot, "update-smoke", `${version}-${randomUUID()}`);
    await mkdir(smokeHome, { recursive: true });
    try {
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
              `@deepseek-ai/dsh@${version}`,
              // Current upstream app-boot imports this package without declaring
              // it in the isolated npm dependency closure.
              "@deepseek-ai/cordis-plugin-group@1.0.2"
            ],
            {
              timeoutMs: 180_000,
              env: { ...this.getHarnessEnvironment(smokeHome), ELECTRON_RUN_AS_NODE: "1" }
            },
            this.log
          );
          await this.smokeTest(path.join(stagingRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"), smokeHome);
          await smokeWebRuntime(
            process.execPath,
            path.join(stagingRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
            smokeHome,
            this.getWebPatchArguments(),
            this.log,
            45_000,
            this.getHarnessEnvironment(smokeHome)
          );
          await rename(stagingRoot, finalRoot);
        } catch (error) {
          await rm(stagingRoot, { recursive: true, force: true });
          throw error;
        }
      } else {
        await this.smokeTest(binPath, smokeHome);
        await smokeWebRuntime(process.execPath, binPath, smokeHome, this.getWebPatchArguments(), this.log, 45_000, this.getHarnessEnvironment(smokeHome));
      }
      return { source: "managed", version, binPath };
    } finally {
      await rm(smokeHome, { recursive: true, force: true });
    }
  }

  // Call only after the supervisor has stopped the active DSH writer.
  async activateCandidate(candidate: RuntimeRef): Promise<void> {
    if (candidate.source !== "managed" || !isSafeVersion(candidate.version) || !existsSync(candidate.binPath)) {
      throw new Error("候选运行时无效");
    }
    const previous = this.getState();
    const homeId = `slot-${candidate.version}-${randomUUID()}`;
    const candidateHome = this.resolveHomePath(homeId);
    const activeHome = this.resolveHomePath(previous.activeHomeId);
    const generatedLinks = path.join(activeHome, "profiles", "node_modules").toLowerCase();
    await mkdir(path.dirname(candidateHome), { recursive: true });
    try {
      await cp(activeHome, candidateHome, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
        // DSH owns this dependency projection. Copying its Windows junctions
        // requires symlink privileges and retains links to the old runtime.
        filter: (source) => path.resolve(source).toLowerCase() !== generatedLinks
      });
      // DSH refreshes profile dependency links for this runtime in the clone.
      await this.smokeTest(candidate.binPath, candidateHome);
      await smokeWebRuntime(process.execPath, candidate.binPath, candidateHome, this.getWebPatchArguments(), this.log, 45_000, this.getHarnessEnvironment(candidateHome));
      this.state = {
        ...previous,
        active: candidate,
        activeHomeId: homeId,
        candidate,
        candidateHomeId: homeId,
        updatedAt: new Date().toISOString()
      };
      await this.persist();
      this.log("update", `候选运行时 ${candidate.version} 已激活，独立数据槽 ${homeId} 正在观察`);
    } catch (error) {
      this.state = previous;
      await rm(candidateHome, { recursive: true, force: true });
      throw error;
    }
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

  private resolveHomePath(homeId: string): string {
    if (!isSafeHomeId(homeId)) throw new Error("数据槽标识无效");
    return homeId === "default" ? this.harnessHome : path.join(this.dataRoot, "profile-homes", homeId);
  }

  private async smokeTest(binPath: string, homePath: string): Promise<void> {
    if (!existsSync(binPath)) throw new Error("候选运行时缺少 dsh 入口文件");
    const env = { ...this.getHarnessEnvironment(homePath), ELECTRON_RUN_AS_NODE: "1" };
    await runCommand(process.execPath, [binPath, "--version"], { timeoutMs: 15_000, env }, this.log);
    await runCommand(
      process.execPath,
      [binPath, "--profile", "web", ...this.getWebPatchArguments(), "--dump-config"],
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
