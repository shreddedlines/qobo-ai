/**
 * A deliberately small Markdown subset for assistant replies.
 *
 * Model output is untrusted input. Instead of turning it into an HTML string and
 * sanitizing afterwards, this parses to a plain data tree that the renderer turns into
 * React elements — so there is no HTML string anywhere and nothing to inject into.
 * Anything the grammar does not cover (including raw HTML) survives as literal text.
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  /** One run of adjacent citation markers, e.g. "[1][2]" → numbers [1, 2]. */
  | { type: 'citation'; numbers: number[] };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 2 | 3; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'code'; value: string }
  | { type: 'quote'; children: Inline[] };

/** http(s) only: a "javascript:" or "data:" link in model output must never become a link. */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

const BARE_URL = /https?:\/\/[^\s<>()[\]{}"'`]+/g;
/** Sentence punctuation that follows a bare URL rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

function pushText(nodes: Inline[], value: string): void {
  if (!value) return;
  const last = nodes.at(-1);
  if (last?.type === 'text') last.value += value;
  else nodes.push({ type: 'text', value });
}

/** Turns bare URLs inside a plain run into links; everything else stays text. */
function pushRun(nodes: Inline[], run: string): void {
  let cursor = 0;
  for (const match of run.matchAll(BARE_URL)) {
    const start = match.index;
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    const href = safeHref(raw);
    if (!href) continue;
    pushText(nodes, run.slice(cursor, start));
    nodes.push({ type: 'link', href, children: [{ type: 'text', value: raw }] });
    cursor = start + raw.length;
  }
  pushText(nodes, run.slice(cursor));
}

const CITATION_RUN = /^(?:\[\s*\d{1,3}\s*\][ \t]?)+/;
const CITATION_NUMBER = /\d{1,3}/g;

export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let run = '';
  let index = 0;

  const flush = () => {
    pushRun(nodes, run);
    run = '';
  };

  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index]!;

    if (char === '\\' && index + 1 < text.length) {
      // An escaped marker is literal: "\[1]" stays "[1]".
      run += text[index + 1];
      index += 2;
      continue;
    }

    if (char === '`') {
      const end = text.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ type: 'code', value: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (char === '[') {
      const citation = CITATION_RUN.exec(rest);
      if (citation) {
        const numbers = [...new Set([...citation[0].matchAll(CITATION_NUMBER)].map((match) => Number(match[0])))];
        flush();
        nodes.push({ type: 'citation', numbers });
        index += citation[0].length;
        continue;
      }
      const link = /^\[([^\]]*)\]\(([^()\s]+)\)/.exec(rest);
      const href = link ? safeHref(link[2]!) : null;
      if (link && href) {
        flush();
        nodes.push({ type: 'link', href, children: parseInline(link[1]!) });
        index += link[0].length;
        continue;
      }
    }

    if (rest.startsWith('**')) {
      const end = text.indexOf('**', index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ type: 'strong', children: parseInline(text.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if ((char === '*' || char === '_') && !rest.startsWith('**')) {
      const end = text.indexOf(char, index + 1);
      // Refuse an empty span, and refuse "_" inside a word (snake_case is not emphasis).
      const insideWord = char === '_' && /\w/.test(text[index - 1] ?? '');
      if (end > index + 1 && !insideWord) {
        flush();
        nodes.push({ type: 'em', children: parseInline(text.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }

    run += char;
    index += 1;
  }

  flush();
  return nodes;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*•]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * Splits a reply into blocks. Headings are clamped to h2/h3 because the page already
 * owns its h1 and a reply must not break the document outline.
 */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ').trim()) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (FENCE.test(line)) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      blocks.push({ type: 'code', value: code.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: 'heading', level: heading[1]!.length <= 2 ? 2 : 3, children: parseInline(heading[2]!.trim()) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const quoted = [quote[1]!];
      while (index + 1 < lines.length && QUOTE.test(lines[index + 1]!)) {
        index += 1;
        quoted.push(QUOTE.exec(lines[index]!)![1]!);
      }
      blocks.push({ type: 'quote', children: parseInline(quoted.join(' ').trim()) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph();
      const ordered = !BULLET.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const bullet = BULLET.exec(current);
        const numbered = ORDERED.exec(current);
        if (bullet && !ordered) items.push(bullet[1]!);
        else if (numbered && ordered) items.push(numbered[2]!);
        else if (current.trim() !== '' && !bullet && !numbered && items.length > 0) {
          // A wrapped continuation line belongs to the item above it.
          items[items.length - 1] += ` ${current.trim()}`;
        } else break;
        index += 1;
      }
      index -= 1;
      blocks.push({ type: 'list', ordered, items: items.map((item) => parseInline(item.trim())) });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}
