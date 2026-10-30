import fs from 'node:fs';
import path from 'node:path';

// Applied to immutable image layers, never to a running gateway.
// This only preserves refusal diagnostics; it does not retry/bypass refusals.
const root = path.resolve(process.argv[2] ?? '/app');
function packageFile(name, suffix) {
  return path.join(fs.realpathSync(path.join(root, 'node_modules', name)), suffix);
}
function replaceOnce(file, before, after) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes(after)) return;
  if (text.split(before).length !== 2) throw new Error(`Patch precondition failed: ${file}`);
  fs.writeFileSync(file, text.replace(before, after));
}
const anthropic = packageFile('@earendil-works/pi-ai', 'dist/providers/anthropic.js');
replaceOnce(anthropic,
  'output.stopReason = mapStopReason(event.delta.stop_reason);',
  `output.stopReason = mapStopReason(event.delta.stop_reason);
                        if (output.stopReason === "error") {
                            output.errorMessage = \`Anthropic response stopped: stop_reason=\${event.delta.stop_reason}\`;
                        }`);
replaceOnce(anthropic,
  'throw new Error("An unknown error occurred");',
  'throw new Error(output.errorMessage || "An unknown error occurred");');
const compaction = packageFile('@earendil-works/pi-coding-agent', 'dist/core/compaction/compaction.js');
for (const label of ['Summarization', 'Turn prefix summarization']) {
  replaceOnce(compaction,
    `    if (response.stopReason === "error") {\n        throw new Error(\`${label} failed: \${response.errorMessage || "Unknown error"}\`);\n    }`,
    `    if (signal?.aborted || response.stopReason === "aborted") {
        const error = new Error("${label} cancelled by caller");
        error.name = "AbortError";
        throw error;
    }
    if (response.stopReason === "error") {
        throw new Error(\`${label} failed: \${response.errorMessage || "Unknown error"}\`);
    }
    if (!response.content.some((block) => block.type === "text" && block.text.trim())) {
        throw new Error("${label} failed: empty summary");
    }`);
}

if (process.argv.includes('--runtime-overlay')) {
  const files = fs.readdirSync(path.join(root, 'dist')).filter(f => /^compact-.*\.js$/.test(f));
  const candidates = files.map(f => path.join(root, 'dist', f)).filter(f => fs.readFileSync(f, 'utf8').includes('async function compactEmbeddedPiSessionDirect(params) {'));
  if (candidates.length !== 1) throw new Error(`Expected one compact runtime, got ${candidates.length}`);
  const file = candidates[0];
  replaceOnce(file,
    'async function compactEmbeddedPiSessionDirect(params) {\n\tif (hasExplicitCompactionModel(params)',
    'async function compactEmbeddedPiSessionDirect(params) {\n\tif (params.abortSignal?.aborted) return { ok: false, compacted: false, reason: "Compaction cancelled by caller" };\n\tif (hasExplicitCompactionModel(params)');
  replaceOnce(file,
    'classifyResult: ({ result, provider, model }) => classifyCompactionFallbackResult(result, provider, model),',
    'classifyResult: ({ result, provider, model }) => params.abortSignal?.aborted ? null : classifyCompactionFallbackResult(result, provider, model),');
  replaceOnce(file,
    'run: async (provider, model) => {\n\t\t\t\tconst authProfileId = provider === primaryProvider',
    'run: async (provider, model) => {\n\t\t\t\tif (params.abortSignal?.aborted) return { ok: false, compacted: false, reason: "Compaction cancelled by caller" };\n\t\t\t\tconst authProfileId = provider === primaryProvider');
  replaceOnce(file,
    '\tif (text.includes("summary")) return "summary_failed";',
    '\tif (text.includes("stop_reason=refusal") || text.includes("stop_reason=sensitive")) return "provider_refusal";\n\tif (text.includes("aborted") || text.includes("cancelled by caller")) return "cancelled";\n\tif (text.includes("summary") || text.includes("summarization")) return "summary_failed";');
  console.log(`Patched compaction bundle: ${path.basename(file)}`);
}

