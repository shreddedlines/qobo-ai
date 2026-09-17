import type { PageType } from './config.ts';

export interface ChunkSource {
  url: string;
  title: string;
  pageType: PageType;
  body: string;
}

export interface KbChunk {
  url: string;
  title: string;
  pageType: PageType;
  /** Heading path of the first section in the chunk, e.g. "Got Questions? > Is there a free trial?". */
  section: string | null;
  chunkIndex: number;
  /** Text stored for retrieval and shown to the model (includes a page/section header). */
  content: string;
  topics: string[];
  tokenEstimate: number;
}

export interface ChunkOptions {
  /** Sections are merged until adding another would exceed this. */
  targetTokens: number;
  /** A single section above this is split on line boundaries. */
  maxTokens: number;
  /** A chunk is closed at a new top-level (h1/h2) heading once it has this much content. */
  minTokensBeforeTopicBreak: number;
}

export interface TopicRule {
  name: string;
  patterns: string[];
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetTokens: 350, maxTokens: 500, minTokensBeforeTopicBreak: 60 };

interface Section {
  headingPath: string[];
  /** Level of the heading that opened this section (0 for text before any heading). */
  level: number;
  lines: string[];
}

/** Rough token estimate (≈4 characters per token for English prose). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function splitIntoSections(body: string): Section[] {
  const sections: Section[] = [];
  const stack: string[] = [];
  let current: Section = { headingPath: [], level: 0, lines: [] };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      if (current.lines.length > 0) sections.push(current);
      const level = heading[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = heading[2]!.trim();
      current = { headingPath: stack.filter(Boolean), level, lines: [line] };
    } else if (line.trim()) {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) sections.push(current);
  return sections;
}

/**
 * Heading-aware chunking: small sections (e.g. one FAQ question + answer) stay
 * whole and are merged with neighbours up to the target size; oversized sections
 * are split on line boundaries.
 */
export function chunkPage(source: ChunkSource, topics: TopicRule[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): KbChunk[] {
  const compiledTopics = topics.map((topic) => ({ name: topic.name, patterns: topic.patterns.map((pattern) => new RegExp(pattern, 'iu')) }));
  const groups: Section[][] = [];
  let group: Section[] = [];
  let groupTokens = 0;

  const flush = () => {
    if (group.length > 0) groups.push(group);
    group = [];
    groupTokens = 0;
  };

  for (const section of splitIntoSections(source.body).flatMap((s) => splitOversized(s, options))) {
    const tokens = estimateTokens(section.lines.join('\n'));
    const topicBreak = section.level > 0 && section.level <= 2 && groupTokens >= options.minTokensBeforeTopicBreak;
    if (group.length > 0 && (groupTokens + tokens > options.targetTokens || topicBreak)) flush();
    group.push(section);
    groupTokens += tokens;
  }
  flush();

  return groups.map((sections, chunkIndex) => {
    // Marketing pages often use several h1 hero headings and the page title already
    // names the page, so labels drop the h1 and keep the two nearest levels
    // (e.g. "Got Questions? > Is there a free trial?").
    const { headingPath, level } = sections[0]!;
    const withoutH1 = level === 1 || headingPath.length === 1 ? headingPath : headingPath.slice(1);
    const sectionLabel = withoutH1.slice(-2).join(' > ') || null;
    const text = sections.flatMap((s) => s.lines).join('\n');
    const content = `Page: ${source.title}\nSection: ${sectionLabel ?? 'Overview'}\n\n${text}`;
    return {
      url: source.url,
      title: source.title,
      pageType: source.pageType,
      section: sectionLabel,
      chunkIndex,
      content,
      topics: compiledTopics.filter((topic) => topic.patterns.some((pattern) => pattern.test(text))).map((topic) => topic.name),
      tokenEstimate: estimateTokens(content),
    };
  });
}

function splitOversized(section: Section, options: ChunkOptions): Section[] {
  if (estimateTokens(section.lines.join('\n')) <= options.maxTokens) return [section];

  const parts: Section[] = [];
  const headingLine = /^#{1,3} /.test(section.lines[0] ?? '') ? section.lines[0]! : null;
  let lines: string[] = [];

  for (const line of section.lines) {
    if (lines.length > 0 && estimateTokens([...lines, line].join('\n')) > options.targetTokens) {
      parts.push({ ...section, lines });
      // Continuation parts repeat the heading so each chunk stays self-describing.
      lines = headingLine ? [`${headingLine} (continued)`] : [];
    }
    lines.push(line);
  }
  if (lines.length > 0) parts.push({ ...section, lines });
  return parts.map((part, index) => (index === 0 ? part : { ...part, level: 99 }));
}
