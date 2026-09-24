function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripHeadingPrefix(value: string): string {
  return value.replace(
    /^(?:job summary|summary|description|overview|key responsibilities|responsibilities|duties|qualifications|requirements|what you(?:'|’)ll do|what you will do|what we(?:'|’)re looking for|what we are looking for|the job|the person)\s*[:：-]?\s*/i,
    '',
  );
}

function stripBulletPrefix(value: string): string {
  return value.replace(/^(?:[-*•·◦▪‣–—]\s+|\d+[\.\)]\s+|[A-Za-z]\)\s+)/, '');
}

function cleanSectionLine(value: string): string {
  return stripBulletPrefix(stripHeadingPrefix(normalizeWhitespace(value))).trim();
}

function dedupeLines(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = cleanSectionLine(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 30) break;
  }
  return out;
}

function splitCandidateText(value: string): string[] {
  const normalized = normalizeWhitespace(value.replace(/\r/g, '\n'));
  if (!normalized) return [];

  const newlineSegments = normalized
    .split('\n')
    .map((line) => cleanSectionLine(line))
    .filter(Boolean);
  if (newlineSegments.length > 1) return dedupeLines(newlineSegments);

  const bulletSegments = normalized
    .split(/(?:\s+[•·◦▪‣]\s+|\s*[-–—]\s+(?=[A-Z0-9(])|\s+\d+[\.\)]\s+)/g)
    .map((line) => cleanSectionLine(line))
    .filter(Boolean);
  if (bulletSegments.length > 1) return dedupeLines(bulletSegments);

  const semicolonSegments = normalized
    .split(/\s*;\s+/g)
    .map((line) => cleanSectionLine(line))
    .filter(Boolean);
  if (semicolonSegments.length > 1) return dedupeLines(semicolonSegments);

  const single = cleanSectionLine(normalized);
  return single ? [single] : [];
}

function isBulletish(value: string): boolean {
  return /[\n•·◦▪‣]/.test(value) || /\d+[\.\)]\s+/.test(value) || /(?:^|\s)[-–—]\s+(?=[A-Z0-9(])/.test(value);
}

export function normalizeSectionValue(
  value: unknown,
): {
  bullets: string[];
  paragraph: string | null;
} {
  if (Array.isArray(value)) {
    const items = dedupeLines(
      value.flatMap((item) => (typeof item === 'string' ? splitCandidateText(item) : [])),
    );
    return {
      bullets: items,
      paragraph: null,
    };
  }

  if (typeof value === 'string') {
    const items = splitCandidateText(value);
    if (items.length > 1 || (items.length === 1 && isBulletish(value))) {
      return {
        bullets: items,
        paragraph: null,
      };
    }

    const paragraph = cleanSectionLine(value);
    return {
      bullets: [],
      paragraph: paragraph || null,
    };
  }

  return {
    bullets: [],
    paragraph: null,
  };
}

export function normalizeSectionText(value: unknown): string | undefined {
  const normalized = normalizeSectionValue(value);
  if (normalized.bullets.length > 0) return normalized.bullets.join('\n');
  return normalized.paragraph ?? undefined;
}

// ─── Structured blocks (sub-titled groups) ───────────────────────────────────

export type SectionBlock =
  | { kind: 'bullets'; items: string[] }
  | { kind: 'group'; heading: string; items: string[] }
  | { kind: 'paragraph'; text: string };

// A sub-heading is a short, non-bulleted line that introduces the bullets beneath it,
// e.g. "Technical skills:" or "Required". Heuristics: ends with a colon, OR is short
// (<= 8 words) with no terminal sentence punctuation.
function looksLikeHeading(line: string): boolean {
  const clean = normalizeWhitespace(line);
  if (!clean) return false;
  if (/[:：]\s*$/.test(clean)) return true;
  const words = clean.split(/\s+/);
  return words.length <= 8 && !/[.。!?！？,，;；]$/.test(clean);
}

function stripTrailingColon(value: string): string {
  return value.replace(/[:：]\s*$/, '').trim();
}

