# Security

This script runs with your Atlassian API token and can change Confluence
pages, so please report anything that could leak the token, write to a page
it should not, or lose diagram text.

**Report privately** to security@eriksenlabs.com, or to support@eriksenlabs.com
with "security" in the subject. Don't open a public issue. Don't attach
plans, reports or logs: they hold page titles and diagram text. Describe what
you saw, with the version (git tag) you ran.

As on our security page (https://eriksenlabs.com/security): acknowledged
within 1 business day, assessed within 3 business days, and fixes released as
soon as they are ready, ahead of other work.

**What to check yourself before running it:**
- that you run a tagged release (`git describe --tags`);
- that `bin/` and `src/` are all the code, with no dependencies (`package.json`);
- that the only network call is `src/confluence.js`, to the `--site` you give.
