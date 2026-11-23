'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findMacros, tokenize, escapeText, StorageError } = require('../src/storage');
const { planPage, checkRewrite, checkSaved } = require('../src/plan');
const { DEFAULT_TARGET, buildMacro, findTargetMacros, targetFromReference } = require('../src/target');
const F = require('./fixtures');

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const plan = (s, t = DEFAULT_TARGET) => planPage(s, t, { newId });

/** Everything outside the moved spans must be the same characters. */
function assertOutsideSame(before, result) {
  const found = findTargetMacros(result.storage);
  let a = '';
  let at = 0;
  for (const m of result.moves) {
    a += before.slice(at, m.start) + '|';
    at = m.end;
  }
  a += before.slice(at);
  let b = '';
  at = 0;
  const ours = found.filter((f) => result.moves.some((m) => m.localId === f.localId));
  for (const f of ours) {
    b += result.storage.slice(at, f.start) + '|';
    at = f.end;
  }
  b += result.storage.slice(at);
  assert.equal(b, a);
}

test('avono plantuml with settings: moved, text exact, settings listed', () => {
  const s = `<p>Before &amp; after</p>${F.avono(F.SEQ, F.p('type', 'uml') + F.p('title', 'Greeting') + F.p('format', 'SVG') + F.p('align', 'center'))}<p>tail</p>`;
  const r = plan(s);
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].text, F.SEQ);
  assert.deepEqual(r.moves[0].ignoredParams.sort(), ['align', 'format', 'title', 'type']);
  const t = findTargetMacros(r.storage);
  assert.equal(t.length, 1);
  assert.equal(t[0].source, F.SEQ);
  assert.equal(t[0].extensionKey, DEFAULT_TARGET.extensionKey);
  assert.ok(r.storage.startsWith('<p>Before &amp; after</p><ac:adf-extension>'));
  assert.ok(r.storage.endsWith('</ac:adf-extension><p>tail</p>'));
  assertOutsideSame(s, r);
});

test('old ac:macro form: moved, its debug setting listed', () => {
  const r = plan(F.avonoLegacy(F.CLASS, F.p('debug', 'true')));
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].text, F.CLASS);
  assert.equal(r.moves[0].form, 'legacy');
  assert.deepEqual(r.moves[0].ignoredParams, ['debug']);
});

test('text wrapped in {plantuml} wiki tags: left alone, since kept exactly it cannot draw', () => {
  for (const s of [F.avonoLegacy(F.WIKI), F.avono(F.WIKI), F.grovr('{plantuml:title=x}\nA -> B\n{plantuml}')]) {
    const r = plan(s);
    assert.equal(r.moves.length, 0);
    assert.match(r.skipped[0].reason, /wiki tags/);
  }
});

test('ditaa and dot: left alone with a reason', () => {
  for (const type of ['ditaa', 'dot', 'DITAA']) {
    const r = plan(F.avono(F.DITAA, F.p('type', type)));
    assert.equal(r.moves.length, 0);
    assert.equal(r.storage, null);
    assert.match(r.skipped[0].reason, /does not draw/);
  }
  const r = plan(F.avono('@startditaa\n+--+\n@endditaa'));
  assert.match(r.skipped[0].reason, /@startditaa/);
});

test('PowerPlantUML: body moved; text in a setting or a web address left alone', () => {
  assert.equal(plan(F.power(F.SEQ, F.p('imageType', 'svg'))).moves.length, 1);
  for (const blocking of ['url', 'uml', 'encodedUML']) {
    const r = plan(F.power(F.SEQ, F.p(blocking, 'something')));
    assert.equal(r.moves.length, 0, blocking);
    assert.match(r.skipped[0].reason, /elsewhere/);
  }
  // An empty url setting is not a second source.
  assert.equal(plan(F.power(F.SEQ, F.p('url', ''))).moves.length, 1);
});

test('PlantUML SVG: body moved; remoteurl left alone', () => {
  assert.equal(plan(F.grovr(F.CLASS)).moves.length, 1);
  assert.equal(plan(F.grovr(F.CLASS, F.p('remoteurl', 'https://example.com/a.puml'))).moves.length, 0);
});

test('unknown parameter, empty body, no body, rich body: left alone', () => {
  assert.match(plan(F.avono(F.SEQ, F.p('server', 'x'))).skipped[0].reason, /unknown parameter: server/);
  assert.match(plan(F.avono('   \n ')).skipped[0].reason, /empty/);
  assert.match(plan('<ac:structured-macro ac:name="plantuml"></ac:structured-macro>').skipped[0].reason, /no body/);
  assert.match(plan('<ac:structured-macro ac:name="plantuml"/>').skipped[0].reason, /no body/);
  assert.match(plan('<ac:structured-macro ac:name="plantuml"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>').skipped[0].reason, /rich text/);
  assert.match(plan(`<ac:structured-macro ac:name="plantuml">${F.p('type', 'uml')}${F.p('type', 'ditaa')}${F.cdata(F.SEQ)}</ac:structured-macro>`).skipped[0].reason, /twice/);
});

