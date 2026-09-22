const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appRoot = path.join(root, "release", "win-unpacked", "resources", "app");
const executable = path.join(root, "release", "win-unpacked", "DeepSeekHarness.exe");
const script = path.join(__dirname, "smoke-packaged-updater.cjs");
const version = process.env.DSH_SMOKE_VERSION ?? "bundled";

const child = spawn(executable, [script, appRoot, version], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  shell: false,
  windowsHide: true,
  stdio: "inherit"
});

child.once("error", (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
