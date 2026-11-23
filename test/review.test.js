// Regression tests for the findings of the code review (23 Nov 2026).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { client } = require('../src/confluence');
const { dryRun, apply, undo, Stop } = require('../src/run');
const { planPage, checkSaved } = require('../src/plan');
const { DEFAULT_TARGET, findTargetMacros } = require('../src/target');
const { readLog } = require('../src/log');
const F = require('./fixtures');

const SITE = 'https://example.atlassian.net';

function fake(pages) {
  const store = new Map(pages.map((p) => [p.id, { ...p, history: [{ version: 1, storage: p.storage, title: p.title }] }]));
  const calls = [];
  const res = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (init.method === 'GET' && m) {
      const p = store.get(m[1]);
      if (!p || p.deleted) return res(404, { message: 'not found' });
      const want = u.searchParams.get('version');
      const h = want ? p.history.find((x) => x.version === Number(want)) : p.history.at(-1);
      return res(200, { id: p.id, title: h.title, status: 'current', spaceId: '1', version: { number: h.version }, body: { storage: { value: h.storage } } });
    }
    const w = /^\/wiki\/rest\/api\/content\/(\d+)$/.exec(u.pathname);
    if (init.method === 'PUT' && w) {
      const p = store.get(w[1]);
      const b = JSON.parse(init.body);
      if (b.version.number !== p.history.at(-1).version + 1) return res(409, { message: 'conflict' });
      p.history.push({ version: b.version.number, storage: b.body.storage.value, title: b.title });
      return res(200, { version: { number: b.version.number } });
    }
    return res(400, { message: 'unexpected' });
  };
  return { store, calls, api: client({ site: SITE, fetch, sleep: async () => {} }) };
}

