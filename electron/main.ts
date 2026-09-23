import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent
} from "electron";
import type { CommandResult, RuntimeChannel, Sub2ApiSettings } from "../shared/contracts";
import { FileRingLogger } from "./logger";
import { RuntimeManager } from "./runtime-manager";
import { HarnessSupervisor } from "./supervisor";
import { isSafeVersion } from "./versioning";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | undefined;
let workbenchWindow: BrowserWindow | undefined;
let supervisor: HarnessSupervisor;
let runtime: RuntimeManager;
let logger: FileRingLogger;
let cleanShutdownToken: { token: string; filePath: string } | undefined;
let fullyInitialized = false;

function writeBootstrapLog(error: unknown): void {
  try {
    const directory = path.join(app.getPath("userData"), "logs");
    mkdirSync(directory, { recursive: true });
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(
      path.join(directory, "bootstrap.log"),
      `${new Date().toISOString()} ${detail}\n`,
      "utf8"
    );
  } catch {
    // Last-resort logging must never mask the original startup failure.
  }
}

process.on("uncaughtException", (error) => {
  writeBootstrapLog(error);
  if (fullyInitialized) app.relaunch({ args: process.argv.slice(1).concat("--recovered-from-exception") });
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  writeBootstrapLog(reason);
  app.exit(1);
});

function result(ok: boolean, message: string): CommandResult {
  return { ok, message };
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  return url.startsWith("app://desktop/") || Boolean(devUrl && url.startsWith(devUrl));
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) throw new Error("拒绝来自非管理界面的 IPC 请求");
}

