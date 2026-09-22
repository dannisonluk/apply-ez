/**
 * Text and HTML normalisation, shared by every adapter.
 *
 * These used to live in two per-adapter copies (`cathay/text.ts` and
 * `corporate-careers/utils.ts`) that had drifted — the corporate-careers one did
 * not strip `<noscript>` and did not decode numeric entities, so the same job
 * description normalised differently depending on which adapter fetched it.
 * Adapters re-export from here now, so there is one definition of "normalised".
 *
 * Framework-free on purpose: listing APIs, Playwright detail pages and static
 * HTML all go through these.
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

/**
 * HTML → plain text, preserving paragraph structure.
 *
 * Block-level close tags become newlines BEFORE tags are stripped, which is what
 * keeps bulleted requirement lists readable once they reach the LLM prompt — a
 * flat `replace(/<[^>]+>/g, ' ')` collapses them into one paragraph and the model
 * then loses the boundaries between separate requirements.
 */
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
