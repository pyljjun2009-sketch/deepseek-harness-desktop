const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const executable = path.join(root, "release", "win-unpacked", "DeepSeekHarness.exe");
const appRoot = path.join(root, "release", "win-unpacked", "resources", "app");
const script = path.join(__dirname, "stress-packaged.cjs");

const child = spawn(executable, [script, appRoot], {
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
