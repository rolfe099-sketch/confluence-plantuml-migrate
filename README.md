# confluence-plantuml-migrate

A free, open-source command-line script for Confluence Cloud administrators.
It finds pages with old PlantUML macros that no longer draw, and moves each
one into the **PlantUML Diagram** macro of the Marketplace app
*Mermaid, PlantUML & OpenAPI Diagrams for Confluence* (Eriksen Labs). The
diagram text is kept exactly, character for character.

You run it yourself, on your own computer, with your own API token. The app
itself never reads or changes your pages and asks for no permissions to do
so; this script does the writing, with your account, and only when you tell
it to.

> **Read this first.**
> - It changes Confluence pages. Run the dry run, read its report, and try
>   it on one test space before any real one.
> - Every change is a normal page save, so Confluence keeps the earlier
>   version and you can restore it, with this script's `--undo` or by hand
>   from the page history.
> - It is provided as is, without warranty (see [LICENSE](LICENSE)). If
>   something looks wrong, stop and write to support@eriksenlabs.com.

## What it moves

Only these exact macro names, and only when the diagram text is in the
macro's body:

| Old macro name | From | Moved when |
|---|---|---|
| `plantuml` | PlantUML for Confluence by avono, on pages moved from Data Center | the body holds the text, and `type` is absent, `uml` or `plantuml` |
| `power-plant-uml-macro` | PowerPlantUML (Skylab Ventures), on Connect | the body holds the text, and the `uml`, `url` and `encodedUML` settings are empty |
| `plantuml-svg` | PlantUML SVG for Confluence (Grovr), on Connect | the body holds the text, and `remoteurl` is empty |

The macro names and settings come from a page migrated from Data Center
(avono) and from the Connect apps' public descriptors. We did not install the
Connect apps.

**Left alone and listed in the report, never changed:**

- any other macro, including other PlantUML macros (`plantumlrender`, and
  the macros of other apps);
- a macro whose text is somewhere else: in a setting, compressed, at a web
  address or in a file;
- ditaa, Graphviz (dot) and other diagram types the PlantUML Diagram macro
  does not draw;
- text wrapped in old `{plantuml}` wiki tags. Kept exactly, the new macro
  cannot draw it, so move those by hand without the tags;
- an empty macro, a macro with a setting the script does not know, and
  anything it cannot read with certainty.

**What carries over:** the diagram text. **What does not:** the old macro's
display settings (title, alignment, format, border). The report lists them
for each macro. Set alignment in the new macro's editor if you need it.

## What it never does

- It never changes anything on a page outside the old macros. Before
  saving, it checks that every other character of the page is the same.
  After saving, it reads the page back and checks that each new macro holds
  its exact text and that every other macro is still there. If a check
  fails, it stops.
- It never sends anything anywhere except to your own Confluence site. No
  telemetry, no update check, no other web address. It has no dependencies:
  the code in `bin/` and `src/` is all of it.
- It never takes the token as a command-line argument, never prints it and
  never writes it to the plan, report or log.
- It never writes during a dry run.

## Before you start

1. **Install the PlantUML Diagram macro's app** on your site, from the
   Atlassian Marketplace: *Mermaid, PlantUML & OpenAPI Diagrams for
   Confluence*. Moved macros draw only where it is installed.
2. **Node.js 22 or later** (`node --version`).
3. **An Atlassian API token** for an account that can view and edit the
   pages: <https://id.atlassian.com/manage-profile/security/api-tokens>,
   "Create API token". Use a classic token. Treat it like a password and
   revoke it when you are done.
4. **Get the script.** Download this repository, or:

   ```
   git clone https://github.com/OWNER/confluence-plantuml-migrate.git
   cd confluence-plantuml-migrate
   ```

   There is nothing to install. `npm test` runs the tests if you want to.

5. **Set the two environment variables** in the terminal you will use.

   PowerShell:

   ```powershell
   $env:CONFLUENCE_EMAIL = "you@example.com"
   $env:CONFLUENCE_API_TOKEN = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'API token')).Password
   ```

   macOS or Linux:

   ```sh
   export CONFLUENCE_EMAIL=you@example.com
   read -rs CONFLUENCE_API_TOKEN && export CONFLUENCE_API_TOKEN
   ```

## Step 1: dry run

