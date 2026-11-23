'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { client } = require('../src/confluence');
const { dryRun, apply, undo, buildCql, Stop } = require('../src/run');
const { findTargetMacros } = require('../src/target');
const F = require('./fixtures');

const SITE = 'https://example.atlassian.net';
const TOKEN = 'TEST-TOKEN-never-printed-123';

/**
 * A small fake of the four Confluence endpoints the script uses, with page
 * history, so a test can check what was written and what an undo restores.
 */
function fakeConfluence(pages, { edits = {}, failPut = null } = {}) {
  const store = new Map();
  for (const p of pages) store.set(p.id, { ...p, history: [{ version: 1, storage: p.storage, title: p.title }] });
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, auth: init.headers.Authorization, redirect: init.redirect, body: init.body });
    const json = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (u.origin !== SITE) throw new Error('wrong host');
    if (init.method === 'GET' && u.pathname === '/wiki/rest/api/content/search') {
      return json(200, { results: [...store.values()].filter((p) => p.history.at(-1).storage.includes('ac:name="plantuml"') || p.history.at(-1).storage.includes('power-plant')).map((p) => ({ id: p.id, type: 'page' })), _links: {} });
    }
    if (init.method === 'GET' && u.pathname === '/wiki/api/v2/spaces') return json(200, { results: [{ id: '100', key: u.searchParams.get('keys') }] });
    const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (init.method === 'GET' && m) {
      const p = store.get(m[1]);
      if (!p) return json(404, { message: 'not found' });
      if (edits[m[1]] && !p.edited) {
        p.edited = true;
        edits[m[1]](p);
      }
      const want = u.searchParams.get('version');
      const h = want ? p.history.find((x) => x.version === Number(want)) : p.history.at(-1);
      return json(200, { id: p.id, title: h.title, status: 'current', spaceId: '100', version: { number: h.version }, body: { storage: { value: h.storage } } });
    }
    const w = /^\/wiki\/rest\/api\/content\/(\d+)$/.exec(u.pathname);
    if (init.method === 'PUT' && w) {
      if (failPut) return json(failPut, { message: 'refused' });
      const p = store.get(w[1]);
      const b = JSON.parse(init.body);
      const cur = p.history.at(-1).version;
      if (b.version.number !== cur + 1) return json(409, { message: 'version conflict' });
      p.history.push({ version: b.version.number, storage: b.body.storage.value, title: b.title, message: b.version.message, minor: b.version.minorEdit });
      return json(200, { id: p.id, version: { number: b.version.number } });
    }
    return json(400, { message: `unexpected ${init.method} ${u.pathname}` });
  };
  return { store, calls, fetch };
}

function setup(pages, fakeOpts) {
  const fake = fakeConfluence(pages, fakeOpts);
  const api = client({ site: SITE, authHeader: `Basic ${Buffer.from(`a@example.com:${TOKEN}`).toString('base64')}`, fetch: fake.fetch, sleep: async () => {} });
  const lines = [];
  const io = { print: (l) => lines.push(l), now: () => '2026-11-23T00:00:00.000Z', sleep: async () => {}, redact: (s) => String(s).split(TOKEN).join('[token]') };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pum-'));
  const base = { spaces: ['DOCS'], pages: [], macros: ['plantuml', 'power-plant-uml-macro', 'plantuml-svg'], limit: 25, pauseMs: 0, outDir: dir, notify: false };
  return { fake, api, io, lines, dir, base };
}

const PAGE_A = { id: '11', title: 'Design', storage: `<p>Intro</p>${F.avono(F.SEQ, F.p('title', 'Greeting'))}<table><tbody><tr><td>${F.power(F.CLASS)}</td></tr></tbody></table>` };
const PAGE_B = { id: '12', title: 'Ops', storage: `<p>Only ditaa</p>${F.avono(F.DITAA, F.p('type', 'ditaa'))}` };