/**
 * Parse a raw section value into ordered blocks, preserving sub-titled groups that the
 * flat bullets/paragraph model loses. Pure + deterministic (no AI) so it is cheap and
 * testable; an AI parser can later emit the same SectionBlock[] shape.
 *
 * Input may be a string (newline text) or an array of strings/lines.
 */
export function parseSectionBlocks(value: unknown): SectionBlock[] {
  // Flat, ordered line list, remembering which lines were bullet-prefixed.
  const rawLines: Array<{ text: string; wasBullet: boolean }> = [];
  const pushLine = (raw: string) => {
    const wasBullet = /^(?:[-*•·◦▪‣–—]\s+|\d+[\.\)]\s+|[A-Za-z]\)\s+)/.test(raw.trim());
    const clean = cleanSectionLine(raw);
    if (clean) rawLines.push({ text: clean, wasBullet });
  };

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (typeof item === 'string') item.split(/\r?\n/).forEach(pushLine);
    });
  } else if (typeof value === 'string') {
    value.replace(/\r/g, '\n').split('\n').forEach(pushLine);
  }

  if (rawLines.length === 0) return [];

  const blocks: SectionBlock[] = [];
  let looseBullets: string[] = [];
  const flushLoose = () => {
    if (looseBullets.length) {
      blocks.push({ kind: 'bullets', items: looseBullets });
      looseBullets = [];
    }
  };

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!;
    const next = rawLines[i + 1];
    // A non-bullet heading that introduces following bullets (or ends with a colon) → group.
    const startsGroup =
      !line.wasBullet && looksLikeHeading(line.text) && (!!next?.wasBullet || /[:：]\s*$/.test(line.text));
    if (startsGroup) {
      flushLoose();
      const items: string[] = [];
      let j = i + 1;
      while (j < rawLines.length && rawLines[j]!.wasBullet) {
        items.push(rawLines[j]!.text);
        j += 1;
      }
      blocks.push({ kind: 'group', heading: stripTrailingColon(line.text), items });
      i = j - 1;
      continue;
    }
    if (line.wasBullet) {
      looseBullets.push(line.text);
    } else {
      flushLoose();
      blocks.push({ kind: 'paragraph', text: line.text });
    }
  }
  flushLoose();
  return blocks;
}

// ─── Stored JD shape ─────────────────────────────────────────────────────────

/**
 * One titled section of a job description, ready to render as a heading followed by
 * its blocks. `heading` is null for opening prose that has no title of its own.
 */
export interface JobJdSection {
  heading: string | null;
  blocks: SectionBlock[];
}

/** Bounds. A JD is read on a phone; past this it stops being a description. */
const JD_MAX_SECTIONS = 8;
const JD_MAX_ITEMS_PER_BLOCK = 24;
const JD_MAX_ITEM_CHARS = 400;

const BULLET_PREFIX = /^(?:[-*•·◦▪‣–—]\s+|\d+[\.\)]\s+|[A-Za-z]\)\s+)/;

/**
 * Headings that appear on their own line in a posting body.
 *
 * Needed because `parseSectionBlocks` cannot see them: its `stripHeadingPrefix`
 * deletes a line that is exactly "Requirements:" or "Key responsibilities:", which
 * is precisely the shape most postings use. That function exists to clean up a
 * heading glued onto body text, so this path does its own detection rather than
 * changing behaviour other callers depend on.
 */
const JD_HEADING_LABELS =
  /^(?:about(?: the)?(?: role| job| team| company| us)?|role introduction|introduction|job (?:summary|description|overview)|summary|overview|description|key responsibilities|responsibilities|duties|the role|your role|what you(?:\u2019|')?ll do|what you will do|what we(?:\u2019|')?re looking for|what we are looking for|requirements|qualifications|the person|about you|your (?:profile|background)|skills|experience|benefits|what we offer|we offer)$/i;

