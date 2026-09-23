# dsh-sub2api-personal snapshot

This directory is a reviewed snapshot of the local `dsh-sub2api-personal` 0.4.2 project supplied for integration. The original project declares the MIT license, reproduced in `LICENSE`.

Only the DSH tool adapter is shipped. `dist/index.js` and `dist/core.js` are the executable files; `src/index.ts` and `src/core.ts` are their corresponding source files. The standalone MCP server and host-specific plugin manifests are outside this desktop integration.

The desktop application keeps the adapter disabled until the user selects an allowed account and a PowerShell 7 executable. Its absolute module path is mounted as a DSH overlay, so a DSH runtime upgrade does not need to resolve this package from its own dependency tree.