test('CQL is built from fixed names and checked space keys only', () => {
  assert.equal(buildCql({ spaces: ['DOCS', '~abc'], macros: ['plantuml'] }), 'type = page AND (macro = "plantuml") AND space in ("DOCS", "~abc") ORDER BY id');
  assert.throws(() => buildCql({ spaces: ['A" OR space = "B'], macros: ['plantuml'] }), /bad space key/);
  assert.throws(() => buildCql({ spaces: [], macros: ['code'] }), /unknown macro/);
});

test('dry run writes nothing to Confluence and plans exactly', async () => {
  const { fake, api, io, base, lines } = setup([PAGE_A, PAGE_B]);
  const r = await dryRun(base, api, io);
  assert.ok(fake.calls.every((c) => c.method === 'GET'), 'only GET requests');
  assert.equal(r.plan.pages.length, 1);
  assert.equal(r.plan.pages[0].moves.length, 2);
  const report = fs.readFileSync(r.reportFile, 'utf8');
  assert.match(report, /Before:/);
  assert.match(report, /Left alone: plantuml: type = ditaa/);
  assert.ok(report.includes(F.avono(F.SEQ, F.p('title', 'Greeting'))), 'the exact before is in the report');
  assert.ok(lines.some((l) => /Pages that would change: 1, with 2 macro/.test(l)));
  assert.ok(fake.calls.every((c) => c.redirect === 'error'));
});

test('apply follows the plan, saves minor edits, logs and checks; undo restores', async () => {
  const { fake, api, io, base } = setup([PAGE_A, PAGE_B]);
  const d = await dryRun(base, api, io);
  const a = await apply({ ...base, planFile: d.planFile }, api, io);
  assert.equal(a.done, 1);
  const page = fake.store.get('11');
  assert.equal(page.history.length, 2);
  assert.equal(page.history[1].minor, true);
  assert.match(page.history[1].message, /PlantUML macro move/);
  assert.deepEqual(findTargetMacros(page.history[1].storage).map((t) => t.source), [F.SEQ, F.CLASS]);
  assert.equal(fake.store.get('12').history.length, 1, 'the ditaa page is untouched');
  const log = fs.readFileSync(a.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((e) => e.type), ['start', 'intent', 'write', 'check', 'end']);
  assert.equal(log[2].versionBefore, 1);
  assert.equal(log[2].versionAfter, 2);
  assert.ok(!JSON.stringify(log).includes(TOKEN));

  // Undo: a dry run first writes nothing.
  const before = fake.calls.length;
  await undo({ ...base, undoLog: a.logFile, apply: false }, api, io);
  assert.ok(fake.calls.slice(before).every((c) => c.method === 'GET'));
  const u = await undo({ ...base, undoLog: a.logFile, apply: true }, api, io);
  assert.equal(u.done, 1);
  assert.equal(page.history.length, 3);
  assert.equal(page.history[2].storage, PAGE_A.storage, 'version 1 content restored exactly');
  // A second undo has nothing left to do.
  const again = await undo({ ...base, undoLog: a.logFile, apply: true }, api, io);
  assert.equal(again.done, 0);
});

test('a page edited between the dry run and the apply stops the run, writing nothing', async () => {
  const { fake, api, io, base } = setup([PAGE_A]);
  const d = await dryRun(base, api, io);
  // Someone saves the page after the dry run.
  const p = fake.store.get('11');
  p.history.push({ version: 2, storage: p.history[0].storage.replace('Intro', 'Intro, edited'), title: p.title });
  await assert.rejects(apply({ ...base, planFile: d.planFile }, api, io), Stop);
  assert.ok(!fake.calls.some((c) => c.method === 'PUT'));
});

