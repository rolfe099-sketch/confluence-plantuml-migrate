// Reads Confluence storage format just enough to find macros, without an
// XML library: the script has no dependencies, so there is nothing to
// install and nothing in it that the reader cannot read.
//
// The tokenizer walks the storage string once and knows CDATA sections,
// comments and tags, so text inside a CDATA section (a diagram may contain
// "</ac:structured-macro>") is never taken for markup. It reports offsets
// into the original string, so a rewrite can splice exactly the macro's
// characters and leave every other character of the page as it was.
'use strict';

/** @typedef {{type:'cdata'|'comment'|'open'|'close'|'selfclose'|'text'|'pi', start:number, end:number, name?:string, attrs?:Record<string,string>, value?:string}} Token */

const NAME_RE = /^[A-Za-z_][\w.:-]*/;

class StorageError extends Error {}

/** Splits a storage string into tokens. Throws StorageError on markup it cannot read. */
function tokenize(s) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      out.push({ type: 'text', start: i, end: n, value: s.slice(i, n) });
      break;
    }
    if (lt > i) out.push({ type: 'text', start: i, end: lt, value: s.slice(i, lt) });
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      if (e === -1) throw new StorageError(`unclosed CDATA section at ${lt}`);
      out.push({ type: 'cdata', start: lt, end: e + 3, value: s.slice(lt + 9, e) });
      i = e + 3;
    } else if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      if (e === -1) throw new StorageError(`unclosed comment at ${lt}`);
      out.push({ type: 'comment', start: lt, end: e + 3 });
      i = e + 3;
    } else if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2);
      if (e === -1) throw new StorageError(`unclosed processing instruction at ${lt}`);
      out.push({ type: 'pi', start: lt, end: e + 2 });
      i = e + 2;
    } else if (s.startsWith('<!', lt)) {
      throw new StorageError(`unexpected declaration at ${lt}`);
    } else if (s[lt + 1] === '/') {
      const m = NAME_RE.exec(s.slice(lt + 2, lt + 200));
      if (!m) throw new StorageError(`bad closing tag at ${lt}`);
      const e = s.indexOf('>', lt + 2 + m[0].length);
      if (e === -1 || s.slice(lt + 2 + m[0].length, e).trim() !== '') throw new StorageError(`bad closing tag at ${lt}`);
      out.push({ type: 'close', start: lt, end: e + 1, name: m[0] });
      i = e + 1;
    } else {
      const m = NAME_RE.exec(s.slice(lt + 1, lt + 200));
      if (!m) throw new StorageError(`bad tag at ${lt}`);
      // Find the end of the tag, honouring quoted attribute values.
      let j = lt + 1 + m[0].length;
      let quote = '';
      for (; j < n; j++) {
        const c = s[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        else if (c === '<') throw new StorageError(`'<' inside tag at ${lt}`);
      }
      if (j >= n) throw new StorageError(`unclosed tag at ${lt}`);
      const self = s[j - 1] === '/';
      const attrText = s.slice(lt + 1 + m[0].length, self ? j - 1 : j);
      out.push({ type: self ? 'selfclose' : 'open', start: lt, end: j + 1, name: m[0], attrs: parseAttrs(attrText, lt) });
      i = j + 1;
    }
  }
  return out;
}

function parseAttrs(text, at) {
  /** @type {Record<string,string>} */
  const attrs = {};
  const re = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
  let k = 0;
  while (k < text.length) {
    if (/^\s*$/.test(text.slice(k))) break;
    re.lastIndex = k;
    const m = re.exec(text);
    if (!m) throw new StorageError(`bad attributes at ${at}`);
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
    k = re.lastIndex;
  }
  return attrs;
}

const { ENTITIES: NAMED } = require('./entities');

/**
 * Decodes character references and the named entities of XHTML 1.0
 * (entities.js), which Confluence uses in storage format. Any other name
 * is not decoded: the caller learns so through `ok: false`, and the
 * macro is left alone.
 */
function decodeText(t) {
  let ok = true;
  const value = t.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (all, ref) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff) {
        ok = false;
        return all;
      }
      return String.fromCodePoint(cp);
    }
    if (NAMED[ref] !== undefined) return NAMED[ref];
    ok = false;
    return all;
  });
  if (/&(?!(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);)/.test(t)) ok = false;
  return { ok, value };
}

function decodeEntities(t) {
  return decodeText(t).value;
}

/** Characters XML 1.0 can carry at all. A text with others cannot be stored. */
function isXmlSafe(text) {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/**
 * Escapes text for an element's content. A carriage return is written as
 * a character reference, because an XML reader turns a raw CR (and CRLF)
 * into LF: written as &#13; it comes back as itself, byte for byte.
 */
function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
}

