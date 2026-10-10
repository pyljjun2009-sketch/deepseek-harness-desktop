# DeepSeek Harness Desktop engineering guide

## Commands

- Install: `npm install`
- Develop: `npm run dev`
- Verify: `npm run verify`
- Build official Windows installer: `npm run dist:official` (`dist:win` also selects official)
- Legacy supervisor only: `npm run dist:legacy`; never publish it as an official-baseline distribution
- Real isolated release qualifications: `npm run qualify:recovery` and `npm run qualify:installer`

## Stability rules

- Never mutate `~/.dsh` during an upgrade. Treat it as user-owned data.
- A downloaded runtime must pass `--version` and the active web profile's `--dump-config` before activation.
- A candidate is not stable until it survives the probation window and HTTP health checks.
- Keep the bundled runtime as the final recovery floor.
- Persist recovery state with an atomic temp-file replacement and a backup copy.
- In Electron, installation snapshots use `original-fs` to preserve physical ASAR bytes. Never globally disable ASAR support.
- Installer/uninstaller checks are readonly: refuse when processes remain or detection is uncertain; never terminate by filename.
- Match a release tag to `official.lock.json.distributionVersion` and pass qualifications before updating latest.
- Renderer code receives only narrow, validated IPC methods. Never expose raw `ipcRenderer`, shell, or filesystem access.

## Done means

- Typecheck, unit tests, and production build pass.
- Recovery behavior is covered by tests.
- Runtime and desktop logs contain no API keys or credential file contents.
