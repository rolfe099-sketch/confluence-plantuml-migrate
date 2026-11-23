// The three things the script does: a dry run (the default), an apply of a
// reviewed dry run, and an undo from a change log.
'use strict';

const fs = require('fs');
const path = require('path');
const { planPage, checkSaved, sha256 } = require('./plan');
const { SUPPORTED, RULES } = require('./rules');
const { DEFAULT_TARGET, targetFromReference, KEY_RE } = require('./target');
const { StorageError } = require('./storage');
const { openLog, readLog } = require('./log');

const TOOL = 'confluence-plantuml-migrate';
const VERSION = require('../package.json').version;
const PLAN_FORMAT = 1;

class Stop extends Error {}

const SPACE_KEY_RE = /^~?[A-Za-z0-9_-]{1,255}$/;

function buildCql({ spaces, macros }) {
  for (const k of spaces) if (!SPACE_KEY_RE.test(k)) throw new Error(`bad space key: ${k}`);
  for (const m of macros) if (!SUPPORTED.includes(m)) throw new Error(`unknown macro name: ${m}`);
  const macroPart = macros.map((m) => `macro = "${m}"`).join(' OR ');
  const spacePart = spaces.length ? ` AND space in (${spaces.map((k) => `"${k}"`).join(', ')})` : '';
  return `type = page AND (${macroPart})${spacePart} ORDER BY id`;
}

async function resolveTarget(api, opts) {
  if (opts.referencePage) {
    const p = await api.getPage(opts.referencePage);
    if (!p.storage) throw new Stop(`reference page ${opts.referencePage} has no storage body`);
    return targetFromReference(p.storage, opts.referencePage);
  }
  if (!/\.atlassian\.net$/.test(new URL(api.origin).host)) {
    throw new Stop('this site is not on atlassian.net (an Isolated or Government Cloud site, or a custom domain): give --reference-page, a page where you inserted one PlantUML Diagram macro');
  }
  return { ...DEFAULT_TARGET };
}

function pageLink(origin, id) {
  return `${origin}/wiki/pages/viewpage.action?pageId=${id}`;
}

