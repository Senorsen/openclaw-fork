# Claw runtime security overlay — 2026-10-22

Owner-authorized scope: main Claw, nana and ubuntu-tools language infrastructure.
These two image overlays pin the exact running Claw images by digest, replacing
Node with official 24.22.1 and applying distribution Python/TLS/CA updates. No
Claw source, model configuration or application dependency is upgraded.

CI smoke-tests Brotli, SQLite, Node/Python trust stores and the Claw CLI, and
verifies `/app/dist` checksums are identical. Existing corepack/pnpm is retained.
Deploy nana first with its install.sh and verify runtime; main goes last.
Go/uv tools in persistent workspaces and ubuntu-tools are handled separately.
