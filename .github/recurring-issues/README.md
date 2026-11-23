# Recurring issues

Opens tracking issues automatically, so the ones we always forget stop depending
on somebody remembering.

Two trigger classes:

- `kind: time` for anything that comes round on a cadence, like a credential
  rotation. Buckets time since `anchor` into `every_days` windows.
- `kind: version` for a tool version moving in someone else's repository. Reads
  a remote file and pulls the version out with a regex.

## Dedupe

Every issue carries a marker in its body, for example
`<!-- recurring-issue:maven-tool-upgrade:3.10.2 -->`. Before creating anything
the workflow searches the repo for that marker, open **and** closed, and refuses
to create a duplicate. A closed rotation issue means the work was done, so
reopening a copy would just be noise.

For time entries the marker holds the period bucket rather than a date, so any
two runs inside the same window produce the same marker. That is what makes
re-runs and overlapping runs harmless.

## Adding an entry

Edit `manifest.yaml`, add a template under `templates/`. Placeholders are
`{{version}}` for version entries, `{{period}}` and `{{since}}` for time
entries, and `{{id}}` for both.

## Running it

`workflow_dispatch` defaults to dry run, which reports what it would open
without creating anything. The scheduled run creates for real.

## Tests

`node .github/recurring-issues/engine.test.js`

The logic lives in `engine.js` with no GitHub dependency, so it is testable
without Actions. The workflow only supplies the real API calls.