// Backport openclaw/openclaw@b00e1b2e: actionable memory-pressure logs.
if (process.argv.includes('--runtime-overlay')) {
  const files = fs.readdirSync(path.join(root, 'dist')).filter(f => /^diagnostic-.*\.js$/.test(f)).map(f => path.join(root, 'dist', f)).filter(f => fs.readFileSync(f, 'utf8').includes('function logMemoryPressure(params) {'));
  if (files.length !== 1) throw new Error(`Expected one diagnostic runtime, got ${files.length}`);
  const file = files[0];
  replaceOnce(file,
    '\tif (pressure.level === "critical") log.warn(message);\n\telse log.info(message);\n}',
    '\tlog.warn(message);\n}');
  replaceOnce(file,
    'const message = `memory pressure: level=${pressure.level} reason=${pressure.reason} rssBytes=',
    'const message = `memory pressure: level=${pressure.level} reason=${pressure.reason} ${formatPressureSummary(pressure)} rssBytes=');
  replaceOnce(file,
    ' memoryPressureSnapshot=${params.writeCriticalBundle ? "enabled" : "disabled"}` : "");',
    ' memoryPressureSnapshot=${params.writeCriticalBundle ? "enabled" : "disabled"}` : "") + ` ${formatPressureNextStep(pressure)}`;');
  replaceOnce(file, 'function logMemoryPressure(params) {', `const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];
function formatScaledNumber(value) {
\tconst fixed = value >= 10 ? value.toFixed(1) : value.toFixed(2);
\treturn fixed.replace(/\\.0+$/u, "").replace(/(\\.\\d*[1-9])0$/u, "$1");
}
function formatReadableBytes(value) {
\tif (typeof value !== "number" || !Number.isFinite(value) || value < 0) return void 0;
\tlet scaled = value;
\tlet unitIndex = 0;
\twhile (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) { scaled /= 1024; unitIndex++; }
\treturn unitIndex === 0 ? \`\${Math.round(scaled)} \${BYTE_UNITS[unitIndex]}\` : \`\${formatScaledNumber(scaled)} \${BYTE_UNITS[unitIndex]}\`;
}
function formatPressureRatio(params) {
\tconst { pressure, thresholdBytes } = params;
\tif (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return void 0;
\tconst value = pressure.reason === "heap_threshold" ? pressure.memory.heapUsedBytes : pressure.reason === "rss_growth" ? pressure.rssGrowthBytes : pressure.memory.rssBytes;
\tif (typeof value !== "number" || !Number.isFinite(value)) return void 0;
\treturn \`\${formatScaledNumber(value / thresholdBytes * 100)}%\`;
}
function formatPressureSummary(pressure) {
\treturn [
\t\t\`rss=\${formatReadableBytes(pressure.memory.rssBytes)}\`,
\t\t\`heap=\${formatReadableBytes(pressure.memory.heapUsedBytes)}\`,
\t\tpressure.thresholdBytes !== void 0 ? \`threshold=\${formatReadableBytes(pressure.thresholdBytes)}\` : "",
\t\tpressure.thresholdBytes !== void 0 ? \`thresholdRatio=\${formatPressureRatio({ pressure, thresholdBytes: pressure.thresholdBytes })}\` : "",
\t\tpressure.rssGrowthBytes !== void 0 ? \`rssGrowth=\${formatReadableBytes(pressure.rssGrowthBytes)}\` : ""
\t].filter(Boolean).join(" ");
}
function formatPressureNextStep(pressure) {
\treturn pressure.level === "critical" ? "nextStep=inspect latest stability bundle or run openclaw gateway diagnostics export; restart gateway if process is unstable" : "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists";
}
function logMemoryPressure(params) {`);
  console.log(`Patched memory pressure log: ${path.basename(file)}`);
}
console.log('Patched PI refusal diagnostics and cancelled/empty-summary rejection.');
