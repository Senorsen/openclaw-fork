# Compaction cancellation and diagnostic fix (2026-10-30)

Scope: main Claw only, no provider/model/config change, no retry of refused content.

Evidence: three manual Opus 5.5 summary failures correlate within 30ms with upstream
`stop_reason=refusal`. pi-ai 0.75.1 maps it to `error` then overwrites the cause with
`An unknown error occurred`. Memory-pressure warnings use a hardcoded 2GiB heap
threshold and do not cancel compaction. Separately, caller-aborted compaction was
classified as timeout, traversing nine fallback models while reloading history.

Changes:
- Source and runtime overlay: caller cancellation is terminal; no fallback session
  construction after cancellation. Explicit provider refusal remains terminal.
- PI dependency: retain `refusal` / `sensitive` error diagnostic, never retry it.
- PI compaction: reject aborted or empty summaries before appending a checkpoint.
- Classify summary failures, refusal and cancellation accurately.

`Dockerfile` overlays the exact deployed security-patched image (digest-pinned).
The patch script fails closed on any unexpected code shape. The full source
Dockerfile also runs the dependency patch after pruning; source changes are
compiled normally. No build or patch is performed on the running gateway.

Validation:
- source compact.hooks.test.ts: cancellation before/after start, ordinary 429
  failover, ephemeral selection, and no retry on refusal.
- source compact-reasons.test.ts: diagnostics.
- `verify.mjs`: synthetic HTTP SSE through real PI provider; refusal, sensitive,
  cancelled/empty history and turn-prefix, normal successful summary; real
  OpenClaw entrypoint pre-cancellation before model/transcript access.

Build/publish: `.github/workflows/build-compaction-fix.yml` on GitHub Actions.
Rollback: restore old digest in main OpenClaw values.yaml and run install.sh.
Never switch models or edit the history to work around an upstream refusal.
