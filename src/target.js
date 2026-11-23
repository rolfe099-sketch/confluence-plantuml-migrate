// The PlantUML Diagram macro, as a page stores it.
//
// A Forge macro is stored as an ADF extension whose key holds the app ID
// and the environment ID of the installed app, which differ between
// Atlassian's normal cloud, Isolated Cloud and Government Cloud. The
// default below is the normal cloud's production app. For any other cloud,
// or to be sure, point the script at a page where you inserted one
// PlantUML Diagram macro yourself (--reference-page): the key is read from
// that page.
//
// The stored form below follows what the macro's editor saves, read from a
// page on a development site on 23 Nov 2026, with only the settings the
// macro needs to draw: the text (`source`), the language and the two
// display defaults. The editor adds a saved picture the next time someone
// opens and saves the diagram; until then the macro draws the text live.
'use strict';

const crypto = require('crypto');
const { escapeText, tokenize, decodeText } = require('./storage');

const MACRO_MODULE = 'plantuml-diagram';

const DEFAULT_TARGET = Object.freeze({
  extensionKey: '42490490-9dd5-4eb8-8d52-5801665c460a/bb107a45-10e6-4725-8d3b-d33f28325771/static/plantuml-diagram',
  title: 'PlantUML Diagram',
  environment: 'PRODUCTION',
  from: 'built-in (normal cloud, production app)',
});

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/static\/plantuml-diagram$/;

function attr(key, inner) {
  return `<ac:adf-attribute key="${key}">${inner}</ac:adf-attribute>`;
}
function param(key, inner) {
  return `<ac:adf-parameter key="${key}">${inner}</ac:adf-parameter>`;
}

/** The storage form of one PlantUML Diagram macro holding `text`. */
function buildMacro(text, target, localId = crypto.randomUUID()) {
  if (!KEY_RE.test(target.extensionKey)) throw new Error('target key is not a PlantUML Diagram key');
  const node =
    '<ac:adf-node type="extension">' +
    attr('extension-key', target.extensionKey) +
    attr('extension-type', 'com.atlassian.ecosystem') +
    attr(
      'parameters',
      param('local-id', localId) +
        param('extension-id', `ari:cloud:ecosystem::extension/${target.extensionKey}`) +
        param('extension-title', escapeText(target.title)) +
        param('layout', 'extension') +
        param('forge-environment', escapeText(target.environment)) +
        param('guest-params', param('source', escapeText(text)) + param('lang', 'plantuml') + param('theme', 'auto') + param('size', 'auto')),
    ) +
    attr('text', escapeText(target.title)) +
    attr('layout', 'default') +
    attr('local-id', localId) +
    '</ac:adf-node>';
  return { localId, xml: `<ac:adf-extension>${node}<ac:adf-fallback>${node}</ac:adf-fallback></ac:adf-extension>` };
}

/**
 * Every PlantUML Diagram macro in a storage string: its span, key, local
 * id, environment, title and decoded text. Used to read a reference page,
 * and to check a page after a write.
 */
function findTargetMacros(storage) {
  const tokens = tokenize(storage);
  const out = [];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type !== 'open' || tok.name !== 'ac:adf-extension') continue;
    // Find the matching close and read the first adf-node's direct values.
    let depth = 0;
    let end = -1;
    for (let u = t; u < tokens.length; u++) {
      if (tokens[u].type === 'open') depth++;
      else if (tokens[u].type === 'close') {
        depth--;
        if (depth === 0) {
          end = u;
          break;
        }
      }
    }
    if (end === -1) break;
    const values = readKeyed(tokens, t, end);
    const key = values['attr:extension-key'];
    if (key && key.endsWith(`/static/${MACRO_MODULE}`)) {
      out.push({
        start: tok.start,
        end: tokens[end].end,
        extensionKey: key,
        localId: values['attr:local-id'] || values['param:local-id'] || '',
        environment: values['param:forge-environment'] || '',
        title: values['param:extension-title'] || values['attr:text'] || '',
        source: values['param:guest-params/source'],
      });
    }
    t = end;
  }
  return out;
}

/**
 * Reads the first adf-node inside an adf-extension (not the fallback):
 * attributes as 'attr:key', parameters as 'param:path/key', text decoded.
 */
function readKeyed(tokens, from, to) {
  const values = {};
  const path = [];
  for (let t = from + 1; t < to; t++) {
    const tok = tokens[t];
    if (tok.type === 'open') {
      // The fallback repeats the node; the first node is the one Confluence uses.
      if (tok.name === 'ac:adf-fallback') break;
      if (tok.name === 'ac:adf-attribute') path.push(`attr:${tok.attrs.key}`);
      else if (tok.name === 'ac:adf-parameter') path.push(tok.attrs.key);
      else path.push(null);
    } else if (tok.type === 'close') {
      path.pop();
    } else if (tok.type === 'text' || tok.type === 'cdata') {
      const real = path.filter(Boolean);
      if (!real.length) continue;
      let key;
      if (real[0].startsWith('attr:') && real.length === 1) key = real[0];
      else if (real[0] === 'attr:parameters' && real.length > 1) key = `param:${real.slice(1).join('/')}`;
      else continue;
      const v = tok.type === 'cdata' ? tok.value : decodeText(tok.value).value;
      values[key] = (values[key] || '') + v;
    }
  }
  return values;
}

/** The target read from a reference page's storage. Throws if the page has none or several kinds. */
function targetFromReference(storage, pageId) {
  const found = findTargetMacros(storage);
  if (!found.length) throw new Error(`reference page ${pageId} holds no PlantUML Diagram macro`);
  const keys = new Set(found.map((f) => `${f.extensionKey}|${f.environment}`));
  if (keys.size > 1) throw new Error(`reference page ${pageId} holds PlantUML Diagram macros of more than one app or environment; use a page with one`);
  const f = found[0];
  if (!KEY_RE.test(f.extensionKey)) throw new Error(`reference page ${pageId}: unexpected macro key`);
  if (!/^[A-Z_]+$/.test(f.environment)) throw new Error(`reference page ${pageId}: unexpected environment`);
  return { extensionKey: f.extensionKey, title: f.title || 'PlantUML Diagram', environment: f.environment, from: `reference page ${pageId}` };
}

module.exports = { DEFAULT_TARGET, buildMacro, findTargetMacros, targetFromReference, KEY_RE };
