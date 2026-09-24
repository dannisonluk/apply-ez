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

// ── list headings, unmarked lists, and page furniture ────────────────────────
//
// The real shape from Cathay Pacific, whose adapter flattens HTML to text and loses
// the `<li>` markers. The items arrive one per line with nothing to mark them as a
// list, so the heading is the only signal that they are one — without this they
// render as a stack of one-line paragraphs, which does not look like a job posting.
const cathay = buildJdSections({
  description: [
    'Application deadline: 02 Oct 2026',
    'Role Introduction',
    'Drive the evolution of distribution capabilities.',
    'Partnering closely with project teams, you will gather requirements.',
    'Key Responsibilities',
    'Drive continuous improvement initiatives.',
    'Collaborate with project teams to gather requirements.',
    'Requirements',
    "Bachelor's Degree with at least 5 years of experience.",
    'Good data analysis and numerical skills.',
  ].join('\n'),
});
check('cathay: "Role Introduction" is recognised as a heading', cathay[0]?.heading, 'Role Introduction');
check(
  'cathay: the deadline line is dropped as page furniture',
  JSON.stringify(cathay).includes('Application deadline'),
  false,
);
check(
  'cathay: prose under an intro heading stays prose',
  cathay[0]?.blocks.every((b) => b.kind === 'paragraph'),
  true,
);
check('cathay: an unmarked list under "Key Responsibilities" becomes bullets', cathay[1]?.blocks, [
  {
    kind: 'bullets',
    items: [
      'Drive continuous improvement initiatives.',
      'Collaborate with project teams to gather requirements.',
    ],
  },
]);
check('cathay: "Requirements" likewise', cathay[2]?.blocks[0]?.kind, 'bullets');
check(
  'cathay: the list items are kept, not merged',
  cathay[2]?.blocks[0]?.kind === 'bullets' ? cathay[2]!.blocks[0]!.items.length : 0,
  2,
);

// ── multi-word list headings ─────────────────────────────────────────────────
//
// The real AIA shape (Workday). Its headings are not the bare "Requirements" a strict
// allow-list would expect — they are "Roles and Responsibilities" and "Minimum Job
// Requirements". Matching the whole heading against a fixed list produced zero
// bullets on every Workday posting, which is why the rule matches the keyword
// anywhere in the heading instead.
const aia = buildJdSections({
  description: [
    'About the Role',
    'You will join the actuarial team.',
    'Roles and Responsibilities',
    'Support the valuation of reserves.',
    'Prepare monthly reporting packs.',
    'Minimum Job Requirements',
    'Degree in actuarial science.',
    'Progress towards a professional qualification.',
  ].join('\n'),
});
check('aia: "About the Role" is a heading', aia[0]?.heading, 'About the Role');
check('aia: "Roles and Responsibilities" is a heading', aia[1]?.heading, 'Roles and Responsibilities');
check('aia: its items become bullets', aia[1]?.blocks[0]?.kind, 'bullets');
check(
  'aia: both items are kept',
  aia[1]?.blocks[0]?.kind === 'bullets' ? aia[1]!.blocks[0]!.items.length : 0,
  2,
);
check('aia: "Minimum Job Requirements" is a list too', aia[2]?.blocks[0]?.kind, 'bullets');
check('aia: prose under "About the Role" stays prose', aia[0]?.blocks[0]?.kind, 'paragraph');

// The guard that makes the keyword rule safe: a prose sentence that merely contains
// one of the keywords must stay prose. Without the length and terminal-punctuation
// checks, relaxing the allow-list would turn sentences into headings.
const sentenceWithKeyword = buildJdSections({
  description: [
    'You will support the responsibilities of the team.',
    'You will own the requirements for the project.',
  ].join('\n'),
});
check(
  'keyword guard: sentences containing keywords stay prose',
  sentenceWithKeyword.length === 1 && sentenceWithKeyword[0]?.heading === null,
  true,
);
check(
  'keyword guard: both lines are paragraphs, not bullets',
  sentenceWithKeyword[0]?.blocks.every((b) => b.kind === 'paragraph'),
  true,
);

// ── Chinese postings ─────────────────────────────────────────────────────────
//
// Half the board is Chinese, and CJK breaks the Latin assumptions in two places.
// There are no spaces, so a word-count guard does not bound a line: every Chinese
// sentence is "one word". A CLP bullet ending in 要求 was therefore read as a heading
// because 要求 is in the section vocabulary, which silently stole it from the bullet
// list above it. CJK lines are measured in characters instead.
const chinese = buildJdSections({
  description: [
    '辦公室地點： 葵涌區',
    '僱傭期： 兩年合約 （可續約）',
    '職務：',
    '按有關規格、程序及標準，進行高壓及低壓電力設備及相關系統的調試',
    '提供適當技術支援，以確保維修工作符合有關品質及安全要求',
    '資格：',
    '具中三或以上程度',
    '持有A級電業工程人員註冊證明',
  ].join('\n'),
});
check('cjk: the intro keeps its two lines', chinese[0]?.heading, null);
check('cjk: 職務 is a heading', chinese[1]?.heading, '職務');
check(
  'cjk: BOTH duties are bullets — the one containing 要求 must not become a heading',
  chinese[1]?.blocks[0]?.kind === 'bullets' ? chinese[1]!.blocks[0]!.items.length : 0,
  2,
);
check('cjk: 資格 is a heading', chinese[2]?.heading, '資格');
check(
  'cjk: both qualifications are kept',
  chinese[2]?.blocks[0]?.kind === 'bullets' ? chinese[2]!.blocks[0]!.items.length : 0,
  2,
);
check('cjk: no stray section was created', chinese.length, 3);
check(
  'cjk: a long Chinese sentence is never a heading',
  buildJdSections({ description: '本職位要求應徵者具備良好的溝通能力及團隊合作精神，並能獨立處理日常工作' })
    .length === 1 &&
    buildJdSections({ description: '本職位要求應徵者具備良好的溝通能力及團隊合作精神，並能獨立處理日常工作' })[0]
      ?.heading === null,
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
