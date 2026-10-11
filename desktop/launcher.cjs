const { app, BrowserWindow, dialog, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { DesktopRecovery } = require('./recovery.cjs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { HealthWindow } = require('./health-window.cjs');
// Stable installations are immutable; Python caches belong outside the install tree.
process.env.PYTHONDONTWRITEBYTECODE = '1';

const dataRoot = process.env.DSH_COMMUNITY_TEST_ROOT || app.getPath('userData');
// Isolated qualification can exercise the exact production watchdog and 45s probation.
const lightweightTest = !!process.env.DSH_COMMUNITY_TEST_ROOT && process.env.DSH_COMMUNITY_EXERCISE_RECOVERY !== '1';
fs.mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', dataRoot);
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  const version = require('../package.json').version;
  const recovery = new DesktopRecovery(dataRoot, version, path.dirname(process.execPath));
  let probation;
  let shuttingDown = false;
  let cleanWatchdog = () => {};
  let healthyGeneration = 0;
  let ready = false;
  app.commandLine.appendSwitch('lang', 'zh-CN');
  // Electron requires privilege registration synchronously, before recovery I/O can yield to ready.
  protocol.registerSchemesAsPrivileged([{
    scheme: 'dsh-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true }
  }]);
  process.on('community:scheme-registered', acknowledge => acknowledge());
  // 'quit' is intentional; official task confirmation can cancel 'before-quit'.
  app.on('quit', () => { shuttingDown = true; clearTimeout(probation); cleanWatchdog(); });
  process.on('community:pending', () => { healthyGeneration++; ready = false; clearTimeout(probation); });
  process.on('community:recover', (resolve) => {
    healthyGeneration++; ready = false;
    clearTimeout(probation);
    const decision = recovery.failure();
    if (decision.executable) process.env.DSH_COMMUNITY_RELAUNCH_PATH = decision.executable;
    resolve(decision.action);
  });
  process.on('community:ready', (probe, unhealthy) => {
    ready = true;
    const generation = ++healthyGeneration;
    clearTimeout(probation);
    const health = new HealthWindow(lightweightTest ? 3000 : 45000, lightweightTest ? 1000 : 5000);
    let promoted = false;
    let snapshotPending = false;
    const check = async () => {
      const stillHealthy = () => !shuttingDown && ready && generation === healthyGeneration &&
        health.healthy() &&
        BrowserWindow.getAllWindows().some(window => !window.isDestroyed() && !window.webContents.isDestroyed() &&
          window.webContents.getURL().startsWith('dsh-app://app/'));
      const live = () => !shuttingDown && ready && generation === healthyGeneration;
      if (!live()) return;
      let ok = false;
      try { ok = typeof probe === 'function' && await probe(); } catch {}
      if (!live()) return;
      health.record(ok);
      if (health.failed()) {
        ready = false; healthyGeneration++;
        if (typeof unhealthy === 'function') unhealthy();
        return;
      }
      try {
        if (!promoted && !snapshotPending && stillHealthy()) {
          // Continue sampling while the potentially large installation snapshot is copied.
          if (app.isPackaged && !lightweightTest) {
            snapshotPending = true;
            void recovery.healthy(stillHealthy).then(success => { promoted = success; })
              .catch(error => {
                const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
                  ? error.code : 'SNAPSHOT_FAILURE';
                console.error('Stable installation snapshot failed', { code });
                if (process.env.DSH_COMMUNITY_TEST_ROOT) {
                  fs.writeFileSync(path.join(dataRoot, 'snapshot-diagnostic.json'), JSON.stringify({ code }));
                }
              })
              .finally(() => { snapshotPending = false; });
          } else promoted = true;
        }
        if (promoted && stillHealthy() && process.env.DSH_COMMUNITY_SMOKE_RESULT) {
          const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
          fs.writeFileSync(process.env.DSH_COMMUNITY_SMOKE_RESULT, JSON.stringify({
            version, pid: process.pid, hostReady: true, home: process.env.DSH_HOME,
            windows: windows.map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), visible: window.isVisible() }))
          }, null, 2));
        }
      } catch { console.error('Desktop health result unavailable'); }
      if (live()) probation = setTimeout(check, health.interval);
    };
    void check();
  });
  void recovery.prepare().then(async (fallback) => {
    if (fallback) { app.relaunch({ execPath: fallback }); app.exit(0); return; }
    process.env.DSH_HOME = recovery.home();
    let watchdogPid;
    let watchdogControl;
    if (app.isPackaged && !lightweightTest) {
      const token = randomUUID();
      const control = path.join(dataRoot, 'official-recovery', `watchdog-${token}.control`);
      cleanWatchdog = () => fs.writeFileSync(control, token, { mode: 0o600 });
      const watchdog = spawn(process.execPath, [path.join(process.resourcesPath, 'recovery', 'watchdog.cjs'),
        String(process.pid), token, control, dataRoot, version, process.execPath], {
        detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      watchdog.on('error', () => console.error('External crash watchdog unavailable'));
      watchdog.unref();
      watchdogPid = watchdog.pid;
      watchdogControl = control;
    }
    if (process.env.DSH_COMMUNITY_TEST_ROOT) {
      fs.writeFileSync(path.join(dataRoot, 'qualification-process.json'), JSON.stringify({
        pid: process.pid, executable: process.execPath, home: process.env.DSH_HOME,
        watchdogPid, watchdogControl
      }));
    }
    delete process.env.DSH_COMMUNITY_RELAUNCH_PATH;
    await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'main.js')).href);
  }).catch(async (error) => {
    const bootCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'BOOT_FAILURE';
    const missingPackage = /^Cannot find package '([@A-Za-z0-9/_.-]+)'/.exec(error?.message ?? '')?.[1];
    const bootReason = /registerSchemesAsPrivileged.*before.*ready/i.test(error?.message ?? '')
      ? 'late-protocol-registration' : 'unclassified';
    console.error('Desktop bootstrap failed', { code: bootCode, ...(missingPackage ? { package: missingPackage } : {}) });
    if (process.env.DSH_COMMUNITY_TEST_ROOT) {
      fs.writeFileSync(path.join(dataRoot, 'bootstrap-diagnostic.json'), JSON.stringify({
        code: bootCode, reason: bootReason, ...(missingPackage ? { package: missingPackage } : {})
      }));
    }
    cleanWatchdog();
    const decision = recovery.failure();
    if (decision.action === 'retry' || decision.action === 'fallback') {
      app.relaunch({ execPath: decision.executable || process.execPath }); app.exit(0); return;
    }
    await app.whenReady();
    await dialog.showMessageBox({ type: 'error', title: '桌面版启动失败',
      message: '自动恢复未成功。原有数据和恢复记录已保留，请重新安装已验证的稳定版。',
      detail: '启动链路未能完成；请检查本机恢复记录和安装文件完整性。', buttons: ['退出'] });
    app.exit(1);
  });
}
