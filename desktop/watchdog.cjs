const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DesktopRecovery } = require('./recovery.cjs');

function launch(spawnChild, executable, env) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) {
        try { child.unref(); } catch { ok = false; }
      }
      resolve(ok);
    };
    const timer = setTimeout(() => {
      finish(false);
      try { child?.kill(); } catch { /* Only this watchdog's own timed-out launch is stopped. */ }
    }, 10000);
    try {
      child = spawnChild(executable, ['--recovered-from-crash'], {
        detached: true, windowsHide: true, stdio: 'ignore', env
      });
      // Keep an error listener even after spawn; no raw error may expose inherited command details.
      child.on('error', () => { finish(false); });
      child.once('spawn', () => { finish(true); });
    } catch { finish(false); }
  });
}

async function monitor({ pid, token, control, root, version, executable }, spawnChild = spawn) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid watchdog owner');
  if (!path.isAbsolute(root) || path.dirname(control) !== path.join(root, 'official-recovery')) throw new Error('Invalid watchdog storage');
  const hasCleanExitMarker = () => {
    try { return fs.readFileSync(control, 'utf8') === token; }
    catch { return false; }
  };
  for (;;) {
    if (hasCleanExitMarker()) return;
    try { process.kill(pid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (hasCleanExitMarker()) return;
  const recovery = new DesktopRecovery(root, version, path.dirname(executable));
  let decision = recovery.failure();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (decision.action === 'manual') return;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // The watchdog starts before main consumes this flag; never carry an old reset into a stable data slot.
    delete env.DSH_COMMUNITY_RESET_PLUGINS;
    if (decision.action === 'disable-plugins') env.DSH_COMMUNITY_RESET_PLUGINS = '1';
    const target = decision.executable || executable;
    if (await launch(spawnChild, target, env)) return;
    if (decision.action === 'fallback') {
      // A verified cache can still be blocked by OS policy. Record that attempt, but never loop on it.
      new DesktopRecovery(root, recovery.state.active, path.dirname(target)).failure();
      return;
    }
    decision = recovery.failure();
  }
}

if (require.main === module) {
  const [pid, token, control, root, version, executable] = process.argv.slice(2);
  monitor({ pid: Number(pid), token, control, root, version, executable }).catch(() => { process.exitCode = 1; });
}
module.exports = { monitor };
