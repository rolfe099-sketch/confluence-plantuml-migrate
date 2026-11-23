// What a page would become: the rewrite of one page's storage, and the
// checks that prove a rewrite (or a saved page) changed only the macros.
'use strict';

const crypto = require('crypto');
const { findMacros } = require('./storage');
const { assess, looksLikePlantUml, RULES } = require('./rules');
const { buildMacro, findTargetMacros } = require('./target');

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Plans the rewrite of one page.
 * @param {string} storage the page's storage format
 * @param {{extensionKey:string,title:string,environment:string}} target
 * @param {{newId?:()=>string}} [opts] newId is for tests only
 * @returns {{moves:Array, skipped:Array, others:Array, storage:string|null}}
 *   storage is the new storage, or null when nothing moves.
 */
function planPage(storage, target, opts = {}) {
  const macros = findMacros(storage);
  const moves = [];
  const skipped = [];
  const others = [];
  // Only outermost known macros are moved. A known macro inside another
  // macro (an expand, a section) is fine: its own span is replaced, and the
  // macro around it keeps every other character. A known macro inside a
  // known macro cannot happen with plain-text bodies, but is refused anyway.
  for (const m of macros) {
    if (!Object.prototype.hasOwnProperty.call(RULES, m.name)) {
      if (looksLikePlantUml(m.name)) others.push({ name: m.name, start: m.start });
      continue;
    }
    const inside = macros.find((o) => o !== m && Object.prototype.hasOwnProperty.call(RULES, o.name) && o.start < m.start && m.end <= o.end);
    if (inside) {
      skipped.push({ name: m.name, start: m.start, reason: `inside another ${inside.name} macro`, before: m.raw });
      continue;
    }
    const a = assess(m);
    if (!a.ok) {
      skipped.push({ name: m.name, start: m.start, reason: a.reason, before: m.raw });
      continue;
    }
    const built = buildMacro(a.text, target, opts.newId ? opts.newId() : undefined);
    moves.push({
      name: m.name,
      form: m.form,
      start: m.start,
      end: m.end,
      before: m.raw,
      after: built.xml,
      localId: built.localId,
      text: a.text,
      textSha256: sha256(a.text),
      textLength: a.text.length,
      ignoredParams: a.ignored,
      warnings: a.warnings,
    });
  }
  if (!moves.length) return { moves, skipped, others, storage: null };
  let out = '';
  let at = 0;
  for (const mv of moves) {
    out += storage.slice(at, mv.start) + mv.after;
    at = mv.end;
  }
  out += storage.slice(at);
  const check = checkRewrite(storage, out, moves);
  if (!check.ok) throw new Error(`internal check failed: ${check.reason}`);
  return { moves, skipped, others, storage: out };
}

/**
 * Proves that `after` is `before` with exactly the planned macros replaced:
 * every character outside them is the same, and each new macro holds its
 * old macro's text, character for character, read back by the parser.
 */
function checkRewrite(before, after, moves) {
  const found = findTargetMacros(after);
  const byId = new Map(found.map((f) => [f.localId, f]));
  // Characters outside the macros.
  let outsideBefore = '';
  let at = 0;
  for (const mv of moves) {
    outsideBefore += before.slice(at, mv.start) + '\u0000';
    at = mv.end;
  }
  outsideBefore += before.slice(at);
  const ours = moves.map((mv) => byId.get(mv.localId));
  if (ours.some((o) => !o)) return { ok: false, reason: 'a new macro is missing from the result' };
  const sorted = [...ours].sort((a, b) => a.start - b.start);
  let outsideAfter = '';
  at = 0;
  for (const o of sorted) {
    outsideAfter += after.slice(at, o.start) + '\u0000';
    at = o.end;
  }
  outsideAfter += after.slice(at);
  if (outsideBefore !== outsideAfter) return { ok: false, reason: 'characters outside the macros differ' };
  for (let k = 0; k < moves.length; k++) {
    if (ours[k].source !== moves[k].text) return { ok: false, reason: `the text of macro ${k + 1} differs` };
  }
  // With everything outside the spans equal, and each span now a new macro,
  // the moved macros are gone by construction.
  return { ok: true };
}

/**
 * Checks a page as Confluence saved it against what was sent. Confluence
 * may store the sent page differently (it can add ids or reorder a
 * macro's settings), so this does not ask for the same string. It asks:
 * each new macro is there, holds its text exactly, with the expected key;
 * none of the moved macros is left; and every other macro on the page
 * (known or not) is still there, unchanged.
 */
function checkSaved(sentStorage, savedStorage, moves, target) {
  const found = findTargetMacros(savedStorage);
  const byId = new Map(found.map((f) => [f.localId, f]));
  for (const [k, mv] of moves.entries()) {
    const f = byId.get(mv.localId);
    if (!f) return { ok: false, reason: `new macro ${k + 1} is not on the saved page` };
    if (f.extensionKey !== target.extensionKey) return { ok: false, reason: `new macro ${k + 1} has another key on the saved page` };
    if (f.source !== mv.text) return { ok: false, reason: `the text of new macro ${k + 1} differs on the saved page` };
  }
  const sentMacros = findMacros(sentStorage).map((m) => m.raw).sort();
  const savedMacros = findMacros(savedStorage).map((m) => m.raw).sort();
  if (sentMacros.join('\u0001') !== savedMacros.join('\u0001')) return { ok: false, reason: 'the other macros on the saved page differ from what was sent' };
  return { ok: true, identical: sentStorage === savedStorage };
}

module.exports = { planPage, checkRewrite, checkSaved, sha256 };