/**
 * Headings whose body is a list.
 *
 * Postings usually mark list items with `•` or `-`, but not always: when the adapter
 * has flattened HTML to text the `<li>` markers are gone, leaving one item per line
 * with nothing to distinguish them from prose. Under one of these headings a run of
 * lines IS the list — that is what the heading means — so they are emitted as bullets
 * rather than as a stack of one-line paragraphs, which is how they would otherwise
 * render and does not look like a job description.
 */
const JD_LIST_HEADINGS =
  /\b(?:responsibilities|duties|requirements|qualifications|skills|competencies|benefits)\b|職務|職責|資格|要求|條件|技能|福利|待遇/i;

/** Lines that are page furniture, not description. */
const JD_NOISE_LINE = /^(?:application deadline|closing date|job ref(?:erence)?|req(?:uisition)? id|apply now|share this job)\b/i;

const NAMED_SECTIONS: Array<{ key: string; heading: string }> = [
  { key: 'roleIntroduction', heading: 'About the role' },
  { key: 'keyResponsibilities', heading: 'Key responsibilities' },
  { key: 'requirements', heading: 'Requirements' },
];

function stripHeadingColon(value: string): string {
  return value.replace(/[:：]\s*$/, '').trim();
}

function isBulletLine(value: string): boolean {
  return BULLET_PREFIX.test(value);
}

/**
 * Section vocabulary, matched anywhere in a heading rather than as a whole heading.
 *
 * An exact-label allow-list cannot cover real headings. AIA writes "Roles and
 * Responsibilities" and "Minimum Job Requirements", neither of which is one of the
 * bare labels, so the allow-list alone produced ZERO headings on every Workday
 * posting and everything collapsed into one untitled section.
 *
 * A keyword on its own would be too eager — "You will support the responsibilities of
 * the team." contains one and is a sentence — so the length and terminal-punctuation
 * guards inside `looksLikeJdHeading` still apply. Together they separate a label from
 * a sentence that happens to use the same noun.
 */
const JD_HEADING_KEYWORDS =
  /\b(?:responsibilities|duties|requirements|qualifications|skills|competencies|benefits|summary|overview|introduction|profile|background)\b|職務|職責|資格|要求|條件|簡介|內容|技能|福利|待遇|我們提供/i;

/**
 * Whether a line is short enough to be a label rather than prose.
 *
 * Word count works for Latin text but not for Chinese, which has no spaces: every
 * Chinese sentence is "one word" by `split(/\s+/)`, so the guard let a full sentence
 * through as soon as it contained a section word. A CLP bullet reading
 * "…符合有關品質及安全要求" was taken for a heading because it ends in 要求, and the
 * bullet before it was left alone in its section. CJK lines are therefore measured in
 * characters.
 */
function isLabelSized(bare: string): boolean {
  if (/[\u3400-\u9fff]/.test(bare)) return bare.length <= 12;
  return bare.split(/\s+/).length <= 6;
}

function looksLikeJdHeading(line: string, nextIsBullet: boolean): boolean {
  const bare = stripHeadingColon(line);
  if (!bare || bare.length > 60) return false;
  // A sentence is not a heading, however short.
  if (/[.。!?！？,，;；]$/.test(bare)) return false;
  if (JD_HEADING_LABELS.test(bare)) return true;
  // A keyword only marks a heading in a label-sized line, which is what keeps a
  // prose sentence containing the same noun out.
  if (JD_HEADING_KEYWORDS.test(bare) && isLabelSized(bare)) return true;
  // "The team:" — an explicit colon is the author telling us it is a label.
  if (/[:：]\s*$/.test(line)) return true;
  // A short line directly above bullets is introducing them.
  return nextIsBullet && isLabelSized(bare);
}

function clampText(value: string): string {
  return value.slice(0, JD_MAX_ITEM_CHARS).trim();
}

