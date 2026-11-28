/**
 * D9 (owner decision 2026-11-28, SCRUM-257 pilot defect D9): token budgets are PASSIVE TELEMETRY.
 * `config.budget` `{ticket_tokens?, phase_tokens?}` are estimates. The engine records the estimate, the actual
 * usage and the difference; token use never gates dispatch, admission, routing, retry, recovery, escalation or
 * completion, at 100% or 1,000% over the estimate, and no warning-shaped signal is emitted.
 *
 * (a) behaviour: a node, a phase and a repair whose usage is far over its estimate still dispatch and the run
 *     progresses (RED on de45b7b: `budget_stop`, exit 2, nothing dispatched);
 * (b) guard: no blocking or warning token-budget path exists in the engine sources or the policy docs, asserted on
 *     the positive shape of what remains (the telemetry keys, the only readers, the judgment table's codes);
 * (c) telemetry: estimate, actual and delta are still recorded and reported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSIX, fixture, codes, failReview } from './engine-test-fixture.mjs';
import { evaluateBudget } from './usage.mjs';

const WIN_SKIP = POSIX ? false : 'POSIX process groups: Windows quiescence is unknown, so attempts end in a judgment';
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..');
const REPO = join(SKILL, '..', '..');
const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? ''} ${r.stdout}${r.stderr}`);
const usageRow = (id, tokens, over = {}) => JSON.stringify({ provider: 'claude', run_id: 'run-1', role: 'orchestrator', source: 'session',
  source_execution_id: id, input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, ...over });
const importUsage = (fx, ...rows) => { mkdirSync(dirname(fx.usageFile()), { recursive: true }); writeFileSync(fx.usageFile(), rows.join('\n') + '\n'); };
/** Every judgment, status field or blocker a reader could take as a token alert. */
const tokenSignals = (out) => codes(out).filter(c => /budget|token/i.test(c));

// ------------------------------------------------------------------ (a) behaviour