```
node bin/confluence-plantuml-migrate.js --site https://your-site.atlassian.net --space DOCS
```

It searches the space for the three macro names, reads each page and writes
two files in a new folder `plantuml-migrate-<time>`:

- `report.md`: every page, every old macro found, and for each one the exact
  storage-format XML **before** and **after**, or the reason it is left
  alone;
- `plan.json`: what the apply step will do, page by page, with each page's
  version.

Nothing is written to Confluence. Read the report.

Useful options: `--page 123456` (only that page; repeat it), `--macro plantuml`
(only that old macro), `--limit 10` (at most 10 pages; the default is 25),
`--all-spaces` (every space the account can see, instead of `--space`).

## Step 2: apply

```
node bin/confluence-plantuml-migrate.js --site https://your-site.atlassian.net --apply --plan plantuml-migrate-<time>/plan.json
```

It does exactly what the plan says, one page at a time:

1. reads the page again; if anyone saved it since the dry run, it **stops**
   and writes nothing to it;
2. writes a line to the log, then saves the page as a new version, numbered
   from the version it read, so Confluence refuses the save if the page
   changed in that moment;
3. reads the page back and checks it;
4. waits two seconds (`--pause`), then goes on to the next page.

It **stops at the first problem** of any kind. Pages are saved as minor
edits, so watchers are not notified; `--notify` notifies them.

The log, `changes-<time>.jsonl` next to the plan, records for each page its
id, title, version before and after, and each macro moved (its name and a
SHA-256 of its text). Keep it: it is what undo needs.

## Step 3: look

Open a few pages. Each moved diagram draws from its text. The macro saves a
picture of itself the next time someone opens it in the editor and saves the
page; until then, the page and PDF export draw it live, and Word export and
email show the text as a code block.

## Undo

```
node bin/confluence-plantuml-migrate.js --site https://your-site.atlassian.net --undo plantuml-migrate-<time>/changes-<time>.jsonl
```

Without `--apply` this is a dry run: it lists each page it would restore.
With `--apply` it saves, for each page, the content of the version before
the move, as a new version. It checks every page first and writes nothing
if any was edited after the move; `--skip-edited` restores the others and
leaves edited pages for you to restore by hand from their page history.

## Other clouds

Outside `atlassian.net` (for example Atlassian Government Cloud), and
whenever you want to be certain of the macro's key, add a reference page:
insert one PlantUML Diagram macro on any page, save it, and give that page's
id to the dry run:

```
node bin/confluence-plantuml-migrate.js --site https://your-site.example --space DOCS --reference-page 123456
```

The new macros then carry the key of the app installed on your site. On
`atlassian.net` without a reference page, the script uses the key of the
app's production version on Atlassian's normal cloud.

## Limits and known behaviour

- **Very large diagrams** move whole. The PlantUML Diagram macro does not
  draw a diagram larger than 16,384 pixels on a side; it says so on the
  page, as it would for the same text pasted by hand.
- **Blog posts** are not searched; only pages.
- **Search** uses Confluence's index. A page saved in the last minutes may
  not be found yet; `--page` reads a page directly.
- **Pages someone is editing** with unpublished changes were not tested.
  Ask people to publish or close their edits first.
- **Page restrictions** apply: pages the account cannot edit stop the run
  with an error from Confluence.
- **Too many requests:** when Confluence asks it to slow down (HTTP 429),
  it waits and asks again; any other error stops the run.
- It uses Confluence's REST API (v2 to read, v1 to save as a minor edit and
  to search). Tested on 23 November 2026.

## How it was tested

- 34 unit tests (`npm test`) on fixtures written from the real storage
  formats: several macros on a page; macros in tables, expands and
  layouts; a 300,000-character diagram; Chinese, Hebrew, emoji, a no-break
  space, quotes, `&`, `<`, tabs, CR and CRLF line ends, `]]>` inside the
  text; broken storage; pages edited between the dry run and the apply;
  a save refused for a conflict; the stop on the first error; the limit;
  undo; and the command line refusing a token argument.
- End to end on a development Confluence Cloud site: dry run, apply, page
  view and undo on test pages, including a page edited between the dry run
  and the apply (the run stopped and wrote nothing to it) and a stale save
  (Confluence refused it with 409). Undo restored every page to its
  original storage, byte for byte.

## License

MIT. See [LICENSE](LICENSE).
