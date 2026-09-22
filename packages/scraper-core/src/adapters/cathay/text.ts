/**
 * Text and HTML utilities shared by the Cathay adapter.
 *
 * These helpers intentionally stay framework-free so listing APIs, Playwright
 * detail pages, and static HTML fallbacks all normalize text in the same way.
 */
export function normalizeText(value: string | undefined | null): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

export function toAbsoluteUrl(rawUrl: string, pageUrl: string): string {
  try {
    return rawUrl.startsWith('http') ? new URL(rawUrl).toString() : new URL(rawUrl, pageUrl).toString();
  } catch {
    return rawUrl;
  }
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function stripHtmlToText(html: string): string {
  const withLineBreaks = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/section|\/article|\/tr|\/h[1-6]|\/main|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withLineBreaks)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTagText(html: string, tagName: string): string | undefined {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  if (!match?.[1]) return undefined;
  const text = stripHtmlToText(match[1]).trim();
  return text || undefined;
}

export function extractListItems(html: string): string[] {
  const items: string[] = [];
  const listItemRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(listItemRegex)) {
    const text = stripHtmlToText(match[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    items.push(text);
  }
  return Array.from(new Set(items)).slice(0, 60);
}

export function joinBullets(items: string[]): string | undefined {
  if (items.length === 0) return undefined;
  return items.map((item) => `- ${item}`).join('\n');
}

export function extractHtmlSection(
  html: string,
  startPattern: RegExp,
  endPattern?: RegExp,
): string | undefined {
  const start = html.match(startPattern);
  if (!start || start.index === undefined) return undefined;
  const remainder = html.slice(start.index + start[0].length);
  if (!endPattern) {
    const out = remainder.trim();
    return out.length > 0 ? out : undefined;
  }
  const end = remainder.match(endPattern);
  const endIndex = end?.index;
  const segment = typeof endIndex === 'number' && endIndex >= 0 ? remainder.slice(0, endIndex) : remainder;
  const out = segment.trim();
  return out.length > 0 ? out : undefined;
}

export function normalizeMultilineText(value: string | undefined | null): string {
  if (!value) return '';
  const lines = value
    .replace(/\r/g, '')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .replace(/^item\s+\d+\s+of\s+\d+,\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0);

  const deduped: string[] = [];
  for (const line of lines) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.toLowerCase() === line.toLowerCase()) continue;
    deduped.push(line);
  }

  return deduped.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function toBulletFriendlyText(raw: string | undefined): string | undefined {
  const normalized = normalizeMultilineText(raw);
  if (!normalized) return undefined;

  const lineParts = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lineParts.length >= 2) return lineParts.join('\n');

  const sentenceParts = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (sentenceParts.length >= 2) return sentenceParts.join('\n');

  const semicolonParts = normalized
    .split(/\s*;\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (semicolonParts.length >= 2) return semicolonParts.join('\n');

  return normalized;
}
