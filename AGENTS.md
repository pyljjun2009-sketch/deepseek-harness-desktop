# DeepSeek Harness Desktop engineering guide

## Commands

- Install: `npm install`
- Develop: `npm run dev`
- Verify: `npm run verify`
- Build Windows installer: `npm run dist:win`

## Stability rules

- Never mutate `~/.dsh` during an upgrade. Treat it as user-owned data.
- A downloaded runtime must pass `--version` and the active web profile's `--dump-config` before activation.
- A candidate is not stable until it survives the probation window and HTTP health checks.
- Keep the bundled runtime as the final recovery floor.
- Persist recovery state with an atomic temp-file replacement and a backup copy.
- Renderer code receives only narrow, validated IPC methods. Never expose raw `ipcRenderer`, shell, or filesystem access.

## Done means

- Typecheck, unit tests, and production build pass.
- Recovery behavior is covered by tests.
- Runtime and desktop logs contain no API keys or credential file contents.
