#!/usr/bin/env node
// Moves old PlantUML macros on Confluence Cloud pages into the PlantUML
// Diagram macro. Dry run unless --apply. See README.md before running it.
'use strict';

const path = require('path');
const { client } = require('../src/confluence');
const { dryRun, apply, undo, Stop, TOOL, VERSION } = require('../src/run');
const { SUPPORTED } = require('../src/rules');

const HELP = `${TOOL} ${VERSION}

Moves old PlantUML macros (${SUPPORTED.join(', ')}) on Confluence Cloud
pages into the PlantUML Diagram macro, keeping each diagram's text exactly.
A dry run by default: it writes nothing until you give --apply.

Credentials come from the environment only:
  CONFLUENCE_EMAIL      the Atlassian account's email address
  CONFLUENCE_API_TOKEN  an API token for that account (never printed)

1. Dry run (writes plan.json and report.md, changes nothing):
  ${TOOL} --site https://your-site.atlassian.net --space KEY [--space KEY2]

2. Apply exactly what the dry run planned:
  ${TOOL} --site https://your-site.atlassian.net --apply --plan <dir>/plan.json

3. Undo a run (dry run first, then with --apply):
  ${TOOL} --site https://your-site.atlassian.net --undo <dir>/changes-<time>.jsonl [--apply]

Options:
  --site URL            your Confluence Cloud site (https only)
  --space KEY           only pages in this space (repeat for more)
  --all-spaces          every space the account can see (instead of --space)
  --page ID             only this page (repeat for more)
  --macro NAME          only this old macro name (repeat; default: all known)
  --limit N             at most N pages (default 25, at most 1000)
  --pause SECONDS       wait between page writes (default 2, at least 0.5)
  --reference-page ID   read the new macro's key from a page where you
                        inserted one PlantUML Diagram macro (required
                        outside atlassian.net, for example Government Cloud)
  --out DIR             where plan, report and log go (default: a new
                        folder plantuml-migrate-<time> here)
  --notify              notify page watchers (default: saved as minor edits)
  --skip-edited         with --undo --apply: restore the pages nobody edited
                        since the move, and leave edited ones alone
  --verbose             also print the whole report
  --help                this text
`;

function parseArgs(argv) {
  const o = { spaces: [], pages: [], macros: [], limit: 25, pause: 2, allSpaces: false, apply: false, notify: false, verbose: false, skipEdited: false };
  const takes = new Set(['--site', '--space', '--page', '--macro', '--limit', '--pause', '--reference-page', '--out', '--plan', '--undo']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token' || a.startsWith('--token=')) throw new Stop('the token is never taken from the command line: set CONFLUENCE_API_TOKEN instead');
    if (!a.startsWith('--')) throw new Stop(`unexpected argument: ${a}`);
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (takes.has(flag)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Stop(`${flag} needs a value`);
      if (flag === '--site') o.site = v;
      else if (flag === '--space') o.spaces.push(v);
      else if (flag === '--page') {
        if (!/^\d+$/.test(v)) throw new Stop(`--page takes a page id (digits): ${v}`);
        o.pages.push(v);
      } else if (flag === '--macro') {
        if (!SUPPORTED.includes(v)) throw new Stop(`--macro must be one of ${SUPPORTED.join(', ')}`);
        o.macros.push(v);
      } else if (flag === '--limit') o.limit = Number(v);
      else if (flag === '--pause') o.pause = Number(v);
      else if (flag === '--reference-page') {
        if (!/^\d+$/.test(v)) throw new Stop('--reference-page takes a page id (digits)');
        o.referencePage = v;
      } else if (flag === '--out') o.outDir = v;
      else if (flag === '--plan') o.planFile = v;
      else if (flag === '--undo') o.undoLog = v;
    } else if (inline !== undefined) throw new Stop(`${flag} takes no value`);
    else if (flag === '--all-spaces') o.allSpaces = true;
    else if (flag === '--apply') o.apply = true;
    else if (flag === '--notify') o.notify = true;
    else if (flag === '--skip-edited') o.skipEdited = true;
    else if (flag === '--verbose') o.verbose = true;
    else if (flag === '--help') o.help = true;
    else throw new Stop(`unknown option: ${flag}`);
  }
  if (o.help) return o;
  if (!o.site) throw new Stop('--site is required');
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 1000) throw new Stop('--limit must be a whole number from 1 to 1000');
  if (!Number.isFinite(o.pause) || o.pause < 0.5) throw new Stop('--pause must be at least 0.5 seconds');
  o.pauseMs = Math.round(o.pause * 1000);
  if (!o.macros.length) o.macros = [...SUPPORTED];
  if (o.undoLog) {
    if (o.planFile || o.spaces.length || o.pages.length || o.allSpaces) throw new Stop('--undo takes only --site, --apply, --skip-edited, --pause, --notify and --out');
  } else if (o.skipEdited) throw new Stop('--skip-edited is only for --undo');
  else if (o.apply) {
    if (!o.planFile) throw new Stop('--apply needs --plan, the plan.json of a dry run you have read');
    if (o.spaces.length || o.pages.length || o.allSpaces || o.referencePage) throw new Stop('with --apply, the plan decides the pages: leave out --space, --page, --all-spaces and --reference-page');
  } else {
    if (o.planFile) throw new Stop('--plan is only for --apply');
    if (!o.spaces.length && !o.allSpaces && !o.pages.length) throw new Stop('say which pages: --space KEY, --page ID, or --all-spaces');
    if (o.allSpaces && o.spaces.length) throw new Stop('give --space or --all-spaces, not both');
  }
  if (!o.outDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    o.outDir = o.undoLog ? path.dirname(o.undoLog) : o.apply ? path.dirname(o.planFile) : path.resolve(`plantuml-migrate-${stamp}`);
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nRun with --help for usage.`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!email || !token) {
    console.error('Set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in the environment first (see README.md).');
    return 2;
  }
  const redact = (s) => {
    let out = String(s);
    for (const secret of [token, Buffer.from(`${email}:${token}`).toString('base64')]) if (secret) out = out.split(secret).join('[token]');
    return out;
  };
  const io = {
    print: (line) => console.log(redact(line)),
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    redact,
  };
  try {
    const api = client({ site: o.site, authHeader: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` });
    if (o.undoLog) await undo(o, api, io);
    else if (o.apply) await apply(o, api, io);
    else await dryRun(o, api, io);
    return 0;
  } catch (e) {
    if (!(e instanceof Stop) || e.message !== 'stopped') console.error(redact(e.message));
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