const MACRO_TAGS = new Set(['ac:structured-macro', 'ac:macro']);

/**
 * Every macro in the storage string, outermost and nested, in document
 * order. For each: its name, its tag form, its exact span, its direct
 * parameters and what its body holds.
 */
function findMacros(storage) {
  const tokens = tokenize(storage);
  const stack = [];
  const macros = [];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type === 'open') {
      stack.push({ name: tok.name, index: t });
    } else if (tok.type === 'close') {
      const top = stack.pop();
      if (!top || top.name !== tok.name) throw new StorageError(`mismatched </${tok.name}> at ${tok.start}`);
      if (MACRO_TAGS.has(tok.name)) macros.push(readMacro(storage, tokens, top.index, t));
    } else if (tok.type === 'selfclose' && MACRO_TAGS.has(tok.name)) {
      macros.push(readMacro(storage, tokens, t, t));
    }
  }
  if (stack.length) throw new StorageError(`unclosed <${stack[stack.length - 1].name}>`);
  macros.sort((a, b) => a.start - b.start);
  return macros;
}

function readMacro(storage, tokens, openIdx, closeIdx) {
  const open = tokens[openIdx];
  const close = tokens[closeIdx];
  const macro = {
    name: open.attrs['ac:name'] || '',
    form: open.name === 'ac:macro' ? 'legacy' : 'structured',
    start: open.start,
    end: close.end,
    raw: storage.slice(open.start, close.end),
    params: /** @type {Record<string,string>} */ ({}),
    duplicateParams: /** @type {string[]} */ ([]),
    /** @type {{kind:'none'|'plain'|'rich'|'other', text?:string, textOk?:boolean}} */
    body: { kind: 'none' },
    /** Direct children that are not parameters or the body. */
    otherChildren: /** @type {string[]} */ ([]),
  };
  if (openIdx === closeIdx) return macro;
  // Walk direct children only.
  let depth = 0;
  for (let t = openIdx + 1; t < closeIdx; t++) {
    const tok = tokens[t];
    if (depth === 0) {
      if (tok.type === 'open' || tok.type === 'selfclose') {
        const end = tok.type === 'open' ? matchClose(tokens, t) : t;
        if (tok.name === 'ac:parameter') {
          const pname = tok.attrs['ac:name'] || '';
          const value = tok.type === 'selfclose' ? { ok: true, value: '' } : innerText(tokens, t, end);
          if (Object.prototype.hasOwnProperty.call(macro.params, pname)) macro.duplicateParams.push(pname);
          macro.params[pname] = value.ok ? value.value : '\u0000unreadable';
        } else if (tok.name === 'ac:plain-text-body') {
          if (macro.body.kind !== 'none') macro.body = { kind: 'other' };
          else {
            const v = tok.type === 'selfclose' ? { ok: true, value: '' } : innerText(tokens, t, end);
            macro.body = { kind: 'plain', text: v.value, textOk: v.ok };
          }
        } else if (tok.name === 'ac:rich-text-body') {
          macro.body = { kind: 'rich' };
        } else {
          macro.otherChildren.push(tok.name);
        }
        if (tok.type === 'open') t = end;
        continue;
      }
      if (tok.type === 'text' && tok.value.trim() !== '') macro.otherChildren.push('#text');
      if (tok.type === 'cdata') macro.otherChildren.push('#cdata');
    }
  }
  return macro;
}

function matchClose(tokens, openIdx) {
  let depth = 0;
  for (let t = openIdx; t < tokens.length; t++) {
    if (tokens[t].type === 'open') depth++;
    else if (tokens[t].type === 'close') {
      depth--;
      if (depth === 0) return t;
    }
  }
  throw new StorageError('unclosed element');
}

/** The text between an element's open and close tags: CDATA and text only. */
function innerText(tokens, openIdx, closeIdx) {
  let ok = true;
  let value = '';
  for (let t = openIdx + 1; t < closeIdx; t++) {
    const tok = tokens[t];
    if (tok.type === 'cdata') value += tok.value;
    else if (tok.type === 'text') {
      const d = decodeText(tok.value);
      if (!d.ok) ok = false;
      value += d.value;
    } else if (tok.type === 'comment') {
      ok = false;
    } else {
      ok = false; // markup inside a plain-text value: not ours to read
    }
  }
  return { ok, value };
}

module.exports = { tokenize, findMacros, decodeText, escapeText, isXmlSafe, StorageError };
