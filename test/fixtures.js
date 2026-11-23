// Storage fixtures, written from the formats we could see:
// - avono's `plantuml`, as Confluence Cloud stores a page migrated from Data
//   Center (read on a development site, 23 Nov 2026), in both its current
//   form (ac:structured-macro) and its old form (ac:macro);
// - PowerPlantUML's `power-plant-uml-macro` and Grovr's `plantuml-svg`,
//   from their apps' public descriptors (macro name, plain-text body,
//   parameter names). Neither app was installed.
// All diagram text is our own sample text.
'use strict';

const p = (name, value) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
const cdata = (t) => `<ac:plain-text-body><![CDATA[${t}]]></ac:plain-text-body>`;

const avono = (text, params = '', id = '11111111-1111-4111-8111-111111111111') => `<ac:structured-macro ac:name="plantuml" ac:schema-version="1" ac:macro-id="${id}">${params}${cdata(text)}</ac:structured-macro>`;
const avonoLegacy = (text, params = '') => `<ac:macro ac:name="plantuml">${params}${cdata(text)}</ac:macro>`;
const power = (text, params = '') => `<ac:structured-macro ac:name="power-plant-uml-macro" ac:schema-version="1" ac:macro-id="22222222-2222-4222-8222-222222222222">${params}${cdata(text)}</ac:structured-macro>`;
const grovr = (text, params = '') => `<ac:structured-macro ac:name="plantuml-svg" ac:schema-version="1">${params}${cdata(text)}</ac:structured-macro>`;

const SEQ = '@startuml\nAlice -> Bob : hello & welcome\nBob --> Alice : ok\n@enduml';
const CLASS = 'class Order <<entity>>\nOrder "1" *-- "many" Line : contains >\nnote right of Order : no @startuml line';
const WIKI = '{plantuml}\nstart\n:read request;\nstop\n{plantuml}';
const DITAA = '+--------+   +-------+\n| client |-->| proxy |\n+--------+   +-------+';

module.exports = { p, cdata, avono, avonoLegacy, power, grovr, SEQ, CLASS, WIKI, DITAA };