function registerFileProtocol(): void {
  protocol.handle("app", async (request) => {
    const requestUrl = new URL(request.url);
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
    const root = path.resolve(__dirname, "..", "..", "dist");
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const data = await readFile(target);
      const extension = path.extname(target).toLowerCase();
      const contentTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml"
      };
      return new Response(data, {
        status: 200,
        headers: { "content-type": contentTypes[extension] ?? "application/octet-stream" }
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function secureWindow(window: BrowserWindow, allowedPrefix: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (!destination.startsWith(allowedPrefix)) event.preventDefault();
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#0b1014",
    show: false,
    title: "DeepSeek Harness Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
    secureWindow(window, process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadURL("app://desktop/index.html");
    secureWindow(window, "app://desktop/");
  }

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  return window;
}

function openWorkbench(): CommandResult {
  const snapshot = supervisor.snapshot();
  if (!snapshot.url || snapshot.status !== "online") {
    return result(false, "运行时尚未就绪，请稍候再打开工作台");
  }
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.show();
    workbenchWindow.focus();
    return result(true, "工作台已打开");
  }

  const origin = new URL(snapshot.url).origin;
  workbenchWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#0b1014",
    title: "DeepSeek Harness Workbench",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });
  secureWindow(workbenchWindow, `${origin}/`);
  workbenchWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  void workbenchWindow.loadURL(snapshot.url);
  workbenchWindow.on("closed", () => {
    workbenchWindow = undefined;
  });
  return result(true, "工作台已打开");
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-snapshot", (event) => {
    assertTrustedSender(event);
    return supervisor.snapshot();
  });

  ipcMain.handle("desktop:start", async (event) => {
    assertTrustedSender(event);
    await supervisor.start();
    return result(true, "启动命令已执行");
  });

  ipcMain.handle("desktop:stop", async (event) => {
    assertTrustedSender(event);
    await supervisor.stop();
    return result(true, "运行时已停止");
  });

  ipcMain.handle("desktop:restart", async (event) => {
    assertTrustedSender(event);
    await supervisor.restart();
    return result(true, "运行时正在重启");
  });

  ipcMain.handle("desktop:open-workbench", (event) => {
    assertTrustedSender(event);
    return openWorkbench();
  });

  ipcMain.handle("desktop:check-updates", async (event) => {
    assertTrustedSender(event);
    const update = await runtime.checkForUpdate();
    supervisor.setLatestUpdate(update);
    return update;
  });

  ipcMain.handle("desktop:install-update", async (event, version: unknown) => {
    assertTrustedSender(event);
    if (typeof version !== "string" || !isSafeVersion(version)) {
      return result(false, "版本号无效");
    }
    try {
      await supervisor.activateInstalledCandidate(version);
      return result(true, `${version} 已进入候选观察期`);
    } catch (error) {
      logger.log("update", `安装失败：${error instanceof Error ? error.message : String(error)}`);
      return result(false, `安装失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle("desktop:set-channel", async (event, channel: unknown) => {
    assertTrustedSender(event);
    if (channel !== "stable" && channel !== "preview") return result(false, "升级通道无效");
    await runtime.setChannel(channel as RuntimeChannel);
    return result(true, channel === "stable" ? "已切换到稳定通道" : "已切换到预览通道");
  });

  ipcMain.handle("desktop:set-auto-start", (event, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") return result(false, "自启动参数无效");
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
    supervisor.setAutoStart(enabled);
    return result(true, enabled ? "已启用开机启动" : "已关闭开机启动");
  });

  ipcMain.handle("desktop:set-token-saving", async (event, enabled: unknown) => {
    assertTrustedSender(event);
    if (typeof enabled !== "boolean") return result(false, "省 token 设置无效");
    await runtime.setTokenSaving(enabled);
    await supervisor.restart();
    return result(true, enabled ? "已启用省 token 模式，运行时正在重启" : "已恢复原生模式，运行时正在重启");
  });

  ipcMain.handle("desktop:list-sub2api-profiles", async (event, powerShellPath: unknown) => {
    assertTrustedSender(event);
    if (typeof powerShellPath !== "string" || powerShellPath.length > 1024) {
      return { ok: false, profiles: [], message: "PowerShell 路径无效" };
    }
    return runtime.listSub2ApiProfiles(powerShellPath);
  });

  ipcMain.handle("desktop:set-sub2api", async (event, value: unknown) => {
    assertTrustedSender(event);
    if (!value || typeof value !== "object") return result(false, "Sub2API 设置无效");
    const settings = value as Partial<Sub2ApiSettings>;
    if (typeof settings.enabled !== "boolean" ||
        typeof settings.powerShellPath !== "string" || settings.powerShellPath.length > 1024 ||
        !Array.isArray(settings.allowedProfiles)) return result(false, "Sub2API 设置无效");
    try {
      await runtime.setSub2Api(settings as Sub2ApiSettings);
      if (supervisor.snapshot().status !== "stopped") await supervisor.restart();
      return result(true, settings.enabled ? "Sub2API 工具已启用" : "Sub2API 工具已停用");
    } catch (error) {
      return result(false, error instanceof Error ? error.message : "Sub2API 设置失败");
    }
  });

  ipcMain.handle("desktop:open-logs", async (event) => {
    assertTrustedSender(event);
    const error = await shell.openPath(path.dirname(logger.filePath));
    return error ? result(false, error) : result(true, "已打开日志目录");
  });
}

async function startWatchdog(): Promise<void> {
  if (!app.isPackaged) return;
  const token = randomUUID();
  const filePath = path.join(app.getPath("userData"), "watchdog-shutdown.token");
  await writeFile(filePath, "", "utf8");
  cleanShutdownToken = { token, filePath };

  const watchdogPath = path.join(__dirname, "watchdog.js");
  const child = spawn(
    process.execPath,
    [watchdogPath, String(process.pid), token, filePath, process.execPath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    }
  );
  child.unref();
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("before-quit", () => {
  if (cleanShutdownToken) {
    writeFileSync(cleanShutdownToken.filePath, cleanShutdownToken.token, "utf8");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!mainWindow) mainWindow = createMainWindow();
});

void app.whenReady().then(async () => {
  app.setName("DeepSeek Harness Desktop");
  registerFileProtocol();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  logger = new FileRingLogger(path.join(app.getPath("userData"), "logs", "desktop.log"));
  await logger.initialize();
  runtime = new RuntimeManager(app.getPath("userData"), (scope, message) => logger.log(scope, message));
  await runtime.initialize();
  supervisor = new HarnessSupervisor(runtime, logger, app.getVersion());
  supervisor.setAutoStart(app.isPackaged && app.getLoginItemSettings().openAtLogin);

  mainWindow = createMainWindow();
  supervisor.on("snapshot", (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:snapshot", snapshot);
  });
  registerIpcHandlers();
  await startWatchdog();
  await supervisor.start();
  fullyInitialized = true;

  app.on("render-process-gone", (_event, webContents, details) => {
    logger.log("desktop", `Renderer 退出：${details.reason}`);
    if (mainWindow?.webContents === webContents) {
      mainWindow.destroy();
      mainWindow = createMainWindow();
    }
  });
}).catch((error) => {
  writeBootstrapLog(error);
  app.exit(1);
});