test('a page saved between the read and the write gets a conflict, and the run stops', async () => {
  const { fake, api, io, base } = setup([PAGE_A]);
  const d = await dryRun(base, api, io);
  // On the apply's first read, someone saves the page right after.
  let reads = 0;
  const inner = fake.fetch;
  const racing = async (url, init) => {
    const r = await inner(url, init);
    if (init.method === 'GET' && url.includes('/api/v2/pages/11') && ++reads === 1) {
      const p = fake.store.get('11');
      p.history.push({ version: 2, storage: p.history[0].storage, title: p.title });
    }
    return r;
  };
  const api2 = client({ site: SITE, authHeader: 'Basic x', fetch: racing, sleep: async () => {} });
  await assert.rejects(apply({ ...base, planFile: d.planFile }, api2, io), Stop);
  assert.equal(fake.store.get('11').history.length, 2, 'only the other edit; ours was refused');
});

test('the first error stops the run; later pages are not touched', async () => {
  const pages = [PAGE_A, { ...PAGE_A, id: '13' }, { ...PAGE_A, id: '14' }];
  const { fake, api, io, base, lines } = setup(pages);
  const d = await dryRun(base, api, io);
  assert.equal(d.plan.pages.length, 3);
  // Page 13 loses edit permission after the dry run.
  const inner = fake.fetch;
  const api2 = client({
    site: SITE,
    authHeader: 'Basic x',
    sleep: async () => {},
    fetch: async (url, init) => (init.method === 'PUT' && url.endsWith('/13') ? { status: 403, headers: { get: () => null }, text: async () => '{"message":"no permission"}' } : inner(url, init)),
  });
  await assert.rejects(apply({ ...base, planFile: d.planFile }, api2, io), Stop);
  assert.equal(fake.store.get('11').history.length, 2);
  assert.equal(fake.store.get('13').history.length, 1);
  assert.equal(fake.store.get('14').history.length, 1);
  assert.ok(lines.some((l) => /Stopped after 1 page/.test(l)));
  assert.ok(lines.some((l) => /--undo/.test(l)));
});

test('limit: at most N pages are planned', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ ...PAGE_A, id: String(20 + i) }));
  const { api, io, base, lines } = setup(pages);
  const d = await dryRun({ ...base, limit: 2 }, api, io);
  assert.equal(d.plan.pages.length, 2);
  assert.ok(lines.some((l) => /Stopped at the limit of 2/.test(l)));
});

test('undo refuses a page edited after the move', async () => {
  const { fake, api, io, base } = setup([PAGE_A]);
  const d = await dryRun(base, api, io);
  const a = await apply({ ...base, planFile: d.planFile }, api, io);
  const p = fake.store.get('11');
  p.history.push({ version: 3, storage: p.history[1].storage + '<p>new</p>', title: p.title });
  await assert.rejects(undo({ ...base, undoLog: a.logFile, apply: true }, api, io), Stop);
  assert.equal(p.history.length, 3);
});

test('undo: the dry run lists edited pages; apply refuses them unless --skip-edited', async () => {
  const pages = [PAGE_A, { ...PAGE_A, id: '15' }];
  const { fake, api, io, base, lines } = setup(pages);
  const d = await dryRun(base, api, io);
  const a = await apply({ ...base, planFile: d.planFile }, api, io);
  const p = fake.store.get('15');
  p.history.push({ version: 3, storage: p.history[1].storage + '<p>new</p>', title: p.title });
  const dry = await undo({ ...base, undoLog: a.logFile, apply: false }, api, io);
  assert.deepEqual([dry.ready, dry.edited], [1, 1]);
  await assert.rejects(undo({ ...base, undoLog: a.logFile, apply: true }, api, io), /Nothing was written/);
  assert.equal(fake.store.get('11').history.length, 2, 'nothing restored while a page was edited');
  const u = await undo({ ...base, undoLog: a.logFile, apply: true, skipEdited: true }, api, io);
  assert.equal(u.done, 1);
  assert.equal(fake.store.get('11').history.at(-1).storage, PAGE_A.storage);
  assert.equal(p.history.length, 3, 'the edited page is left alone');
  assert.ok(lines.some((l) => /edited after the move, left alone: page 15/.test(l)));
});

