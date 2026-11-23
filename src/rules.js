// The old PlantUML macros this script knows, and when it may move one.
//
// Only these exact macro names are ever rewritten. For each, the rule says
// which parameters it understands. A macro with anything the rule does not
// understand (a parameter that loads the text from elsewhere, a body that
// is not plain text, an empty body, markup it cannot read) is reported and
// left exactly as it is.
'use strict';

const { isXmlSafe } = require('./storage');

/**
 * name: the macro name in storage format.
 * app: who made it, for the report.
 * ignoredParams: display settings the new macro does not carry over. They
 *   are listed in the report, and the macro is still moved.
 * blockingParams: parameters that mean the diagram's text is not (only) in
 *   the body. Any of them present, with a non-empty value: left alone.
 * typeParam: a parameter naming the diagram language, with the values the
 *   PlantUML Diagram macro draws. Another value: left alone.
 */
const RULES = Object.freeze({
  // avono's PlantUML for Confluence Data Center ("plantuml"), after a move to Cloud.
  plantuml: {
    app: 'PlantUML for Confluence (avono), from Data Center',
    ignoredParams: ['title', 'format', 'align', 'border', 'exportName', 'atlassian-macro-output-type', 'debug'],
    blockingParams: [],
    typeParam: { name: 'type', drawn: ['uml', 'plantuml', ''] },
  },
  // PowerPlantUML (Skylab Ventures), on Connect. Its descriptor also has
  // `uml`, `url` and `encodedUML` parameters, which hold the text outside
  // the body: those macros are left alone.
  'power-plant-uml-macro': {
    app: 'PowerPlantUML (Skylab Ventures), on Connect',
    ignoredParams: ['imageType', 'language'],
    blockingParams: ['uml', 'url', 'encodedUML'],
    typeParam: null,
  },
  // PlantUML SVG for Confluence (Grovr), on Connect. `remoteurl` loads the
  // text from a web address: left alone.
  'plantuml-svg': {
    app: 'PlantUML SVG for Confluence (Grovr), on Connect',
    ignoredParams: [],
    blockingParams: ['remoteurl'],
    typeParam: null,
  },
});

const SUPPORTED = Object.freeze(Object.keys(RULES));

/** Diagram starts the PlantUML Diagram macro does not draw. */
const NOT_DRAWN_START = /^\s*@start(ditaa|dot|math|latex|jcckit|chronology)\b/i;

/**
 * Whether a found macro may be moved.
 * @returns {{ok:true, text:string, ignored:string[], warnings:string[]} | {ok:false, reason:string}}
 */
function assess(macro) {
  const rule = Object.prototype.hasOwnProperty.call(RULES, macro.name) ? RULES[macro.name] : null;
  if (!rule) return { ok: false, reason: `macro "${macro.name}" is not one this script moves` };
  if (macro.duplicateParams.length) return { ok: false, reason: `parameter given twice: ${macro.duplicateParams.join(', ')}` };
  if (macro.otherChildren.length) return { ok: false, reason: `unexpected content inside the macro: ${[...new Set(macro.otherChildren)].join(', ')}` };
  if (macro.body.kind === 'none') return { ok: false, reason: 'the macro has no body, so its diagram text is not in the page' };
  if (macro.body.kind !== 'plain') return { ok: false, reason: `the macro's body is ${macro.body.kind === 'rich' ? 'rich text' : 'not plain text'}` };
  if (!macro.body.textOk) return { ok: false, reason: 'the body holds markup or an entity this script does not read' };
  const text = macro.body.text;
  if (text.trim() === '') return { ok: false, reason: 'the body is empty' };
  if (!isXmlSafe(text)) return { ok: false, reason: 'the text holds characters a page cannot store' };
  if (NOT_DRAWN_START.test(text)) return { ok: false, reason: `the diagram starts with ${text.trim().split(/\s/)[0]}, which the PlantUML Diagram macro does not draw` };

  const known = new Set([...rule.ignoredParams, ...rule.blockingParams, ...(rule.typeParam ? [rule.typeParam.name] : [])]);
  const unknown = Object.keys(macro.params).filter((p) => !known.has(p));
  if (unknown.length) return { ok: false, reason: `unknown parameter: ${unknown.join(', ')}` };
  for (const [p, v] of Object.entries(macro.params)) {
    if (v.startsWith('\u0000')) return { ok: false, reason: `parameter "${p}" holds markup this script does not read` };
  }
  const blocking = rule.blockingParams.filter((p) => (macro.params[p] || '').trim() !== '');
  if (blocking.length) return { ok: false, reason: `the text may come from elsewhere (parameter ${blocking.join(', ')})` };
  if (rule.typeParam && Object.prototype.hasOwnProperty.call(macro.params, rule.typeParam.name)) {
    const type = macro.params[rule.typeParam.name].trim().toLowerCase();
    if (!rule.typeParam.drawn.includes(type)) return { ok: false, reason: `${rule.typeParam.name} = ${type}, which the PlantUML Diagram macro does not draw` };
  }
  const ignored = Object.keys(macro.params).filter((p) => rule.ignoredParams.includes(p) || (rule.typeParam && p === rule.typeParam.name));
  // Old wiki-markup tags around the text: kept byte for byte, the macro
  // cannot draw them (seen on a development site, 23 Nov 2026). Moving the
  // text would mean changing it, so the macro is left for a person to move.
  if (/^\s*\{plantuml(:[^}]*)?\}/.test(text) || /\{plantuml\}\s*$/.test(text)) {
    return { ok: false, reason: 'the text is wrapped in {plantuml} wiki tags, which the PlantUML Diagram macro cannot draw; move it by hand without the tags' };
  }
  const warnings = [];
  return { ok: true, text, ignored, warnings };
}

/** A macro name that looks like PlantUML but is not one this script moves: reported only. */
function looksLikePlantUml(name) {
  return !Object.prototype.hasOwnProperty.call(RULES, name) && /uml/i.test(name);
}

module.exports = { RULES, SUPPORTED, assess, looksLikePlantUml };
