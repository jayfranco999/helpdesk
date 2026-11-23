// Decision engine for recurring helpdesk issues.
//
// Deliberately has no GitHub dependency: it takes plain data in and returns a
// list of issues to create. That is what makes it testable on a laptop instead
// of only inside a workflow run.
//
// Two trigger classes, as laid out in helpdesk#3419:
//   kind: time    -> open an issue once per period (rotation, review, audit)
//   kind: version -> open an issue when a version in someone else's code moves
//
// Dedupe is the whole ballgame. Every issue carries a deterministic marker in
// its body, and we refuse to create one if any issue already carries it, open
// OR closed. Closed counts: a closed rotation issue means the work was done,
// reopening a duplicate is noise.

'use strict';

/** Render {{placeholders}} from a flat map. Unknown placeholders are left alone. */
function render(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  );
}

/**
 * Which period are we in?
 * Buckets time since an anchor into fixed windows, so a run anywhere inside a
 * window produces the same label and therefore the same dedupe marker. That is
 * what stops an overlapping or re-run workflow double-creating.
 */
function periodLabel(entry, now) {
  const anchor = Date.parse(entry.anchor || '1970-01-01T00:00:00Z');
  const days = Number(entry.every_days);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`entry ${entry.id}: every_days must be a positive number`);
  }
  const windowMs = days * 86400000;
  const elapsed = now - anchor;
  if (elapsed < 0) return null; // anchor is in the future, nothing due yet
  const bucket = Math.floor(elapsed / windowMs);
  const start = new Date(anchor + bucket * windowMs);
  return { bucket: String(bucket), since: start.toISOString().slice(0, 10) };
}

/** Pull a version out of fetched text with the entry's pattern. */
function extractVersion(entry, text) {
  if (text == null) return null;
  const re = new RegExp(entry.source.pattern, 'm');
  const m = re.exec(text);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * @param {object}   opts
 * @param {object[]} opts.entries      parsed manifest entries
 * @param {number}   opts.now          epoch ms
 * @param {function} opts.fetchText    async (url) => string|null
 * @param {function} opts.findByMarker async (marker) => bool, true if an issue already carries it
 * @param {function} opts.readTemplate async (path) => string
 * @returns {Promise<{create: object[], skip: object[], errors: object[]}>}
 */
async function plan({ entries, now, fetchText, findByMarker, readTemplate }) {
  const create = [];
  const skip = [];
  const errors = [];

  for (const entry of entries) {
    try {
      if (entry.enabled === false) {
        skip.push({ id: entry.id, reason: 'disabled in the manifest' });
        continue;
      }

      let vars;
      if (entry.kind === 'version') {
        const text = await fetchText(entry.source.url);
        const version = extractVersion(entry, text);
        if (!version) {
          // Fail loudly. A silent no-op here looks identical to "nothing to do"
          // and would hide a moved file or a changed line format for months.
          errors.push({ id: entry.id, reason: `could not read a version from ${entry.source.url}` });
          continue;
        }
        if (entry.baseline && version === entry.baseline) {
          skip.push({ id: entry.id, reason: `still at the baseline ${version}` });
          continue;
        }
        vars = { version, id: entry.id };
      } else if (entry.kind === 'time') {
        const period = periodLabel(entry, now);
        if (!period) {
          skip.push({ id: entry.id, reason: `anchor ${entry.anchor} is in the future` });
          continue;
        }
        vars = { period: period.bucket, since: period.since, id: entry.id };
      } else {
        errors.push({ id: entry.id, reason: `unknown kind ${entry.kind}` });
        continue;
      }

      const marker = render(entry.dedupe_marker, vars);
      if (await findByMarker(marker)) {
        skip.push({ id: entry.id, reason: `an issue already carries ${marker}` });
        continue;
      }

      const bodyTemplate = await readTemplate(entry.body_template);
      const body = `${render(bodyTemplate, vars).trimEnd()}\n\n<!-- ${marker} -->\n`;

      create.push({
        id: entry.id,
        title: render(entry.title, vars),
        body,
        labels: entry.labels || [],
        marker,
      });
    } catch (err) {
      errors.push({ id: entry.id, reason: err.message });
    }
  }

  return { create, skip, errors };
}

module.exports = { plan, render, periodLabel, extractVersion };
