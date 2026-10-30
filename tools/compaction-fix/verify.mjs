import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '/app');
function packageFile(name, suffix) {
  return path.join(fs.realpathSync(path.join(root, 'node_modules', name)), suffix);
}
const { streamAnthropic } = await import(pathToFileURL(packageFile('@earendil-works/pi-ai', 'dist/providers/anthropic.js')));
const { generateSummary, compact } = await import(pathToFileURL(packageFile('@earendil-works/pi-coding-agent', 'dist/core/compaction/compaction.js')));
const model = { id: 'claude-test', name: 'test', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Write a short summary of a harmless test conversation.' }], timestamp: 1 }];
let calls = 0;
function fakeClient(reason, text = '') {
  const events = [{ type: 'message_start', message: { id: 'test', type: 'message', role: 'assistant', model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  if (text) events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 });
  events.push({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: text ? 5 : 0 } }, { type: 'message_stop' });
  return { messages: { create() { calls++; return { asResponse: async () => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) }; } } };
}
for (const reason of ['refusal', 'sensitive']) {
  const start = calls;
  const client = fakeClient(reason);
  const result = await streamAnthropic(model, { messages }, { client }).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, `Anthropic response stopped: stop_reason=${reason}`);
  const streamFn = (m, context, options) => streamAnthropic(m, context, { ...options, client });
  await assert.rejects(generateSummary(messages, model, 1000, 'test', undefined, undefined, undefined, undefined, 'off', streamFn), new RegExp(`Summarization failed: .*stop_reason=${reason}`));
  assert.equal(calls - start, 2, 'Exactly one request per invocation; no retry on refusal');
}
const baseResult = { role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: model.id, usage: {}, timestamp: 1 };
function fixedStream(result) { return () => ({ result: async () => result }); }
for (const [stopReason, content, signal, message] of [
  ['aborted', [], undefined, /cancelled by caller/],
  ['stop', [], undefined, /empty summary/],
  ['stop', [{ type: 'text', text: '   ' }], undefined, /empty summary/],
  ['stop', [{ type: 'text', text: 'Partial summary must not be persisted' }], AbortSignal.abort(), /cancelled by caller/],
]) {
  const streamFn = fixedStream({ ...baseResult, stopReason, content });
  await assert.rejects(generateSummary(messages, model, 1000, 'test', undefined, signal, undefined, undefined, 'off', streamFn), message);
  // Prefix-only split-turn path must enforce the same guard.
  await assert.rejects(compact({
    messagesToSummarize: [], turnPrefixMessages: messages, isSplitTurn: true,
    previousSummary: undefined, firstKeptEntryId: 'keep', tokensBefore: 100,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { reserveTokens: 1000, keepRecentTokens: 100 },
  }, model, 'test', undefined, undefined, signal, 'off', streamFn), message);
}
const validSummary = await generateSummary(messages, model, 1000, 'test', undefined, undefined, undefined, undefined, 'off', (m, context, options) => streamAnthropic(m, context, { ...options, client: fakeClient('end_turn', 'Synthetic conversation summary.') }));
assert.equal(validSummary, 'Synthetic conversation summary.');
// Import the real OpenClaw entrypoint: pre-cancelled compaction must not even
// resolve the deliberately nonexistent provider or touch a transcript.
const candidates = fs.readdirSync(path.join(root, 'dist')).filter(f => /^compact-.*\.js$/.test(f)).map(f => path.join(root, 'dist', f)).filter(f => fs.readFileSync(f, 'utf8').includes('async function compactEmbeddedPiSessionDirect(params) {'));
assert.equal(candidates.length, 1);
const { compactEmbeddedPiSessionDirect } = await import(pathToFileURL(candidates[0]));
const result = await compactEmbeddedPiSessionDirect({ sessionId: 'test', sessionFile: '/DO-NOT-CREATE-TEST-SESSION.jsonl', workspaceDir: '/DO-NOT-CREATE-TEST-WORKSPACE', provider: 'nonexistent', model: 'none', abortSignal: AbortSignal.abort() });
assert.deepEqual(result, { ok: false, compacted: false, reason: 'Compaction cancelled by caller' });
{
  const dfiles = fs.readdirSync(path.join(root, 'dist')).filter(f => /^diagnostic-.*\.js$/.test(f)).map(f => path.join(root, 'dist', f)).filter(f => fs.readFileSync(f, 'utf8').includes('function formatPressureSummary(pressure)'));
  assert.equal(dfiles.length, 1, 'memory-pressure log backport present');
  const src = fs.readFileSync(dfiles[0], 'utf8');
  assert.ok(src.includes('nextStep=run openclaw gateway status --deep'));
  assert.ok(!src.includes('else log.info(message);'));
}
console.log('PASS: memory-pressure log backport present.');
console.log('PASS: real SSE refusal/sensitive diagnostics, no refusal retry, aborted/empty history and prefix summary rejected, normal summary preserved, real entrypoint pre-cancellation is cheap.');