test('a plan for another site is refused', async () => {
  const { api, io, base } = setup([PAGE_A]);
  const d = await dryRun(base, api, io);
  const other = client({ site: 'https://other.atlassian.net', fetch: async () => assert.fail('no request'), sleep: async () => {} });
  await assert.rejects(apply({ ...base, planFile: d.planFile }, other, io), /made for https:\/\/example.atlassian.net/);
});

test('a site outside atlassian.net needs a reference page', async () => {
  const api = client({ site: 'https://wiki.example.gov', fetch: async () => assert.fail('no request'), sleep: async () => {} });
  await assert.rejects(dryRun({ spaces: [], pages: ['1'], macros: ['plantuml'], limit: 1, outDir: os.tmpdir() }, api, { print() {}, now: () => '', redact: (s) => s }), /reference-page/);
});

test('the site address must be https with no path', () => {
  for (const bad of ['http://x.atlassian.net', 'https://x.atlassian.net/other', 'https://user@x.atlassian.net', 'x.atlassian.net', 'https://x.atlassian.net?a=1']) {
    assert.throws(() => client({ site: bad }), /--site/, bad);
  }
  assert.equal(client({ site: 'https://X.atlassian.net/wiki/' }).origin, 'https://x.atlassian.net');
});

test('429 is waited out; other errors are not retried', async () => {
  let n = 0;
  const api = client({
    site: SITE,
    sleep: async () => {},
    fetch: async () => (++n < 3 ? { status: 429, headers: { get: () => '1' }, text: async () => '' } : { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 5, title: 't', status: 'current', spaceId: 1, version: { number: 1 }, body: { storage: { value: '' } } }) }),
  });
  assert.equal((await api.getPage('5')).id, '5');
  assert.equal(n, 3);
  let m = 0;
  const api2 = client({ site: SITE, sleep: async () => {}, fetch: async () => (m++, { status: 500, headers: { get: () => null }, text: async () => '' }) });
  await assert.rejects(api2.getPage('5'), /HTTP 500/);
  assert.equal(m, 1);
});

test('command line: no token argument, no apply without a plan, token never printed', () => {
  const bin = path.join(__dirname, '..', 'bin', 'confluence-plantuml-migrate.js');
  const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  let r = run(['--site', SITE, '--space', 'X', '--token', TOKEN]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /never taken from the command line/);
  assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
  r = run(['--site', SITE, '--apply'], { CONFLUENCE_EMAIL: 'a@example.com', CONFLUENCE_API_TOKEN: TOKEN });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--apply needs --plan/);
  r = run(['--site', SITE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /say which pages/);
  r = run(['--site', SITE, '--space', 'X']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN/);
  r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dry run by default/i);
});

test('the source has no telemetry: one network call site, to the given site only', () => {
  const src = path.join(__dirname, '..', 'src');
  const files = [...fs.readdirSync(src).map((f) => path.join(src, f)), path.join(__dirname, '..', 'bin', 'confluence-plantuml-migrate.js')];
  const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/require\(['"](node:)?(https?|net|tls|dgram|dns|http2|child_process|worker_threads|cluster|inspector)['"]\)/.test(all), 'no network or process modules');
  assert.ok(!/\bimport\s*\(|\bimport\s+[\w{*]|\beval\s*\(|new\s+Function\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/.test(all), 'no dynamic imports or code from strings');
  const requires = [...all.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires.filter((r) => !r.startsWith('.')))].sort(), ['crypto', 'fs', 'path'], 'only these built-in modules');
  assert.equal((all.match(/doFetch\(/g) || []).length, 1, 'one fetch call');
  assert.ok(!/globalThis\.fetch\(|[^.\w]fetch\(/.test(all), 'fetch is only called through the client');
  assert.ok(!/https?:\/\/(?!your-site|example|x\.)[a-z]/i.test(all.replace(/https:\/\/your-site\.atlassian\.net/g, '')), 'no other web addresses');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies && !pkg.devDependencies, 'no dependencies');
});
