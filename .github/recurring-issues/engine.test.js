#!/usr/bin/env node
// Local tests for the recurring-issues engine. No network, no GitHub.
// Run: node lab/test-recurring-issues.js

'use strict';
const path = require('path');
const { plan, periodLabel, extractVersion } = require(
  path.join(__dirname, 'engine.js')
);

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  PASS: ${m}`); pass++; };
const bad = (m) => { console.log(`  FAIL: ${m}`); fail++; };
const step = (m) => console.log(`\n======== ${m}`);

const TEMPLATES = {
  'tpl/version.md': 'Upstream moved to {{version}}.',
  'tpl/time.md': 'Due for the period starting {{since}}.',
};
const readTemplate = async (p) => {
  if (!(p in TEMPLATES)) throw new Error(`no such template ${p}`);
  return TEMPLATES[p];
};

const versionEntry = (over = {}) => ({
  id: 'maven-tool-upgrade', kind: 'version', title: 'Maven {{version}} upgrade campaign',
  body_template: 'tpl/version.md', labels: ['triage'],
  source: { url: 'https://example.invalid/Dockerfile', pattern: '^ARG MAVEN_VERSION=(.+)$' },
  dedupe_marker: 'recurring-issue:{{id}}:{{version}}', ...over,
});

const timeEntry = (over = {}) => ({
  id: 'netlify-token-rotation', kind: 'time', every_days: 90,
  anchor: '2026-01-05T00:00:00Z', title: 'Rotate the Netlify token (period {{period}})',
  body_template: 'tpl/time.md', labels: ['triage'],
  dedupe_marker: 'recurring-issue:{{id}}:{{period}}', ...over,
});

const DOCKERFILE = 'FROM ubuntu\nARG MAVEN_VERSION=3.10.2\nRUN echo hi\n';
const NOW = Date.parse('2026-11-23T12:00:00Z');

const run = (opts) => plan({
  now: NOW, readTemplate,
  fetchText: async () => DOCKERFILE,
  findByMarker: async () => false,
  ...opts,
});

(async () => {
  step('1. version class fires and renders');
  let r = await run({ entries: [versionEntry()] });
  if (r.create.length === 1 && r.create[0].title === 'Maven 3.10.2 upgrade campaign') {
    ok('created with the version interpolated into the title');
  } else bad(`expected 1 create, got ${JSON.stringify(r.create.map(c => c.title))}`);
  if (r.create[0] && r.create[0].body.includes('<!-- recurring-issue:maven-tool-upgrade:3.10.2 -->')) {
    ok('dedupe marker embedded in the body');
  } else bad('marker missing from the body');

  step('2. dedupe: an existing issue blocks creation');
  r = await run({ entries: [versionEntry()], findByMarker: async () => true });
  if (r.create.length === 0 && r.skip.length === 1) ok('skipped because the marker already exists');
  else bad(`expected a skip, got create=${r.create.length} skip=${r.skip.length}`);

  step('3. version class at baseline does nothing');
  r = await run({ entries: [versionEntry({ baseline: '3.10.2' })] });
  if (r.create.length === 0 && /baseline/.test(r.skip[0]?.reason || '')) ok('skipped at baseline');
  else bad('baseline was not respected');

  step('4. an unreadable version is a LOUD error, not a silent no-op');
  r = await run({ entries: [versionEntry()], fetchText: async () => 'FROM ubuntu\n' });
  if (r.errors.length === 1 && r.create.length === 0) ok(`errored: ${r.errors[0].reason}`);
  else bad('a missing version did not raise an error');
  r = await run({ entries: [versionEntry()], fetchText: async () => null });
  if (r.errors.length === 1) ok('a failed fetch also errors rather than passing quietly');
  else bad('a null fetch did not error');

  step('5. time class fires for the current period');
  r = await run({ entries: [timeEntry()] });
  if (r.create.length === 1) ok(`created: ${r.create[0].title}`);
  else bad(`expected 1 create, got ${r.create.length}`);

  step('6. the period label is stable inside a window, so re-runs cannot double-create');
  const a = periodLabel(timeEntry(), Date.parse('2026-11-23T00:00:00Z'));
  const b = periodLabel(timeEntry(), Date.parse('2026-11-29T23:59:00Z'));
  const c = periodLabel(timeEntry(), Date.parse('2027-02-01T00:00:00Z'));
  if (a.bucket === b.bucket) ok(`same bucket ${a.bucket} six days apart, marker identical`);
  else bad(`bucket moved inside one window: ${a.bucket} vs ${b.bucket}`);
  if (c.bucket !== a.bucket) ok(`bucket advances to ${c.bucket} in the next window`);
  else bad('bucket never advances');

  step('7. an anchor in the future is skipped, not an error');
  r = await run({ entries: [timeEntry({ anchor: '2027-06-01T00:00:00Z' })] });
  if (r.create.length === 0 && r.errors.length === 0 && r.skip.length === 1) ok('skipped cleanly');
  else bad('future anchor mishandled');

  step('8. a bad every_days is an error');
  r = await run({ entries: [timeEntry({ every_days: 0 })] });
  if (r.errors.length === 1) ok(`errored: ${r.errors[0].reason}`);
  else bad('every_days=0 was accepted');

  step('9. enabled:false is honoured, and one bad entry does not stop the others');
  r = await run({ entries: [versionEntry({ enabled: false }), timeEntry()] });
  if (r.create.length === 1 && r.create[0].id === 'netlify-token-rotation') {
    ok('disabled entry skipped, the other still processed');
  } else bad('enabled:false or isolation broken');
  r = await run({ entries: [versionEntry({ kind: 'nonsense' }), timeEntry()] });
  if (r.errors.length === 1 && r.create.length === 1) ok('unknown kind errors while the valid entry still runs');
  else bad('one broken entry blocked the rest');

  step('10. extractVersion handles the real line shape');
  if (extractVersion(versionEntry(), DOCKERFILE) === '3.10.2') ok('parsed ARG MAVEN_VERSION=3.10.2');
  else bad('failed to parse the real line');

  step('RESULT');
  console.log(`  PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