function setup(pages) {
  const f = fake(pages);
  const lines = [];
  const io = { print: (l) => lines.push(l), now: () => new Date().toISOString(), sleep: async () => {}, redact: (s) => String(s) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pum-r-'));
  const base = { spaces: [], pages: pages.map((p) => p.id), macros: ['plantuml', 'power-plant-uml-macro', 'plantuml-svg'], limit: 25, pauseMs: 0, outDir: dir };
  return { ...f, io, lines, dir, base };
}

const MIXED = { id: '31', title: 'Mixed', storage: `${F.avono(F.SEQ)}<p>x</p>${F.grovr(F.CLASS)}` };

test('--macro restricts what is moved, in the dry run and in the apply', async () => {
  const r = planPage(MIXED.storage, DEFAULT_TARGET, { only: ['plantuml'] });
  assert.deepEqual(r.moves.map((m) => m.name), ['plantuml']);
  assert.ok(r.storage.includes('ac:name="plantuml-svg"'), 'the other old macro is untouched');
  const s = setup([MIXED]);
  const d = await dryRun({ ...s.base, macros: ['plantuml'] }, s.api, s.io);
  assert.equal(d.plan.pages[0].moves.length, 1);
  await apply({ ...s.base, planFile: d.planFile }, s.api, s.io);
  const saved = s.store.get('31').history.at(-1).storage;
  assert.equal(findTargetMacros(saved).length, 1);
  assert.ok(saved.includes(F.grovr(F.CLASS)));
});

test('a page given twice with --page is planned once', async () => {
  const s = setup([MIXED]);
  const d = await dryRun({ ...s.base, pages: ['31', '31'] }, s.api, s.io);
  assert.equal(d.plan.pages.length, 1);
});

test('a plan edited by hand is checked: no page twice, no empty page, a sane target', async () => {
  const s = setup([MIXED]);
  const d = await dryRun(s.base, s.api, s.io);
  const plan = JSON.parse(fs.readFileSync(d.planFile, 'utf8'));
  const write = (p) => {
    const f = path.join(s.dir, `edited-${Math.random()}.json`);
    fs.writeFileSync(f, JSON.stringify(p));
    return f;
  };
  await assert.rejects(apply({ ...s.base, planFile: write({ ...plan, pages: [plan.pages[0], plan.pages[0]] }) }, s.api, s.io), /twice/);
  await assert.rejects(apply({ ...s.base, planFile: write({ ...plan, pages: [{ ...plan.pages[0], moves: [] }] }) }, s.api, s.io), /badly/);
  await assert.rejects(apply({ ...s.base, planFile: write({ ...plan, target: { ...plan.target, environment: 'x"y' } }) }, s.api, s.io), /unexpected/);
  assert.ok(!s.calls.some((c) => c.startsWith('PUT')));
});

test('undo restores a page whose save happened but whose write line was lost', async () => {
  const s = setup([MIXED]);
  const d = await dryRun(s.base, s.api, s.io);
  const a = await apply({ ...s.base, planFile: d.planFile }, s.api, s.io);
  // Cut the log after the intent, as a kill during the save would.
  const lines = fs.readFileSync(a.logFile, 'utf8').trim().split('\n');
  fs.writeFileSync(a.logFile, `${lines.slice(0, 2).join('\n')}\n{"type":"wri`);
  const u = await undo({ ...s.base, undoLog: a.logFile, apply: true }, s.api, s.io);
  assert.equal(u.done, 1);
  assert.equal(s.store.get('31').history.at(-1).storage, MIXED.storage);
  assert.ok(s.lines.some((l) => /the save happened/.test(l)));
  assert.ok(s.lines.some((l) => /last line .* is incomplete/.test(l)));
});

test('undo: an intent whose save did not happen is left for a person', async () => {
  const s = setup([MIXED]);
  const d = await dryRun(s.base, s.api, s.io);
  const a = await apply({ ...s.base, planFile: d.planFile }, s.api, s.io);
  const lines = fs.readFileSync(a.logFile, 'utf8').trim().split('\n');
  fs.writeFileSync(a.logFile, `${lines.slice(0, 2).join('\n')}\n`);
  // The page is back at its first content, as if the save never happened.
  const p = s.store.get('31');
  p.history.pop();
  const u = await undo({ ...s.base, undoLog: a.logFile, apply: true }, s.api, s.io);
  assert.equal(u.done, 0);
  assert.ok(s.lines.some((l) => /check by hand: page 31/.test(l)));
});

test('a bad line in the middle of a log stops; only the last may be cut short', () => {
  const f = path.join(os.tmpdir(), `pum-log-${Date.now()}.jsonl`);
  fs.writeFileSync(f, '{"type":"start"}\n{bad\n{"type":"end"}\n');
  assert.throws(() => readLog(f), /line 2/);
});

test('undo with a deleted page: listed, nothing written without --skip-edited', async () => {
  const s = setup([MIXED, { ...MIXED, id: '32' }]);
  const d = await dryRun(s.base, s.api, s.io);
  const a = await apply({ ...s.base, planFile: d.planFile }, s.api, s.io);
  s.store.get('32').deleted = true;
  const dry = await undo({ ...s.base, undoLog: a.logFile, apply: false }, s.api, s.io);
  assert.deepEqual([dry.ready, dry.edited], [1, 1]);
  await assert.rejects(undo({ ...s.base, undoLog: a.logFile, apply: true }, s.api, s.io), Stop);
  assert.equal(s.store.get('31').history.length, 2);
  const u = await undo({ ...s.base, undoLog: a.logFile, apply: true, skipEdited: true }, s.api, s.io);
  assert.equal(u.done, 1);
  assert.ok(s.lines.some((l) => /cannot be read, left alone: page 32/.test(l)));
});

test('checkSaved ignores an id or schema version Confluence adds to another macro', () => {
  const info = '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>';
  const r = planPage(`${info}${F.avono(F.SEQ)}`, DEFAULT_TARGET);
  const saved = r.storage.replace('<ac:structured-macro ac:name="info">', '<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="abc">');
  assert.equal(checkSaved(r.storage, saved, r.moves, DEFAULT_TARGET).ok, true);
  assert.equal(checkSaved(r.storage, saved.replace('<p>x</p>', '<p>y</p>'), r.moves, DEFAULT_TARGET).ok, false);
});