function clampBlock(block: SectionBlock): SectionBlock | null {
  if (block.kind === 'paragraph') {
    const text = clampText(block.text);
    return text ? { kind: 'paragraph', text } : null;
  }
  const items = block.items.map(clampText).filter(Boolean).slice(0, JD_MAX_ITEMS_PER_BLOCK);
  if (items.length === 0) return null;
  // Built per kind rather than spread from `block`, so the result is checked rather
  // than cast — a cast would happily let a group lose its heading.
  return block.kind === 'group'
    ? { kind: 'group', heading: block.heading, items }
    : { kind: 'bullets', items };
}

function isBlock(block: SectionBlock | null): block is SectionBlock {
  return block !== null;
}

/** Split a posting body into titled sections, keeping bullet runs together. */
function splitBlobSections(text: string): JobJdSection[] {
  const lines = text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sections: JobJdSection[] = [];
  let current: JobJdSection | null = null;

  const open = (heading: string | null): JobJdSection => {
    const section: JobJdSection = { heading, blocks: [] };
    sections.push(section);
    return section;
  };

  // Set when the open section's heading means "the lines below are a list".
  let currentIsList = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const bullet = isBulletLine(line);

    if (!bullet && looksLikeJdHeading(line, next ? isBulletLine(next) : false)) {
      const heading = stripHeadingColon(line);
      current = open(heading);
      currentIsList = JD_LIST_HEADINGS.test(heading);
      continue;
    }

    if (JD_NOISE_LINE.test(line)) continue;

    if (!current) {
      current = open(null);
      currentIsList = false;
    }
    const body = line.replace(BULLET_PREFIX, '').trim();
    if (!body) continue;

    if (bullet || currentIsList) {
      const last = current.blocks[current.blocks.length - 1];
      if (last && last.kind === 'bullets') last.items.push(body);
      else current.blocks.push({ kind: 'bullets', items: [body] });
    } else {
      current.blocks.push({ kind: 'paragraph', text: body });
    }
  }

  return sections;
}

/**
 * Build the sections stored on the job and rendered on the detail page.
 *
 * Two shapes arrive from the adapters and both have to end up the same:
 *
 *  - `sectionContent`, a named object (`roleIntroduction` / `keyResponsibilities` /
 *    `requirements`) that the corporate-careers and Cathay adapters produce. Already
 *    titled, so it needs no heading detection — only bullet normalisation, which
 *    `normalizeSectionValue` does, including turning a plain array into a bullet list
 *    (an array is a list by construction, and reading it as separate paragraphs
 *    loses that).
 *  - `description`, a single blob of text, which is what Workday has.
 *
 * Pure and deterministic, so it runs on every scrape for free and cannot invent a
 * requirement the posting does not contain. An LLM could write richer prose, but the
 * detail page needs the employer's own wording, not a paraphrase of it.
 */
export function buildJdSections(input: {
  sectionContent?: unknown;
  description?: string | null;
}): JobJdSection[] {
  const out: JobJdSection[] = [];

  const content =
    input.sectionContent && typeof input.sectionContent === 'object'
      ? (input.sectionContent as Record<string, unknown>)
      : null;

  if (content) {
    for (const { key, heading } of NAMED_SECTIONS) {
      const value = content[key];
      if (value === null || value === undefined) continue;
      const normalized = normalizeSectionValue(value);
      const blocks: SectionBlock[] = [];
      if (normalized.bullets.length > 0) {
        blocks.push({ kind: 'bullets', items: normalized.bullets });
      } else if (normalized.paragraph) {
        blocks.push({ kind: 'paragraph', text: normalized.paragraph });
      }
      const clamped = blocks.map(clampBlock).filter(isBlock);
      if (clamped.length > 0) out.push({ heading, blocks: clamped });
    }
  }

  if (out.length === 0 && typeof input.description === 'string' && input.description.trim()) {
    for (const section of splitBlobSections(input.description)) {
      const blocks = section.blocks.map(clampBlock).filter(isBlock).slice(0, JD_MAX_ITEMS_PER_BLOCK);
      if (blocks.length > 0) out.push({ heading: section.heading, blocks });
    }
  }

  return out.filter((section) => section.blocks.length > 0).slice(0, JD_MAX_SECTIONS);
}
