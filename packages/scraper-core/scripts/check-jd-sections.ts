/**
 * Regression check for the JD section parser.
 *
 * Run with:  pnpm --filter @apply-ez/scraper-core exec tsx scripts/check-jd-sections.ts
 *
 * This is the code that turns whatever an adapter scraped into the titled sections
 * the job detail page renders. It is pure and deterministic, so it is cheap to pin —
 * and it needs pinning, because both of the shapes it handles are easy to get subtly
 * wrong in a way nobody notices until the page looks broken:
 *
 *   - `sectionContent` is a named object, already titled. An array of strings is a
 *     BULLET LIST, and reading it as separate paragraphs loses that.
 *   - `description` is one blob, and its headings have to be recovered from the text.
 *     `parseSectionBlocks` cannot do this: its `stripHeadingPrefix` deletes a line
 *     that is exactly "Requirements:" or "Key responsibilities:", which is the shape
 *     most postings use. Hence the dedicated splitter this suite exists to protect.
 */
import assert from 'node:assert/strict';
import { buildJdSections } from '../src/types/section-content.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
  } catch {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

// ── sectionContent: already titled, arrays are lists ─────────────────────────

const named = buildJdSections({
  sectionContent: {
    roleIntroduction: 'We are looking for a Data Analyst.',
    keyResponsibilities: ['Build dashboards', 'Analyse claims data'],
    requirements: 'Requirements:\n- 3+ years SQL\n- Degree in a quantitative field',
  },
});
check('named: one section per provided field', named.length, 3);
check('named: headings in a fixed order', named.map((s) => s.heading), [
  'About the role',
  'Key responsibilities',
  'Requirements',
]);
check(
  'named: a string becomes a paragraph',
  named[0]?.blocks,
  [{ kind: 'paragraph', text: 'We are looking for a Data Analyst.' }],
);
check(
  'named: an array of strings becomes ONE bullet list, not three paragraphs',
  named[1]?.blocks,
  [{ kind: 'bullets', items: ['Build dashboards', 'Analyse claims data'] }],
);
check(
  'named: a prefixed string still yields clean bullets',
  named[2]?.blocks,
  [{ kind: 'bullets', items: ['3+ years SQL', 'Degree in a quantitative field'] }],
);
check(
  'named: omitted fields produce no empty sections',
  buildJdSections({ sectionContent: { roleIntroduction: 'Only this.' } }).length,
  1,
);

// ── description: headings recovered from a blob ──────────────────────────────

const blob = buildJdSections({
  description: [
    'About the role',
    'We need a Business Analyst for our cargo team.',
    '',
    'Key responsibilities:',
    '- Gather requirements',
    '- Write specifications',
    '',
    'Requirements:',
    '- 5 years experience',
    '- Cantonese and English',
  ].join('\n'),
});
check('blob: three sections', blob.length, 3);
check('blob: headings recovered', blob.map((s) => s.heading), [
  'About the role',
  'Key responsibilities',
  'Requirements',
]);
check(
  'blob: prose under the first heading',
  blob[0]?.blocks,
  [{ kind: 'paragraph', text: 'We need a Business Analyst for our cargo team.' }],
);
check(
  'blob: bullets stay with their own heading, not merged across sections',
  blob[1]?.blocks,
  [{ kind: 'bullets', items: ['Gather requirements', 'Write specifications'] }],
);
check(
  'blob: the second bullet run is its own section',
  blob[2]?.blocks,
  [{ kind: 'bullets', items: ['5 years experience', 'Cantonese and English'] }],
);

// Prose before any heading must still be shown, under a headingless section.
const leadIn = buildJdSections({ description: 'We are hiring.\n\nRequirements:\n- SQL' });
check('blob: lead-in prose gets its own headingless section', leadIn[0], {
  heading: null,
  blocks: [{ kind: 'paragraph', text: 'We are hiring.' }],
});
check('blob: the heading after it still splits', leadIn[1]?.heading, 'Requirements');

// A sentence must never be mistaken for a heading, however short.
const sentence = buildJdSections({ description: 'We are hiring.\n- First bullet' });
check(
  'blob: a full sentence is not a heading even when bullets follow',
  sentence.length === 1 && sentence[0]?.heading === null,
  true,
);

// ── bounds and degenerate input ──────────────────────────────────────────────

check('empty input yields nothing', buildJdSections({}), []);
check('blank description yields nothing', buildJdSections({ description: '   ' }), []);
check('null description yields nothing', buildJdSections({ description: null }), []);
check('empty arrays yield nothing', buildJdSections({ sectionContent: { requirements: [] } }), []);
check(
  'sectionContent wins when both are present',
  buildJdSections({
    sectionContent: { requirements: ['From sections'] },
    description: 'Requirements:\n- From blob',
  })[0]?.blocks,
  [{ kind: 'bullets', items: ['From sections'] }],
);

const many = buildJdSections({
  description: Array.from({ length: 40 }, (_, i) => `Section ${i}:\n- item ${i}`).join('\n'),
});
check('at most eight sections are kept', many.length <= 8, true);

const longItem = buildJdSections({
  sectionContent: { requirements: ['x'.repeat(5000)] },
});
const firstItem = longItem[0]?.blocks[0];
check(
  'a single item is truncated',
  firstItem?.kind === 'bullets' && firstItem.items[0]!.length,
  400,
);

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