/** Dry run: finds pages, plans each, writes plan.json and report.md. Writes nothing to Confluence. */
async function dryRun(opts, api, io) {
  const target = await resolveTarget(api, opts);
  io.print(`Dry run on ${api.origin}. Nothing will be written to Confluence.`);
  io.print(`New macro: ${target.title} (${target.environment}), key from ${target.from}.`);
  const spaceIds = new Set();
  for (const k of opts.spaces) {
    const s = await api.getSpaceByKey(k);
    if (!s) throw new Stop(`space ${k} not found, or the token's user cannot see it`);
    spaceIds.add(s.id);
  }
  const ids = [];
  if (opts.pages.length) ids.push(...new Set(opts.pages));
  const pages = [];
  const unreadable = [];
  const tally = { looked: 0, skippedMacros: 0, otherMacros: 0 };
  let limitReached = false;
  const consider = async (id) => {
    const p = await api.getPage(id);
    tally.looked++;
    if (spaceIds.size && !spaceIds.has(p.spaceId)) {
      io.print(`- page ${id} is not in the given spaces: left out`);
      return;
    }
    if (p.status !== 'current' || p.storage == null) {
      io.print(`- page ${id} "${p.title}" is ${p.status}: left out`);
      return;
    }
    let plan;
    try {
      plan = planPage(p.storage, target, { only: opts.macros });
    } catch (e) {
      // Any problem planning one page leaves that page out; it never stops the dry run.
      const why = e instanceof StorageError ? `storage not readable by this script (${e.message})` : `not planned (${e.message})`;
      unreadable.push({ id, title: p.title, reason: why });
      io.print(`- page ${id} "${p.title}": ${why}: left out`);
      return;
    }
    tally.skippedMacros += plan.skipped.length;
    tally.otherMacros += plan.others.length;
    if (!plan.moves.length && !plan.skipped.length && !plan.others.length) return;
    pages.push({ id, title: p.title, spaceId: p.spaceId, version: p.version, link: pageLink(api.origin, id), ...plan, storage: undefined });
  };
  if (ids.length) {
    for (const id of ids) {
      if (pages.filter((x) => x.moves.length).length >= opts.limit) {
        limitReached = true;
        break;
      }
      await consider(id);
    }
  } else {
    const cql = buildCql({ spaces: opts.spaces, macros: opts.macros });
    io.print(`Search: ${cql}`);
    let cursor = null;
    const seen = new Set();
    outer: do {
      const r = await api.search(cql, cursor);
      for (const hit of r.results) {
        const id = String(hit.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (pages.filter((x) => x.moves.length).length >= opts.limit) {
          limitReached = true;
          break outer;
        }
        await consider(id);
      }
      cursor = r.next;
    } while (cursor);
  }

  const withMoves = pages.filter((p) => p.moves.length);
  const plan = {
    tool: TOOL,
    toolVersion: VERSION,
    planFormat: PLAN_FORMAT,
    createdAt: io.now(),
    site: api.origin,
    target,
    macros: opts.macros,
    pages: withMoves.map((p) => ({
      id: p.id,
      title: p.title,
      spaceId: p.spaceId,
      version: p.version,
      moves: p.moves.map((m) => ({ name: m.name, textSha256: m.textSha256, textLength: m.textLength, beforeSha256: sha256(m.before) })),
    })),
  };
  fs.mkdirSync(opts.outDir, { recursive: true });
  const planFile = path.join(opts.outDir, 'plan.json');
  const reportFile = path.join(opts.outDir, 'report.md');
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  const report = renderReport({ origin: api.origin, target, pages, unreadable, tally, limitReached, limit: opts.limit });
  fs.writeFileSync(reportFile, report);
  if (opts.verbose) io.print(report);
  const moveCount = withMoves.reduce((n, p) => n + p.moves.length, 0);
  io.print('');
  io.print(`Pages looked at: ${tally.looked}. Pages that would change: ${withMoves.length}, with ${moveCount} macro(s) moved.`);
  io.print(`Macros left alone: ${tally.skippedMacros} (reasons in the report). Other PlantUML-like macros seen, not touched: ${tally.otherMacros}.`);
  if (unreadable.length) io.print(`Pages whose storage this script could not read, left out: ${unreadable.length}.`);
  if (limitReached) io.print(`Stopped at the limit of ${opts.limit} pages. Run again with a higher --limit, or after applying these, to find more.`);
  io.print(`Report, with the exact before and after of every macro: ${reportFile}`);
  io.print(`Plan for --apply: ${planFile}`);
  return { plan, planFile, reportFile, pages };
}

function renderReport({ origin, target, pages, unreadable, tally, limitReached, limit }) {
  const L = [];
  L.push(`# PlantUML macro move: dry run`, '');
  L.push(`- Site: ${origin}`);
  L.push(`- New macro: ${target.title}, environment ${target.environment}, key \`${target.extensionKey}\` (from ${target.from})`);
  L.push(`- Pages looked at: ${tally.looked}${limitReached ? ` (stopped at the limit of ${limit} pages that would change)` : ''}`);
  L.push('', 'Nothing has been written. Each "after" below gets a new random id when applied; everything else is exactly what will be saved.', '');
  for (const p of pages) {
    L.push(`## Page ${p.id}: ${p.title}`, '', `- Link: ${p.link}`, `- Version now: ${p.version}`);
    if (p.moves.length) L.push(`- Would save version ${p.version + 1}, moving ${p.moves.length} macro(s). Nothing else on the page changes.`);
    L.push('');
    p.moves.forEach((m, k) => {
      L.push(`### Move ${k + 1}: \`${m.name}\` (${RULES[m.name].app})`, '');
      L.push(`- Diagram text: ${m.textLength} characters, SHA-256 ${m.textSha256}, kept exactly.`);
      if (m.ignoredParams.length) L.push(`- Settings not carried over: ${m.ignoredParams.join(', ')}`);
      for (const w of m.warnings) L.push(`- Note: ${w}`);
      L.push('', 'Before:', '', fence(m.before), '', 'After:', '', fence(m.after), '');
    });
    for (const s of p.skipped) L.push(`- Left alone: \`${s.name}\`: ${s.reason}`, '', fence(s.before), '');
    for (const o of p.others) L.push(`- Seen, not a macro this script moves: \`${o.name}\``);
    L.push('');
  }
  for (const u of unreadable) L.push(`- Page ${u.id} "${u.title}": storage not readable by this script (${u.reason}); left out.`);
  return `${L.join('\n')}\n`;
}

function fence(text) {
  let f = '```';
  while (text.includes(f)) f += '`';
  return `${f}xml\n${text}\n${f}`;
}

/** Applies a reviewed plan, one page at a time, stopping at the first problem. */
async function apply(opts, api, io) {
  const plan = JSON.parse(fs.readFileSync(opts.planFile, 'utf8'));
  if (plan.tool !== TOOL || plan.planFormat !== PLAN_FORMAT) throw new Stop(`${opts.planFile} is not a plan made by this version of the script`);
  if (plan.site !== api.origin) throw new Stop(`the plan was made for ${plan.site}, not ${api.origin}`);
  const target = plan.target;
  if (!target || !KEY_RE.test(target.extensionKey) || typeof target.title !== 'string' || !/^[A-Z_]+$/.test(String(target.environment))) throw new Stop('the plan names an unexpected macro key, title or environment');
  if (!Array.isArray(plan.macros) || !plan.macros.every((m) => SUPPORTED.includes(m))) throw new Stop('the plan names unexpected macros');
  if (!Array.isArray(plan.pages) || plan.pages.some((pp) => !/^\d+$/.test(String(pp.id)) || !Array.isArray(pp.moves) || !pp.moves.length)) throw new Stop('the plan lists a page badly');
  if (new Set(plan.pages.map((pp) => String(pp.id))).size !== plan.pages.length) throw new Stop('the plan lists a page twice');
  const pages = plan.pages.slice(0, opts.limit);
  fs.mkdirSync(opts.outDir, { recursive: true });
  const logFile = path.join(opts.outDir, `changes-${io.now().replace(/[:.]/g, '-')}.jsonl`);
  if (fs.existsSync(logFile)) throw new Stop(`${logFile} already exists`);
  const log = openLog(logFile);
  log.write({ type: 'start', tool: TOOL, toolVersion: VERSION, site: api.origin, plan: path.resolve(opts.planFile), target, pages: pages.length });
  io.print(`Applying ${pages.length} page(s) of ${opts.planFile} on ${api.origin}. Log: ${logFile}`);
  let done = 0;
  try {
    for (const [i, pp] of pages.entries()) {
      const p = await api.getPage(pp.id);
      if (p.status !== 'current' || p.storage == null) throw new Stop(`page ${pp.id} is now ${p.status}`);
      if (p.version !== pp.version) throw new Stop(`page ${pp.id} "${p.title}" was edited since the dry run (version ${pp.version}, now ${p.version}). Nothing was written to it. Run the dry run again.`);
      const fresh = planPage(p.storage, target, { only: plan.macros });
      if (!fresh.moves.length) throw new Stop(`page ${pp.id}: nothing to move any more. Nothing was written to it. Run the dry run again.`);
      const same = fresh.moves.length === pp.moves.length && fresh.moves.every((m, k) => m.name === pp.moves[k].name && m.textSha256 === pp.moves[k].textSha256 && sha256(m.before) === pp.moves[k].beforeSha256);
      if (!same) throw new Stop(`page ${pp.id}: what would change differs from the dry run. Nothing was written to it. Run the dry run again.`);
      log.write({ type: 'intent', pageId: pp.id, title: p.title, versionBefore: p.version, moves: fresh.moves.map((m) => ({ name: m.name, textSha256: m.textSha256, localId: m.localId })) });
      const message = `PlantUML macro move: ${fresh.moves.length} macro(s) to ${target.title} (${TOOL} ${VERSION})`;
      const r = await api.updatePage({ id: pp.id, title: p.title, storage: fresh.storage, fromVersion: p.version, message, minorEdit: !opts.notify });
      const versionAfter = r.version || p.version + 1;
      log.write({ type: 'write', pageId: pp.id, title: p.title, versionBefore: p.version, versionAfter });
      done++;
      const saved = await api.getPage(pp.id);
      const check = saved.version === versionAfter ? checkSaved(fresh.storage, saved.storage, fresh.moves, target) : { ok: false, reason: `the page is at version ${saved.version}, expected ${versionAfter}` };
      log.write({ type: 'check', pageId: pp.id, ok: check.ok, identical: !!check.identical, reason: check.reason });
      if (!check.ok) throw new Stop(`page ${pp.id}: the saved page did not pass the check (${check.reason}). Undo this run with --undo ${logFile}.`);
      io.print(`  ${i + 1}/${pages.length} page ${pp.id} "${p.title}": version ${p.version} -> ${versionAfter}, ${fresh.moves.length} macro(s) moved, checked.`);
      if (i < pages.length - 1) await io.sleep(opts.pauseMs);
    }
  } catch (e) {
    log.write({ type: 'stop', error: io.redact(e.message) });
    log.close();
    io.print(`Stopped after ${done} page(s): ${io.redact(e.message)}`);
    if (done) io.print(`To undo the ${done} page(s) changed so far: --undo ${logFile} (dry run first, then add --apply).`);
    throw new Stop('stopped', { cause: e });
  }
  log.write({ type: 'end', pages: done });
  log.close();
  io.print(`Done: ${done} page(s) changed. To undo them: --undo ${logFile} (dry run first, then add --apply).`);
  if (plan.pages.length > pages.length) io.print(`${plan.pages.length - pages.length} page(s) of the plan were not applied because of --limit.`);
  return { done, logFile };
}

/** Restores the versions saved before a run. Dry run unless opts.apply. */
async function undo(opts, api, io) {
  const entries = readLog(opts.undoLog, io);
  const start = entries.find((e) => e.type === 'start');
  if (!start || start.tool !== TOOL) throw new Stop(`${opts.undoLog} is not a log made by this script`);
  if (start.site !== api.origin) throw new Stop(`the log is for ${start.site}, not ${api.origin}`);
  const writes = entries.filter((e) => e.type === 'write').map((w) => ({ ...w }));
  const written = new Set(writes.map((w) => `${w.pageId}@${w.versionBefore}`));
  // An intent with no write line: the run was cut off while saving. If the
  // page is at the next version and holds the new macros logged in the
  // intent, the save happened, and the page is restored like the others.
  for (const it of entries.filter((e) => e.type === 'intent' && !written.has(`${e.pageId}@${e.versionBefore}`))) {
    let p = null;
    try {
      p = await api.getPage(it.pageId);
    } catch {
      /* reported below */
    }
    const ids = (it.moves || []).map((m) => m.localId).filter(Boolean);
    if (p && p.storage && p.version === it.versionBefore + 1 && ids.length && ids.every((id) => p.storage.includes(id))) {
      io.print(`  page ${it.pageId} "${it.title}": the run was cut off while saving it, but the save happened (version ${p.version}); it is restored like the others.`);
      writes.push({ type: 'write', pageId: it.pageId, title: it.title, versionBefore: it.versionBefore, versionAfter: it.versionBefore + 1 });
    } else {
      io.print(`  check by hand: page ${it.pageId} "${it.title}". The run was cut off while saving it, and this script cannot tell whether the save happened. If its history shows a "PlantUML macro move" version after ${it.versionBefore}, restore version ${it.versionBefore}.`);
    }
  }
  const undoFile = `${opts.undoLog}.undo.jsonl`;
  const already = new Set(fs.existsSync(undoFile) ? readLog(undoFile, io).filter((e) => e.type === 'undone').map((e) => `${e.pageId}@${e.versionAfter}`) : []);
  const todo = writes.filter((w) => !already.has(`${w.pageId}@${w.versionAfter}`)).reverse();
  io.print(`${opts.apply ? 'Undo' : 'Undo dry run (nothing will be written)'} on ${api.origin}: ${todo.length} page(s) to restore${already.size ? `, ${already.size} already restored` : ''}.`);
  // Look at every page first, so nothing is written while any page has a
  // problem (unless --skip-edited says to leave such pages out).
  const ready = [];
  const blocked = [];
  for (const w of todo) {
    let p;
    try {
      p = await api.getPage(w.pageId);
    } catch (e) {
      blocked.push(w);
      io.print(`  cannot be read, left alone: page ${w.pageId} "${w.title}" (${io.redact(e.message)}). It may have been deleted or moved to the trash.`);
      continue;
    }
    if (p.status !== 'current' || p.version !== w.versionAfter) {
      blocked.push(w);
      const what = p.status !== 'current' ? `${p.status}, left alone` : 'edited after the move, left alone';
      io.print(`  ${what}: page ${w.pageId} "${p.title}" (version ${w.versionAfter} then, ${p.version} now). Restore version ${w.versionBefore} by hand from its page history if you still want it.`);
      continue;
    }
    const old = await api.getPage(w.pageId, w.versionBefore);
    if (old.version !== w.versionBefore || old.storage == null) throw new Stop(`could not read version ${w.versionBefore} of page ${w.pageId}`);
    ready.push(w);
    io.print(`  ${opts.apply ? 'will restore' : 'would restore'} page ${w.pageId} "${p.title}" to the content of version ${w.versionBefore} (as version ${p.version + 1})`);
  }
  if (!opts.apply) {
    io.print(blocked.length ? `Add --apply to restore them; with ${blocked.length} page(s) left alone, also --skip-edited.` : 'Add --apply to restore them.');
    return { done: 0, ready: ready.length, edited: blocked.length };
  }
  if (blocked.length && !opts.skipEdited) throw new Stop(`${blocked.length} page(s) were edited, deleted or cannot be read since the move. Nothing was written. Add --skip-edited to restore the others and leave those alone.`);
  const log = openLog(undoFile);
  log.write({ type: 'start', tool: TOOL, toolVersion: VERSION, site: api.origin, of: path.resolve(opts.undoLog) });
  for (const e of blocked) log.write({ type: 'skipped-edited', pageId: e.pageId, versionAfter: e.versionAfter });
  let done = 0;
  try {
    for (const [i, w] of ready.entries()) {
      // Read again just before writing: the version in the write makes
      // Confluence refuse the save if the page changed after this read.
      const p = await api.getPage(w.pageId);
      if (p.status !== 'current' || p.version !== w.versionAfter) throw new Stop(`page ${w.pageId} "${p.title}" changed a moment ago (now version ${p.version}, ${p.status}). Nothing was written to it.`);
      const old = await api.getPage(w.pageId, w.versionBefore);
      log.write({ type: 'intent', pageId: w.pageId, versionNow: p.version, restores: w.versionBefore });
      const r = await api.updatePage({ id: w.pageId, title: p.title, storage: old.storage, fromVersion: p.version, message: `Undo PlantUML macro move: content of version ${w.versionBefore} (${TOOL} ${VERSION})`, minorEdit: !opts.notify });
      const v = r.version || p.version + 1;
      log.write({ type: 'undone', pageId: w.pageId, versionAfter: w.versionAfter, restored: w.versionBefore, version: v });
      done++;
      const saved = await api.getPage(w.pageId);
      const check = checkSaved(old.storage, saved.storage, [], { extensionKey: '' });
      log.write({ type: 'check', pageId: w.pageId, ok: check.ok, identical: !!check.identical, reason: check.reason });
      if (!check.ok) throw new Stop(`page ${w.pageId}: the restored page did not pass the check (${check.reason}). Look at its history.`);
      io.print(`  ${i + 1}/${ready.length} page ${w.pageId} "${p.title}": restored the content of version ${w.versionBefore} as version ${v}, checked.`);
      if (i < ready.length - 1) await io.sleep(opts.pauseMs);
    }
  } catch (e) {
    log.write({ type: 'stop', error: io.redact(e.message) });
    log.close();
    io.print(`Stopped after ${done} page(s): ${io.redact(e.message)}`);
    throw new Stop('stopped', { cause: e });
  }
  log.write({ type: 'end', pages: done });
  log.close();
  io.print(`Done: ${done} page(s) restored.${blocked.length ? ` ${blocked.length} page(s) left alone.` : ''}`);
  return { done };
}

module.exports = { dryRun, apply, undo, buildCql, Stop, TOOL, VERSION };