test('other macros, including PlantUML-like ones, are never touched', () => {
  const other = '<ac:structured-macro ac:name="plantumlrender"><ac:plain-text-body><![CDATA[A->B]]></ac:plain-text-body></ac:structured-macro>';
  const code = '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[@startuml\nA->B\n@enduml]]></ac:plain-text-body></ac:structured-macro>';
  const s = other + code + F.avono(F.SEQ);
  const r = plan(s);
  assert.equal(r.moves.length, 1);
  assert.deepEqual(r.others.map((o) => o.name), ['plantumlrender']);
  assert.ok(r.storage.startsWith(other + code));
});

test('several macros on one page, in a table, an expand and a layout', () => {
  const s =
    '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell>' +
    F.avono(F.SEQ) +
    '</ac:layout-cell><ac:layout-cell><table><tbody><tr><td>' +
    F.power(F.CLASS) +
    '</td></tr></tbody></table></ac:layout-cell></ac:layout-section></ac:layout>' +
    '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>in expand</p>' +
    F.grovr(F.SEQ) +
    F.avono(F.DITAA, F.p('type', 'ditaa')) +
    '</ac:rich-text-body></ac:structured-macro>';
  const r = plan(s);
  assert.equal(r.moves.length, 3);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(findTargetMacros(r.storage).map((t) => t.source), [F.SEQ, F.CLASS, F.SEQ]);
  assertOutsideSame(s, r);
  // The expand and its title are still there, around the moved macro.
  const expand = findMacros(r.storage).find((m) => m.name === 'expand');
  assert.ok(expand && expand.params.title === 'More');
  // Running again finds nothing to move.
  assert.equal(plan(r.storage).moves.length, 0);
});

test('a very large diagram (300,000 characters) is moved whole', () => {
  const lines = [];
  for (let i = 0; i < 12000; i++) lines.push(`Participant${i} -> Participant${i + 1} : step ${i} & more`);
  const big = `@startuml\n${lines.join('\n')}\n@enduml`;
  assert.ok(big.length > 300000);
  const r = plan(F.avono(big));
  assert.equal(r.moves[0].text, big);
  assert.equal(findTargetMacros(r.storage)[0].source, big);
});

