export interface HeadingInfo {
  level: 1 | 2 | 3;
  /** innerText lines of the heading (headings often contain <br> line breaks). */
  parts: string[];
}

const NOISE_LINE = /^(?:[•·|→←↓↑✓✔✕×★☆"“”'‘’\-–—~:]+|\d{1,2}|0\d)$/;
const CURRENCY_ONLY = /^(?:₹|Rs\.?|INR)$/i;
const AMOUNT = /^[\d,]+(?:\.\d+)?(?:\s*\/\s*[a-z]+)?$/i;

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Ordered union of several captures of the same page (e.g. carousel samples).
 * Unseen lines are inserted after the nearest preceding line they followed in
 * their capture, so rotating slides stay next to their neighbours. The anchor
 * only moves forward: a repeated line (marquees render content several times)
 * must never pull later lines back to an earlier position.
 *
 * Captures should be normalized first (see normalizeLines) so that split prices
 * such as "₹" + "499" are joined before lines are compared.
 */
export function mergeCaptures(captures: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const capture of captures) {
    let anchorIndex = -1;
    for (const line of capture) {
      if (seen.has(line)) {
        anchorIndex = Math.max(anchorIndex, merged.indexOf(line));
        continue;
      }
      merged.splice(anchorIndex + 1, 0, line);
      seen.add(line);
      anchorIndex += 1;
    }
  }
  return merged;
}

/** Trims, joins split prices ("₹" + "499"), drops decorative noise and exact duplicates. */
export function normalizeLines(rawLines: string[]): string[] {
  const lines = rawLines.map(collapseWhitespace).filter(Boolean);
  const joined: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (CURRENCY_ONLY.test(line) && next !== undefined && AMOUNT.test(next)) {
      joined.push(`₹${next.replace(/\s+/g, '')}`);
      i++;
      continue;
    }
    joined.push(line);
  }

  const seen = new Set<string>();
  return joined
    .filter((line) => {
      if (NOISE_LINE.test(line) || seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    // Page text such as "#1 choice" must not be mistaken for a Markdown heading.
    .map((line) => line.replace(/^#/, '\\#'));
}

/** Replaces heading line runs with Markdown headings. */
export function applyHeadings(lines: string[], headings: HeadingInfo[]): string[] {
  const candidates = headings
    .map((heading) => ({ level: heading.level, parts: heading.parts.map(collapseWhitespace).filter(Boolean) }))
    .filter((heading) => heading.parts.length > 0)
    .sort((a, b) => b.parts.length - a.parts.length);

  const output: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const match = candidates.find(
      (heading, index) => !used.has(index) && heading.parts.every((part, offset) => lines[i + offset] === part),
    );
    if (match) {
      used.add(candidates.indexOf(match));
      output.push(`${'#'.repeat(match.level)} ${match.parts.join(' ')}`);
      i += match.parts.length - 1;
    } else {
      output.push(lines[i]!);
    }
  }
  return output;
}

export interface BoilerplateOptions {
  maxLineLength: number;
  minPages: number;
  pageShare: number;
}

/** Finds short non-heading lines that repeat across many pages (CTA labels, nav). */
export function findBoilerplate(pages: string[][], options: BoilerplateOptions): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    for (const line of new Set(lines)) {
      if (line.startsWith('#') || line.length > options.maxLineLength) continue;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  const threshold = Math.max(options.minPages, Math.ceil(options.pageShare * pages.length));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([line]) => line));
}

const PRICE_PATTERN = /(?:₹|\bRs\.?|\bINR)\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(M|K|L|Cr)\b\+?)?(?:\s?\/\s?(month|mo|year|yr|kg|day|week)\b)?/gi;

/** Normalized ₹ amounts in text: "₹ 1,499" → "₹1,499", "₹499 / month" → "₹499/month", "₹20M+" → "₹20M". */
export function findPrices(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PRICE_PATTERN)) {
    const amount = match[1]!.replace(/,$/, '');
    const magnitude = match[2] ? match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase() : '';
    const period = match[3]?.toLowerCase().replace(/^mo$/, 'month').replace(/^yr$/, 'year');
    found.add(`₹${amount}${magnitude}${period ? `/${period}` : ''}`);
  }
  return [...found].sort();
}

export type ContactKind = 'phone' | 'whatsapp' | 'email';

export interface ContactLink {
  kind: ContactKind;
  value: string;
  href: string;
}

/** Classifies tel:, mailto: and WhatsApp links into readable contact details. */
export function toContactLink(href: string): ContactLink | null {
  const trimmed = href.trim();
  if (/^tel:/i.test(trimmed)) {
    const digits = trimmed.replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    return digits ? { kind: 'phone', value: formatIndianNumber(digits), href: trimmed } : null;
  }
  if (/^mailto:/i.test(trimmed)) {
    const email = decodeURIComponent(trimmed.replace(/^mailto:/i, '').split('?')[0]!);
    return email ? { kind: 'email', value: email, href: `mailto:${email}` } : null;
  }
  const whatsapp = /^https?:\/\/(?:wa\.me\/|(?:api|web)\.whatsapp\.com\/send\/?\?(?:.*&)?phone=)(\+?\d{8,15})/i.exec(trimmed);
  if (whatsapp) {
    const digits = whatsapp[1]!.replace(/^\+/, '');
    return { kind: 'whatsapp', value: formatIndianNumber(digits), href: `https://wa.me/${digits}` };
  }
  return null;
}

function formatIndianNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return raw.startsWith('+') ? raw : `+${digits}`;
}
