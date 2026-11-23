// Regression tests for the security and trust review (23 Nov 2026).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { client } = require('../src/confluence');
const { dryRun, apply, undo, buildCql } = require('../src/run');
const { planPage } = require('../src/plan');
const { DEFAULT_TARGET, cloudOfKey, buildMacro } = require('../src/target');
const F = require('./fixtures');

const SITE = 'https://example.atlassian.net';

function fake(pages, { onSave } = {}) {
  const store = new Map(pages.map((p) => [p.id, { ...p, history: [{ version: 1, storage: p.storage, title: p.title }] }]));
  const calls = [];
  const res = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (init.method === 'GET' && m) {
      const p = store.get(m[1]);
      const want = u.searchParams.get('version');
      const h = want ? p.history.find((x) => x.version === Number(want)) : p.history.at(-1);
      return res(200, { id: p.id, title: h.title, status: 'current', spaceId: '1', version: { number: h.version }, body: { storage: { value: h.storage } } });
    }
    const w = /^\/wiki\/rest\/api\/content\/(\d+)$/.exec(u.pathname);
    if (init.method === 'PUT' && w) {
      const p = store.get(w[1]);
      const b = JSON.parse(init.body);
      if (b.version.number !== p.history.at(-1).version + 1) return res(409, { message: 'conflict' });
      const stored = onSave ? onSave(b.body.storage.value) : b.body.storage.value;
      p.history.push({ version: b.version.number, storage: stored, title: b.title });
      return res(200, { version: { number: b.version.number } });
    }
    return res(400, { message: 'unexpected' });
  };
  return { store, calls, fetch };
}

