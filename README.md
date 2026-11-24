# confluence-plantuml-migrate

A free, open-source command-line script for Confluence Cloud administrators.
It finds pages with old PlantUML macros (whether or not another app still
draws them) and moves each one into the **PlantUML Diagram** macro of the
Marketplace app *Mermaid, PlantUML & OpenAPI Diagrams for Confluence*
(Eriksen Labs). The diagram text is kept exactly, character for character.

You run it yourself, on your own computer, with your own API token. The app
itself never reads or changes your pages and asks for no permission to do
so. This script does the writing, with your account, and only when you tell
it to.

> **Read this first.**
> - It changes Confluence pages. Run the dry run, read its report, and try
>   it on one test space before any real one.
> - If another installed app still draws these macros, moving them replaces
>   a working diagram with ours.
> - Every change is a normal page save, so Confluence keeps the earlier
>   version, and you can restore it with this script's `--undo` or by hand
>   from the page history. Each save adds a version, with your account as
>   its editor and "PlantUML macro move" as its note.
> - Apply only a plan, and undo only a log, that this script wrote on your
>   machine.
> - Review and run a tagged release (see Releases), not whatever the main
>   branch holds that day.
> - It is provided as is, without warranty (see [LICENSE](LICENSE)).

## What it moves

It moves only these exact macro names, and only when the diagram text is in
the macro's body:

| Old macro name | From | Moved when |
|---|---|---|
| `plantuml` | PlantUML for Confluence by avono, on pages moved from Data Center | `type` is absent, `uml` or `plantuml` |
| `power-plant-uml-macro` | PowerPlantUML (Skylab Ventures), on Connect | the `uml`, `url` and `encodedUML` settings are empty, and `language` is absent, `plantuml` or `uml` |
| `plantuml-svg` | PlantUML SVG for Confluence (Grovr), on Connect | `remoteurl` is empty |

- **avono's `plantuml`:** the rules come from pages migrated from Data
  Center that we built and tested.
- **The two Connect macros:** the rules come from each app's public
  descriptor. We have not installed those apps, and the script has not been
  run on pages they made. Try one page first.

**Left alone, listed in the report and never changed:**

- any other macro, including other PlantUML macros such as `plantumlrender`
  and the macros of other apps;
- a macro whose text is somewhere else: in a setting, compressed, at a web
  address or in a file;
- ditaa, Graphviz (dot) and the other diagram types the PlantUML Diagram
  macro does not draw;
- text wrapped in old `{plantuml}` wiki tags. Kept exactly, the new macro
  cannot draw it, so move those by hand without the tags;
- an empty macro, a macro with a setting the script does not know, and
  anything it cannot read with certainty.

**What carries over:** the diagram text. **What does not:** the old macro's
display settings (title, alignment, format and border). The report lists
them for each macro. If you need alignment, set it in the new macro's
editor.

## What it never does

- **It changes nothing outside the old macros.** It sends Confluence a page
  in which only the old macros are replaced; every other character is the
  same, and it checks this before saving.
- **It checks every save.** After saving, it reads the page back and checks:
  - each new macro holds its exact text;
  - every other macro is unchanged;
  - every character outside the new macros is as it was before.

  If a check fails, it stops. That page is already saved, so undo it.
- **It sends nothing anywhere except to the address you give with `--site`.**
  - There is no telemetry and no update check.
  - It has no dependencies. The code in `bin/` and `src/` is all of it, and
    it uses only Node's built-in `crypto`, `fs` and `path`.
- **It writes macros only with the Eriksen Labs app's key.** It writes them
  with that app's key in Atlassian's cloud, Isolated Cloud or Government
  Cloud, and refuses any other key.
- **It never takes the token on the command line.** It never prints the
  token and never writes it to the plan, the report or the log.
- **It never writes to Confluence during a dry run.**

## What the files contain

- **`report.md`:** the full text of every diagram found, and page titles,
  including from restricted pages.
- **`plan.json` and the log:** page ids and titles.

The script creates the folder and the files for your user only (on
systems that honor file modes). Keep them to yourself and delete them when
you are done. Don't send them to us or anyone else. If you write to us,
describe the problem, or send only lines you have checked.

`--verbose` prints the whole report, diagram text included, to the
terminal.

## Before you start

1. **Install the app** that provides the PlantUML Diagram macro on your
   site. It is on the Atlassian Marketplace as *Mermaid, PlantUML & OpenAPI
   Diagrams for Confluence*. Moved macros draw only where it is installed.
2. **Install Node.js 22 or later.** Check with `node --version`. Tested with
   Node 24.
3. **Create an Atlassian API token** for an account that can view and edit
   the pages, at
   <https://id.atlassian.com/manage-profile/security/api-tokens> ("Create
   API token").
   - Use a classic token, and give it a short expiry.
   - The token can do anything the account can do, across Atlassian
     products. Treat it like a password and revoke it when you are done.
