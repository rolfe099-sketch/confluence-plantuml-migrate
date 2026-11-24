# Test results

## Unit tests

`npm test` runs 52 tests. On Node 24.12, on Windows, on 23 November 2026, all 52 passed.

**What is moved:**

- avono's `plantuml`, in both forms (`ac:structured-macro` and the older `ac:macro`);
- PowerPlantUML's `power-plant-uml-macro`;
- Grovr's `plantuml-svg`;
- with `--macro`, only the names given.

**What is left alone, with its reason:**

- ditaa and dot diagrams, and PowerPlantUML's `language` set to another diagram type;
- text kept in a setting or at a web address;
- settings the script does not know, and settings given twice;
- empty bodies and rich-text bodies;
- `{plantuml}` wiki tags;
- characters XML cannot hold;
- entities the script does not know.

**Page shapes:** several macros on one page; macros in tables, expands and layouts.

**Text kept exactly:**

- a 300,000-character diagram;
- Chinese, Hebrew and emoji text;
- a no-break space, quotes, `&` and `<`;
- tabs, and CR and CRLF line ends;
- `]]>` split across CDATA sections;
- text that looks like markup inside CDATA;
- the XHTML entities Confluence writes back. All 251 names were checked against Chrome's own decoder. `&lang;` and `&rang;` are left out on purpose, because HTML5 changed their meaning.

**Checks before and after saving:**

- broken storage is refused;
- every value in the new macro is escaped, or checked against a fixed pattern;
- before saving: nothing outside the macros changed;
- after saving: the new macros hold the exact text, the other macros are unchanged (ids and schema versions Confluence adds are allowed), and every character outside the new macros is as it was;
- only the Eriksen Labs app's IDs for its three clouds are accepted, from a plan or from a reference page.

**Runs**, against a fake Confluence that keeps page history:

- a dry run sends only GET requests;
- a second dry run into the same folder does not overwrite the plan;
- apply follows the plan, saves minor edits, logs each step and checks each save;
- a hand-edited plan is refused: a page listed twice, a page with nothing to move, or an unknown target;
- a page edited after the dry run stops the run before any write;
- a page saved between our read and our write gets a 409 conflict, and the run stops;
- the first error stops the run, and later pages are not touched;
- `--limit` holds;
- undo restores pages exactly;
- undo with an edited or deleted page writes nothing unless given `--skip-edited`;
- undo restores a page whose save happened but whose log line was lost;
- undo leaves a page whose save did not happen for a person to check;
- a cut-off last log line is skipped, and a bad line in the middle stops undo;
- a log edited to name another page restores nothing;
- a plan for another site is refused;
- a site outside atlassian.net needs `--reference-page`;
- the site address must be https, with no path;
- a 429 is waited out, and a 503 is retried only for reads;
- titles cannot put links, pictures or HTML into the report.

**Command line:**

- `--token` is refused;
- a stray argument is never printed back;
- `--apply` needs `--plan`;
- `--out` is refused with `--undo`.

**No telemetry:**

- one fetch call;
- built-in modules only (`crypto`, `fs`, `path`);
- no dynamic import, `eval` or child process;
- no dependencies.

## End to end on our development site (23 November 2026)

**Setup:**

- The site was our own development Confluence Cloud site, with test pages in a personal space.
- The script's own `src/` code ran unchanged. On 23 November, its `fetch` was bridged into a signed-in browser session.
- On 24 November, the owner ran the command line itself with a classic API token, on page 47742978:
  - the dry run planned 2 moves;
  - apply saved version 6, and the after-save check passed;
  - undo restored the content of version 5 as version 7, and the check passed.

  So sign-in with an API token is tested end to end, for these three steps.

**Test pages:**

- 47284226: mixed macros, including hand-made `power-plant-uml-macro` and `plantuml-svg` macros;
- 47316993: a layout and a large diagram;
- 47742978: a macro inside a paragraph, and text with blank lines around it;
- 47349761 and 47382538: pages edited between the dry run and the apply.

| Step | Result |
|---|---|
| CQL search for the three macro names in one space | Found the test pages and an earlier avono test page; the limit stopped the search at 3 |
| Dry run | Moves planned; ditaa and wiki-tag macros left alone; only GET requests sent |
| First build, apply | **Stopped after one page.** The after-save check found that Confluence writes non-ASCII characters back as XHTML entities, which that build did not decode. The saved text was in fact correct. Fixed by decoding the XHTML entity set. Undo restored the page byte for byte |
| Apply | Every page checked. Each macro's text matched its SHA-256, in storage and in the editor's ADF format. Outside the new macros, every saved page was identical to the page before. Confluence only reorders the new macro's own settings |
| Reader view | Every moved diagram draws: a sequence diagram, unusual characters, a class diagram in a table, a layout cell, an inline macro (drawn on its own line), and text with blank lines around it |
| Large diagram | The 50,648-character diagram moved intact; the macro shows its own "too large to draw" message (43,590 px tall, over its 16,384 px limit) |
| `{plantuml}` wiki tags | When moved as they were, the macro showed an error. **Changed:** such macros are now left alone |
| Page edited after the dry run | Apply stopped; nothing was written to that page |
| Save from a stale version | Confluence refused it with HTTP 409 |
| Undo, with one page edited after the move | The dry run listed it. `--apply` wrote nothing. `--apply --skip-edited` restored the other pages byte for byte |
| `--reference-page` (a page saved by the macro's editor, development app) | The new macros got the development key and drew. Undo restored the pages byte for byte |
| After the review fixes, full run (3 pages, 7 moves) | Applied, checked, and undone byte for byte |

**Where the test pages stand now:**

- 47284226, 47316993 and 47742978 hold their original content again;
- 47349761 and 47382538 are left in their edited state;
- nothing was deleted.

## Reviews

- **Code review (Sonnet).** It found two bugs. `--macro` restricted only the search, not the rewrite. A page given twice with `--page` was planned twice. It also found four robustness gaps: a lost log line, a cut-off log, a deleted page during undo, and attributes Confluence adds to other macros. All are fixed and tested.
- **Security and trust review (Fable).** Verdict: publish after fixes. Fixed:
  - **After-save check:** it now also covers the text outside the macros.
  - **503 on a save:** it is no longer retried.
  - **Undo:** it restores only pages that still hold the macros this run saved.
  - **App IDs:** only the Eriksen Labs app's IDs are accepted.
  - **PowerPlantUML:** its `language` setting is checked.
  - **Report:** titles are escaped.
  - **Output files:** they are made private to the user.
  - **Command line:** a stray argument is not printed.
  - **Docs:** the README states what the files contain, what was not tested, and the limits.

  The review's last blocker, a real API-token run, was done on 24 November (see above).