test('unusual characters survive exactly', () => {
  const texts = [
    'Alice -> Bob : 你好 – ünïcødé – emoji 🎉👩‍💻 – RTL שלום – NBSP here',
    'A -> B : "quotes" \'single\' <tags> & ampersands &amp; &lt;already-escaped&gt;',
    'A -> B : tab\there\r\nCRLF line\rCR alone\nLF',
    'A -> B : ]] and ]]> inside',
    'A -> B : </ac:structured-macro></ac:plain-text-body> looks like markup',
    'skinparam backgroundColor #FEFEFE\n\' a comment\nA -> B : `backticks` $dollar ${braces} \\backslash',
  ];
  for (const t of texts) {
    // A CDATA section cannot hold "]]>", so Confluence splits it in two; read it back as one.
    const body = t.split(']]>').join(']]]]><![CDATA[>');
    const s = `<ac:structured-macro ac:name="plantuml"><ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;
    const r = plan(s);
    assert.equal(r.moves.length, 1, t);
    assert.equal(r.moves[0].text, t);
    assert.equal(findTargetMacros(r.storage)[0].source, t);
  }
});

test('text with characters a page cannot hold is left alone', () => {
  const r = plan(F.avono('A -> B : bell\u0007'));
  assert.equal(r.moves.length, 0);
  assert.match(r.skipped[0].reason, /cannot store/);
});

test('the XHTML entities Confluence writes back are read; unknown ones are not guessed', () => {
  // As Confluence saved our unusual-characters test text (development site, 23 Nov 2026).
  const saved = 'Alice -&gt; Bob : 你好 &ndash; &uuml;n&iuml;c&oslash;d&eacute; &ndash; 🎉 NBSP&nbsp;here &amp;amp;';
  const s = `<ac:structured-macro ac:name="plantuml"><ac:plain-text-body>${saved}</ac:plain-text-body></ac:structured-macro>`;
  assert.equal(plan(s).moves[0].text, 'Alice -> Bob : 你好 – ünïcødé – 🎉 NBSP here &amp;');
  for (const unknown of ['&lang;', '&bogus;', '&hellip']) {
    const u = `<ac:structured-macro ac:name="plantuml"><ac:plain-text-body>A ${unknown} B</ac:plain-text-body></ac:structured-macro>`;
    assert.equal(plan(u).moves.length, 0, unknown);
  }
});

test('a body written as escaped text instead of CDATA is read the same', () => {
  const s = '<ac:structured-macro ac:name="plantuml"><ac:plain-text-body>A -&gt; B : x &amp; y &#169; &#x1F389;</ac:plain-text-body></ac:structured-macro>';
  assert.equal(plan(s).moves[0].text, 'A -> B : x & y © 🎉');
  const html = '<ac:structured-macro ac:name="plantuml"><ac:plain-text-body>A -&gt; B &nbsp; x</ac:plain-text-body></ac:structured-macro>';
  assert.equal(plan(html).moves[0].text, 'A -> B   x');
});

test('broken storage is refused, not guessed at', () => {
  assert.throws(() => plan('<p>open <ac:structured-macro ac:name="plantuml">'), StorageError);
  assert.throws(() => plan('<p>x</b>'), StorageError);
  assert.throws(() => plan('<![CDATA[never closed'), StorageError);
});

test('the new macro escapes everything it writes', () => {
  const t = { extensionKey: DEFAULT_TARGET.extensionKey, title: 'PlantUML <b>&', environment: 'PRODUCTION' };
  const { xml } = buildMacro('x', t, newId());
  assert.ok(!xml.includes('<b>'));
  assert.ok(xml.includes('PlantUML &lt;b&gt;&amp;'));
  tokenize(xml);
  assert.throws(() => buildMacro('x', { ...t, extensionKey: 'evil"/><x' }), /not a PlantUML Diagram key/);
  assert.equal(escapeText('\r\n'), '&#13;\n');
});

test('reference page: the key, title and environment are read from a saved macro', () => {
  // The shape the macro's editor saves (development site, 23 Nov 2026),
  // with made-up ids and a short picture.
  const key = '42490490-9dd5-4eb8-8d52-5801665c460a/dbf931fb-bfdd-486f-8d46-9572fcb999db/static/plantuml-diagram';
  const node = `<ac:adf-node type="extension"><ac:adf-attribute key="extension-key">${key}</ac:adf-attribute><ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute><ac:adf-attribute key="parameters"><ac:adf-parameter key="layout">extension</ac:adf-parameter><ac:adf-parameter key="guest-params"><ac:adf-parameter key="png">data:image/png;base64,iVBORw0KGgo=</ac:adf-parameter><ac:adf-parameter key="alt" /><ac:adf-parameter key="history"><ac:adf-parameter-value /></ac:adf-parameter><ac:adf-parameter key="source">A -&gt; B</ac:adf-parameter><ac:adf-parameter key="lang">plantuml</ac:adf-parameter></ac:adf-parameter><ac:adf-parameter key="forge-environment">DEVELOPMENT</ac:adf-parameter><ac:adf-parameter key="embedded-macro-context"><ac:adf-parameter key="cloud-id">00000000-0000-0000-0000-000000000000</ac:adf-parameter></ac:adf-parameter><ac:adf-parameter key="local-id">aaaaaaaa-0000-4000-8000-000000000000</ac:adf-parameter><ac:adf-parameter key="extension-title">PlantUML Diagram (Development)</ac:adf-parameter></ac:adf-attribute><ac:adf-attribute key="text">PlantUML Diagram (Development)</ac:adf-attribute><ac:adf-attribute key="layout">default</ac:adf-attribute><ac:adf-attribute key="local-id">aaaaaaaa-0000-4000-8000-000000000000</ac:adf-attribute></ac:adf-node>`;
  const s = `<p>ref</p><ac:adf-extension>${node}<ac:adf-fallback>${node}</ac:adf-fallback></ac:adf-extension>`;
  const t = targetFromReference(s, '1');
  assert.deepEqual(t, { extensionKey: key, title: 'PlantUML Diagram (Development)', environment: 'DEVELOPMENT', from: 'reference page 1' });
  assert.equal(findTargetMacros(s)[0].source, 'A -> B');
  assert.throws(() => targetFromReference('<p>none</p>', '2'), /no PlantUML Diagram/);
  // A Mermaid macro of the same app is not a reference.
  assert.throws(() => targetFromReference(s.split('plantuml-diagram').join('mermaid-diagram'), '3'), /no PlantUML Diagram/);
});

test('checkRewrite catches a change outside the macros', () => {
  const s = `<p>a</p>${F.avono(F.SEQ)}<p>b</p>`;
  const r = plan(s);
  assert.equal(checkRewrite(s, r.storage, r.moves).ok, true);
  assert.equal(checkRewrite(s, r.storage.replace('<p>b</p>', '<p>c</p>'), r.moves).ok, false);
  assert.equal(checkRewrite(s, r.storage.replace('hello &amp;', 'hello'), r.moves).ok, false);
});

test('checkSaved: accepts a page Confluence stored differently, refuses lost text or macros', () => {
  const other = '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>';
  const s = `<p>a</p>${other}${F.avono(F.SEQ)}`;
  const r = plan(s);
  const ok = checkSaved(r.storage, r.storage.replace('<p>a</p>', '<p local-id="1">a</p>'), r.moves, DEFAULT_TARGET);
  assert.deepEqual(ok, { ok: true, identical: false });
  assert.equal(checkSaved(r.storage, r.storage.replace('hello &amp; welcome', 'hello'), r.moves, DEFAULT_TARGET).ok, false);
  assert.equal(checkSaved(r.storage, r.storage.replace(other, ''), r.moves, DEFAULT_TARGET).ok, false);
  assert.equal(checkSaved(r.storage, '<p>a</p>', r.moves, DEFAULT_TARGET).ok, false);
});
