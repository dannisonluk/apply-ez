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