4. **Get the script.** Download a tagged release from this repository, or
   clone it:

   ```
   git clone --branch v0.1.0 https://github.com/rolfe099-sketch/confluence-plantuml-migrate.git
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

   When you are done, remove them with `Remove-Item Env:CONFLUENCE_API_TOKEN`
   or `unset CONFLUENCE_API_TOKEN`.

## Step 1: dry run

```
node bin/confluence-plantuml-migrate.js --site https://your-site.atlassian.net --space DOCS
```

It searches the space for the three macro names, reads each page, and
writes two files in a new folder, `plantuml-migrate-<time>`:

- **`report.md`:** every page and every old macro found. For each macro it
  shows the exact storage-format XML **before** and **after**, or the reason
  the macro is left alone.
- **`plan.json`:** what the apply step will do, page by page, with each
  page's version. The dry run prints its SHA-256.

Nothing is written to Confluence. Read the report.

Useful options:

| Option | What it does |
|---|---|
| `--page 123456` | only that page; repeat it for more pages |
| `--macro plantuml` | only that old macro; repeat it for more |
| `--limit 10` | at most 10 pages (the default is 25) |
| `--all-spaces` | every space the account can see, instead of `--space` |

## Step 2: apply

```
node bin/confluence-plantuml-migrate.js --site https://your-site.atlassian.net --apply --plan plantuml-migrate-<time>/plan.json
```

It prints the plan's SHA-256, then does exactly what the plan says, one
page at a time:

1. It reads the page again. If anyone saved it since the dry run, the run
   **stops**, and nothing is written to that page.
2. It writes a line to the log. Then it saves the page as a new version,
   numbered from the version it read, so Confluence refuses the save if the
   page changed in that moment.
3. It reads the page back and checks it.
4. It waits two seconds (`--pause`) and goes on to the next page.

It **stops at the first problem** of any kind. Pages are saved as minor
edits, so watchers are not notified; `--notify` notifies them.

The log, `changes-<time>.jsonl`, sits next to the plan. For each page it
records:

- the page id and title;
- the version before and after;
- each macro moved: its name, a SHA-256 of its text, and the new macro's id.

Keep the log: undo needs it.

## Step 3: look

Open a few pages. Each moved diagram draws from its text. The macro saves a
picture of itself the next time someone opens it in the editor and saves
the page. Until then:

- the page and PDF export draw the diagram live;
- Word export and email show the text as a code block.

## Undo

```
node bin/confluence-plantuml-migrate.js --site https://your-site.atlassian.net --undo plantuml-migrate-<time>/changes-<time>.jsonl
```

Without `--apply`, this is a dry run: it lists each page it would restore.

With `--apply`, it saves the content of each page's version before the move,
as a new version. Before writing anything, it checks every page:

- **A page edited after the move, deleted, or no longer holding the macros
  this run saved:** nothing is written to any page. Add `--skip-edited` to
  restore the other pages and leave those pages for you to restore by hand
  from their page history.
- **A run cut off while saving a page:** if the page holds the new macros
  that the log names, the script restores it. Otherwise it lists the page
  for you to check.

Undo depends on page history. If your site's retention rules trim old
versions, restore those pages by hand, or not at all.

## Other clouds

Outside `atlassian.net`, for example in Atlassian Government Cloud, add a
reference page. Do the same whenever you want to be certain of the macro's
key.

1. Insert one PlantUML Diagram macro on any page, and save the page.
2. Give that page's id to the dry run:

   ```
   node bin/confluence-plantuml-migrate.js --site https://your-site.example --space DOCS --reference-page 123456
   ```

The new macros then carry the key of the app installed on your site. On
`atlassian.net` without a reference page, the script uses the key of the
app's production version in Atlassian's normal cloud.

Not tested on Isolated Cloud or Government Cloud. Run the dry run and one
test page first, and tell us what you see.

## Limits and known behavior

- **Very large diagrams** move whole. The PlantUML Diagram macro does not
  draw a diagram larger than 16,384 pixels on a side. It says so on the
  page, as it would for the same text pasted by hand.
- **`!include` lines** move as text. The macro does not fetch files or web
  addresses, so those diagrams will not draw as before.
- **A macro inside a paragraph** becomes a diagram on its own line, between
  the paragraph's two halves.
- **Only pages are searched.** Blog posts are not.
- **Search uses Confluence's index.** A page saved in the last few minutes
  may not be found yet; `--page` reads a page directly.
- **Pages someone is editing** with unpublished changes were not tested. Ask
  people to publish or close their edits first.
- **Page restrictions apply.** A page the account cannot edit stops the run
  with an error from Confluence.
- **Retries:**
  - When Confluence asks it to slow down (HTTP 429), it waits and asks
    again.
  - When a read gets HTTP 503, it asks again.
  - Any other error stops the run, including a 503 on a save.
- **It uses Confluence's REST API:** v2 to read, and v1 to search and to
  save as a minor edit. Tested on 23 November 2026.

## How it was tested

- **Unit tests:** 52 (`npm test`). The fixtures are written from avono's
  real storage format and, for the two Connect macros, from their public
  descriptors. Details are in [TESTING.md](TESTING.md).
- **End to end, on our development Confluence Cloud site:** a dry run,
  apply, the page view, and undo, on test pages built from avono's storage
  format and on hand-made pages for the Connect macro names.
  - A page edited between the dry run and the apply stopped the run before
    any write.
  - Confluence refused a stale save with 409.
  - Undo restored every page to its original storage, byte for byte.
- **With an API token:** on 24 November 2026, a dry run, apply and undo
  ran on one test page of the same site, signed in with a classic API
  token. The page was checked after the save, and undo restored it.

## Releases

Each release is a git tag, such as `v0.1.0`. Review the code at that tag
and run that tag.

## Security

To report a security problem, see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

The names avono, PowerPlantUML, PlantUML SVG for Confluence and their
makers are used only to identify the macros this script reads. This project
is not affiliated with them.