test('D9 (a) ticket: usage at 1,100% of the ticket estimate still dispatches the node and the drive completes', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { config: { budget: { ticket_tokens: 100 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  importUsage(fx, usageRow('s:1', 1100));
  const r = fx.cli('drive');
  ok(r, 'a 10x overrun is not a stop');
  assert.equal(fx.runs('a').length, 1, 'the node was dispatched');
  assert.equal(fx.readState().nodes.a.state, 'done');
  assert.deepEqual(tokenSignals(r.out), []);
  assert.deepEqual(r.out.judgments, []);
});

test('D9 (a) phase: a BUILD phase far over its phase estimate dispatches every node (the SCRUM-257 shape)', { skip: WIN_SKIP }, (t) => {
  // Each fake worker reports 6 tokens; the phase estimate is 1, so b starts with BUILD at 600% and ends at 1,200%.
  const fx = fixture(t, { config: { budget: { ticket_tokens: 1, phase_tokens: 1 } },
    nodes: [{ id: 'a', writes: ['src/a.txt'] }, { id: 'b', deps: ['a'], writes: ['src/b.txt'] }],
    behaviour: { a: { write: { 'src/a.txt': 'a1' } }, b: { write: { 'src/b.txt': 'b1' } } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  importUsage(fx, usageRow('s:1', 1000, { phase: 'BUILD' }));
  const r = fx.cli('drive');
  ok(r);
  assert.deepEqual([fx.runs('a').length, fx.runs('b').length], [1, 1], 'both BUILD nodes ran');
  assert.deepEqual(Object.values(fx.readState().nodes).map(n => n.state), ['done', 'done']);
  assert.deepEqual(tokenSignals(r.out), []);
});

test('D9 (a) repair: a review repair dispatches with REVIEW usage 200% over the ticket estimate; its round is counted', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { commit: true, config: { budget: { ticket_tokens: 100, phase_tokens: 1 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  ok(fx.gate('review', failReview('rx-1', fx.candidate(), 'src/a.txt', fx.prompt('fix'))));
  importUsage(fx, usageRow('reviewer:1', 300, { role: 'reviewer', phase: 'REVIEW' }), usageRow('repair:1', 500, { role: 'orchestrator', phase: 'REPAIR' }));
  const r = fx.cli('drive');
  ok(r);
  assert.equal(fx.runs('fix').length, 1, 'the finding-bound repair was dispatched');
  assert.equal(r.out.rounds.review_repairs['rx-1'], 1, 'the bounded repair round (a non-token safeguard) still counts');
  assert.deepEqual(tokenSignals(r.out), []);
});

// ------------------------------------------------------------------ (c) telemetry

test('D9 (c) telemetry: status reports estimate, actual and delta; engine usage keeps role and source; unknown usage is recorded, not read as 0', { skip: WIN_SKIP }, (t) => {
  const fx = fixture(t, { config: { budget: { ticket_tokens: 2 } } });
  ok(fx.cli('init', { dag: fx.dagFile }));
  ok(fx.cli('drive'));
  const s = fx.cli('status').out;
  assert.deepEqual(s.budget, { ticket: { estimate: 2, used: 6, delta: 4 }, phase: null, usage_unknown: false });
  const rec = fx.readState().usage[0];
  assert.deepEqual([rec.role, rec.source, rec.phase, rec.input_tokens + rec.output_tokens], ['builder', 'engine', 'BUILD', 6]);
  importUsage(fx, JSON.stringify({ provider: 'codex', run_id: 'run-1', role: 'reviewer', source: 'codex', source_execution_id: 'relay-1',
    input_tokens: null, output_tokens: null, usage_status: 'unknown' }));
  const u = fx.cli('status');
  ok(u);
  assert.equal(u.out.budget.usage_unknown, true);
  assert.equal(u.out.budget.ticket.used, 6, 'unknown usage adds nothing it cannot know');
  assert.deepEqual(tokenSignals(u.out), []);
});

test('D9 (c) evaluateBudget is a measurement: estimate/used/delta at 1,000% over, and no state, threshold or verdict key', () => {
  const recs = [{ provider: 'claude', run_id: 'r', source: 'carrier', source_execution_id: 'b1', phase: 'BUILD', input_tokens: 6600, output_tokens: 0 },
    { provider: 'claude', run_id: 'r', source: 'carrier', source_execution_id: 'n1', input_tokens: 400, output_tokens: 0, in_flight: true }];
  const v = evaluateBudget(recs, { ticket_tokens: 700, phase_tokens: 600 }, { phase: 'BUILD' });
  assert.deepEqual(v, { schema: 'ship-ticket-budget-v2', metric: 'processed_tokens', used: 7000,
    ticket: { estimate: 700, used: 7000, delta: 6300 }, phase: { name: 'BUILD', estimate: 600, used: 6600, delta: 6000 },
    usage_unknown: false, in_flight_tokens: 400, phase_unknown: { records: 1, tokens: 400 } });
  assert.deepEqual(evaluateBudget(recs, {}).ticket, { estimate: null, used: 7000, delta: null }, 'no estimate: actual only');
});

// ------------------------------------------------------------------ (b) guard

const SOURCES = ['', 'lib', 'measure'].flatMap(d => readdirSync(join(HERE, d)).filter(f => f.endsWith('.mjs') && !/\.test(-helper)?\.mjs$|\.capture\./.test(f))
  .map(f => join(d, f)));
const src = (f) => readFileSync(join(HERE, f), 'utf8');

test('D9 (b) guard: token telemetry has exactly its passive readers, and no engine source carries a stop or warning token path', () => {
  assert.ok(SOURCES.includes('engine-attempts.mjs') && SOURCES.includes('wave.mjs') && SOURCES.includes('supervisor.mjs'), 'the scan sees the engine, wave and supervisor');
  // Positive: the only modules that read the telemetry are its definition, its engine accessor and the status view.
  const readers = SOURCES.filter(f => /\b(?:evaluateBudget|budgetVerdict)\b/.test(src(f))).sort();
  assert.deepEqual(readers, ['engine-attempts.mjs', 'run-engine.mjs', 'usage.mjs']);
  assert.match(src('run-engine.mjs'), /const budget = budgetVerdict\(E\);[\s\S]{0,1500}budget: budget && \{ ticket: budget\.ticket, phase: budget\.phase, usage_unknown: budget\.usage_unknown/,
    'the status view is the one consumer');
  // Inside the engine module, budgetVerdict is defined once and called by nothing (dispatch and repairs do not read it).
  assert.deepEqual(src('engine-attempts.mjs').match(/\bbudgetVerdict\b/g), ['budgetVerdict']);
  const attempts = src('engine-attempts.mjs');
  const dispatch = attempts.slice(attempts.indexOf('export async function dispatchNodes'), attempts.indexOf('/** The round counters'));
  assert.match(dispatch, /if \(!fits\(E, n, running\.keys\(\)\)\) continue;/, 'host/width/memory admission still gates dispatch');
  assert.doesNotMatch(dispatch, /budget|usage|token/i);
  const repairs = attempts.slice(attempts.indexOf('export async function runRepairs'));
  assert.match(repairs, /const auth = authorize\(S, r, batchOpen\);/, 'bounded repair authorization still gates repairs');
  assert.doesNotMatch(repairs.slice(0, repairs.indexOf('const onLaunch')), /budget|usage|token/i);
  const accepted = src('engine-accepted.mjs');
  assert.match(accepted, /D9: statusOut\.budget \(token estimate\/actual\/delta\) is passive telemetry and never a blocker/);
  assert.doesNotMatch(accepted, /statusOut\.budget\b(?!\s*\(token)/, 'the accepted view never reads the token telemetry');
  for (const f of SOURCES) {
    assert.doesNotMatch(src(f), /budget_stop|stop_dispatch|dispatch_allowed|budget_spent|budget_unknown|budget_unenforceable|budgetOk/, f);
  }
});

/** The judgment-code table of execution-harness.md: [codes, goes-to] per row. */
function judgmentTable(text) {
  const at = text.indexOf('| Judgment code | Goes to | Why |');
  assert.ok(at >= 0, 'the judgment table exists');
  return text.slice(at).split('\n').slice(2).filter(l => l.startsWith('|')).map(l => l.split('|').map(c => c.trim()))
    .map(c => [[...c[1].matchAll(/`([a-z_]+)`/g)].map(m => m[1]), c[2]]);
}

test('D9 (b) guard: policy docs say tokens never gate anything, and no judgment row or judgment list names a token code', () => {
  const harness = readFileSync(join(SKILL, 'references', 'execution-harness.md'), 'utf8');
  const rows = judgmentTable(harness);
  const all = rows.flatMap(([c]) => c);
  for (const c of ['round_limit', 'run_mismatch', 'ownership_violation', 'quiescence_unknown']) assert.ok(all.includes(c), c);
  assert.deepEqual(all.filter(c => /budget|token/.test(c)), []);
  const list = harness.slice(harness.indexOf('**Judgment points**'), harness.indexOf('**Token telemetry.**'));
  assert.match(list, /`round_limit`/);
  assert.doesNotMatch(list, /budget/);
  const NEVER = /Token usage never gates anything/;
  const docs = { harness, skill: readFileSync(join(SKILL, 'SKILL.md'), 'utf8'), plan: readFileSync(join(SKILL, 'references', 'plan.md'), 'utf8'),
    adaptive: readFileSync(join(REPO, 'docs', 'adaptive-execution.md'), 'utf8'), limits: readFileSync(join(REPO, 'docs', 'engine-guarantees-and-limits.md'), 'utf8') };
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, NEVER, name);
    assert.doesNotMatch(text, /budget_stop|stop_dispatch|budget_unenforceable|config\.budget[^.\n]{0,80}mandatory|budget is spent|spent budget|budget headroom|`config\.budget` headroom/i, name);
  }
});