function setup(pages, fakeOpts) {
  const f = fake(pages, fakeOpts);
  const lines = [];
  const io = { print: (l) => lines.push(l), now: () => new Date().toISOString(), sleep: async () => {}, redact: (s) => String(s) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pum-s-'));
  const base = { spaces: [], pages: pages.map((p) => p.id), macros: ['plantuml', 'power-plant-uml-macro', 'plantuml-svg'], limit: 25, pauseMs: 0, outDir: path.join(dir, 'out') };
  return { ...f, api: client({ site: SITE, fetch: f.fetch, sleep: async () => {} }), io, lines, dir, base };
}

const PAGE = { id: '41', title: 'Design', storage: `<p>Keep me.</p>${F.avono(F.SEQ)}<p>And me.</p>` };

test('a saved page whose text outside the macros changed stops the run', async () => {
  // Confluence stores the page differently AND drops a paragraph.
  const s = setup([PAGE, { ...PAGE, id: '42' }], { onSave: (v) => v.replace('<p>And me.</p>', '').replace('<ac:adf-attribute key="layout">default', '<ac:adf-attribute key="layout">default') + '' });
  const d = await dryRun(s.base, s.api, s.io);
  await assert.rejects(apply({ ...s.base, planFile: d.planFile }, s.api, s.io));
  assert.equal(s.store.get('42').history.length, 1, 'the next page is not touched');
  assert.ok(s.lines.some((l) => /characters outside the macros differ/.test(l)));
});

test('a saved page that only reorders the new macro passes', async () => {
  // As seen on the development site: Confluence reorders the new macro's own settings.
  const s = setup([PAGE], { onSave: (v) => v.replace('<ac:adf-parameter key="lang">plantuml</ac:adf-parameter><ac:adf-parameter key="theme">auto</ac:adf-parameter>', '<ac:adf-parameter key="theme">auto</ac:adf-parameter><ac:adf-parameter key="lang">plantuml</ac:adf-parameter>') });
  const d = await dryRun(s.base, s.api, s.io);
  const a = await apply({ ...s.base, planFile: d.planFile }, s.api, s.io);
  assert.equal(a.done, 1);
});

test('only our own app IDs are accepted as the new macro', async () => {
  assert.equal(cloudOfKey(DEFAULT_TARGET.extensionKey), 'Atlassian cloud');
  assert.equal(cloudOfKey('11111111-2222-4333-8444-555555555555/bb107a45-10e6-4725-8d3b-d33f28325771/static/plantuml-diagram'), null);
  const s = setup([PAGE]);
  const d = await dryRun(s.base, s.api, s.io);
  const plan = JSON.parse(fs.readFileSync(d.planFile, 'utf8'));
  plan.target.extensionKey = `11111111-2222-4333-8444-555555555555/${plan.target.extensionKey.split('/').slice(1).join('/')}`;
  const f = path.join(s.dir, 'other.json');
  fs.writeFileSync(f, JSON.stringify(plan));
  await assert.rejects(apply({ ...s.base, planFile: f }, s.api, s.io), /unexpected macro key/);
  // A reference page holding another app's PlantUML Diagram macro is refused.
  const other = { extensionKey: plan.target.extensionKey, title: 'PlantUML Diagram', environment: 'PRODUCTION' };
  const ref = { id: '43', title: 'Ref', storage: buildMacro('A -> B', other).xml };
  const s2 = setup([PAGE, ref]);
  await assert.rejects(dryRun({ ...s2.base, pages: ['41'], referencePage: '43' }, s2.api, s2.io), /not from the Eriksen Labs app/);
});

test('an undo log edited to name another page restores nothing', async () => {
  const other = { id: '44', title: 'Someone else', storage: '<p>never moved</p>' };
  const s = setup([PAGE, other]);
  const d = await dryRun({ ...s.base, pages: ['41'] }, s.api, s.io);
  const a = await apply({ ...s.base, pages: ['41'], planFile: d.planFile }, s.api, s.io);
  // The other page gets a second version, and the log is edited to point at it.
  const o = s.store.get('44');
  o.history.push({ version: 2, storage: '<p>edited</p>', title: o.title });
  const forged = fs.readFileSync(a.logFile, 'utf8').split('"pageId":"41"').join('"pageId":"44"');
  fs.writeFileSync(a.logFile, forged);
  await assert.rejects(undo({ ...s.base, undoLog: a.logFile, apply: true }, s.api, s.io));
  assert.equal(o.history.length, 2);
  // A write line with no intent is refused outright.
  const noIntent = fs.readFileSync(a.logFile, 'utf8').split('\n').filter((l) => !l.includes('"intent"')).join('\n');
  fs.writeFileSync(a.logFile, noIntent);
  await assert.rejects(undo({ ...s.base, undoLog: a.logFile, apply: false }, s.api, s.io), /not one this script wrote/);
});

test('503 is asked again for reads only; a save answered 503 stops', async () => {
  let n = 0;
  const api = client({ site: SITE, sleep: async () => {}, fetch: async () => (n++, { status: 503, headers: { get: () => null }, text: async () => '' }) });
  await assert.rejects(api.updatePage({ id: '1', title: 't', storage: '', fromVersion: 1, message: 'm' }), /HTTP 503/);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(api.getPage('1'), /HTTP 503/);
  assert.equal(n, 5);
});

test('PowerPlantUML: a language setting that may name another diagram type is left alone', () => {
  const p = (v) => F.power(F.SEQ, F.p('language', v));
  assert.equal(planPage(p('plantuml'), DEFAULT_TARGET).moves.length, 1);
  assert.equal(planPage(p(''), DEFAULT_TARGET).moves.length, 1);
  assert.equal(planPage(p('ditaa'), DEFAULT_TARGET).moves.length, 0);
});

test('titles cannot put links, pictures or HTML into the report', async () => {
  const s = setup([{ ...PAGE, title: 'Evil ![x](https://tracker.example/p.png) <img src=x> [link](https://e.example)' }]);
  const d = await dryRun(s.base, s.api, s.io);
  const report = fs.readFileSync(d.reportFile, 'utf8');
  const title = report.split('\n').find((l) => l.startsWith('## Page 41'));
  // Every markup character is escaped with a backslash, so nothing renders.
  assert.ok(!/(^|[^\\])(!\[|<img|\[link\]|\]\()/.test(title), title);
  assert.match(title, /\\!\\\[x\\\]\\\(/);
});

test('a second dry run into the same folder does not overwrite the plan', async () => {
  const s = setup([PAGE]);
  await dryRun(s.base, s.api, s.io);
  await assert.rejects(dryRun(s.base, s.api, s.io), /already exists/);
});

test('personal space keys with dots and at signs are allowed, quotes are not', () => {
  assert.match(buildCql({ spaces: ['~john.doe@example.com'], macros: ['plantuml'] }), /"~john\.doe@example\.com"/);
  assert.throws(() => buildCql({ spaces: ['a"b'], macros: ['plantuml'] }));
  assert.throws(() => buildCql({ spaces: ['a\\b'], macros: ['plantuml'] }));
});

test('command line: a stray argument is never echoed; --out is refused with --undo', () => {
  const bin = path.join(__dirname, '..', 'bin', 'confluence-plantuml-migrate.js');
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  let r = run(['--site', SITE, 'SECRET-TOKEN-PASTED-HERE']);
  assert.equal(r.status, 2);
  assert.ok(!r.stderr.includes('SECRET') && !r.stdout.includes('SECRET'));
  r = run(['--site', SITE, '--page', 'SECRET-TOKEN']);
  assert.ok(!r.stderr.includes('SECRET'));
  r = run(['--site', SITE, '--undo', 'x.jsonl', '--out', 'y']);
  assert.match(r.stderr, /--undo takes only/);
});
