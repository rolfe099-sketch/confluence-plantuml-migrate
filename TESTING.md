# Test results

## Unit tests

`npm test` (Node 24.12 on Windows, 23 November 2026): every test passes. The tests cover:

- **What gets moved:**
  - avono's `plantuml` in both its forms (`ac:structured-macro` and the older `ac:macro`);
  - PowerPlantUML's `power-plant-uml-macro` and Grovr's `plantuml-svg`.
- **What gets left alone, with its reason in the report:**
  - ditaa and dot;
  - text kept in a setting or at a web address;
  - unknown settings;
  - empty bodies, rich-text bodies and settings given twice;
  - text in `{plantuml}` wiki tags;
  - characters that XML cannot hold;
  - unknown entities.
- **Page shapes:** several macros on one page, and macros in tables, expands and layouts.
- **Text kept exactly:**
  - a diagram of 300,000 characters;
  - Chinese, Hebrew and emoji;
  - a no-break space, quotes, `&`, `<`;
  - tabs, CR and CRLF line ends;
  - `]]>` split across CDATA sections;
  - markup-like text inside CDATA;
  - the XHTML named entities that Confluence writes back. All 251 names were checked against Chrome's own decoder. `&lang;` and `&rang;` are left out on purpose, because their meaning differs between HTML 4 and HTML5.
- **Safety:**
  - broken storage is refused;
  - every value in the new macro is escaped;
  - the check that nothing outside the macros changed;
  - the check after saving.
- **Runs (against a fake Confluence with page history):**
  - a dry run sends only GET requests;
  - apply follows the plan, saves minor edits, logs each step and checks each save;
  - a page edited after the dry run stops the run before any write;
  - a page saved between our read and our write gets a 409 conflict, and the run stops;
  - the run stops at its first error, and later pages are not touched;
  - `--limit` is honored;
  - undo restores the old content exactly;
  - undo refuses to run while an edited page is in the log, unless given `--skip-edited`;
  - a plan made for another site is refused;
  - a site outside atlassian.net requires `--reference-page`;
  - the site address must be https and have no path;
  - a 429 response is waited out, and nothing else is retried.
- **Command line:**
  - `--token` is refused, and the token never appears in the output;
  - `--apply` needs `--plan`;
  - there is no telemetry: there is one fetch call, no network modules and no dependencies.

## End to end on a development site (23 November 2026)

The site was eriksen.atlassian.net, our own development site, with test pages under the LAB pages in a personal space. The script's own `src/` code ran unchanged. Only its `fetch` was bridged into a signed-in browser session, because no API token was used. So the one thing not tested end to end is the Basic authentication header itself.

**Test pages:**
- 47284226, mixed macros;
- 47316993, a layout and a large diagram;
- 47349761 and 47382538, pages edited between the dry run and the apply.

| Step | Result |
|---|---|
| CQL search for the three macro names in one space | Found the test pages and an earlier avono test page; the limit stopped the search at 3 |
| Dry run | 8 moves planned. ditaa was left alone. Only GET requests were sent |
| Apply, first build | **Stopped after one page.** The check after saving found that Confluence writes non-ASCII characters back as XHTML entities, which that build did not decode. The saved text was in fact correct. Fixed by decoding the XHTML entity set |
| Undo of that page | Restored, byte for byte |
| Apply, fixed build | 2 pages changed and checked. The text of every macro matched its SHA-256, both in storage format and in the editor's ADF format |
| Reader view | Every moved diagram draws: sequence, the unusual characters, the class diagram in a table, the layout cell. The 50,648-character diagram moved intact; the macro shows its own "too large to draw" message for it (43,590 px tall, over the 16,384 px limit) |
| `{plantuml}` wiki tags | Moved as they were, the macro showed an error. **Changed:** such macros are now left alone and reported |
| Page edited after the dry run | Apply stopped. Nothing was written to that page |
| Save from a stale version | Confluence refused it with HTTP 409 |
| Undo with one page edited after the move | The dry run listed the edited page. `--apply` refused to write anything. `--apply --skip-edited` restored the other 2 pages, byte for byte, and left the edited page alone |
| `--reference-page` (a page saved by the macro's editor, development app) | The new macros got the development key and drew. Undo restored both pages, byte for byte |

**State after the tests:**
- the mixed and layout pages hold their original content again;
- 47349761 and 47382538 are test pages left in their edited state;
- nothing was deleted;
- every page created is listed in `D:\tmp\pum-check\created.log`.
