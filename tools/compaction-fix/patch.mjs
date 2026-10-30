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
console.log('Patched PI refusal diagnostics and cancelled/empty-summary rejection.');
