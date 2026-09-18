import type { Source } from '../conversations/types.ts';
import type { Discrepancy } from './discrepancies.ts';

export interface RetrievedChunk {
  id: number;
  url: string;
  title: string;
  section: string | null;
  pageType: string;
  content: string;
  topics: string[];
  similarity: number;
}

/** A numbered piece of evidence shown to the model as <source id="S1"> (QOBO) or <result id="W1"> (web). */
export interface ContextSource {
  id: string;
  title: string;
  url: string;
  text: string;
  origin: 'kb' | 'discrepancy' | 'web';
  kind: 'qobo' | 'web';
}

export function buildContextSources(chunks: RetrievedChunk[], discrepancies: Discrepancy[]): ContextSource[] {
  const sources: ContextSource[] = chunks.map((chunk, index) => ({
    id: `S${index + 1}`,
    title: chunk.title,
    url: chunk.url,
    text: chunk.content,
    origin: 'kb',
    kind: 'qobo',
  }));

  const seen = new Set(sources.map((source) => `${source.url}\n${source.text}`));
  for (const statement of discrepancies.flatMap((discrepancy) => discrepancy.statements)) {
    const key = `${statement.url}\n${statement.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ id: `S${sources.length + 1}`, title: statement.title, url: statement.url, text: statement.quote, origin: 'discrepancy', kind: 'qobo' });
  }
  return sources;
}

/**
 * A bracket that looks like a citation the model made up: a label where a source
 * number belongs.
 *
 * Only source ids are citable, and by the time this runs every real one has already
 * become "[n]". What is left is either an id the model invented or, as seen in
 * production, a name it copied from the prompt's own structure — "[Known
 * Discrepancies]" from the <known_discrepancies> section. Matching the shape rather
 * than a list of known labels is what makes it hold for labels nobody predicted.
 *
 * Deliberately narrow:
 *   * a numeric bracket is left alone, so "[1]" and "[1, 2]" survive
 *   * a bracket followed by "(" is a Markdown link, so "[our plans](https://…)" survives
 *   * the label must read like a label: starts with a letter, no punctuation beyond
 *     " . _ - '", and at most 40 characters, so ordinary prose in brackets is untouched
 */
const INVENTED_CITATION = /\[\s*(?!\d[\d\s,]*\])[A-Za-z][A-Za-z0-9 ._'-]{0,39}\s*\](?!\()/g;

/** Removes bracketed labels that pretend to be citations. */
export function stripInventedCitations(text: string): string {
  return text.replace(INVENTED_CITATION, '');
}

export interface ResolvedCitations {
  /** Answer text with [S#] markers rewritten to [n], numbered by cited page. */
  content: string;
  /** Cited pages in the order they are first referenced; index + 1 matches [n]. */
  sources: Source[];
}

const MARKER_GROUP = /\[\s*([SW]\d+(?:\s*[,;]\s*[SW]\d+)*)\s*\]/g;

/**
 * Keeps only citations that point at sources the model was actually given, merges
 * citations of the same page and renumbers them. Unknown ids are dropped, so a
 * model cannot cite pages it did not see.
 */
export function resolveCitations(answer: string, declaredIds: string[], contextSources: ContextSource[], nonCitableIds: string[] = []): ResolvedCitations {
  const resolved = resolveCitationSegments([answer], declaredIds, contextSources, nonCitableIds);
  return { content: resolved.contents[0]!, sources: resolved.sources };
}

export interface ResolvedCitationSegments {
  contents: string[];
  /** All cited pages, numbered across every segment. */
  sources: Source[];
  /** Pages cited inline within each segment. */
  segmentSources: Source[][];
}

/**
 * Resolves several text segments (e.g. a web answer and a QOBO note) with one shared
 * numbering, and reports which pages each segment cited inline.
 */
export function resolveCitationSegments(segments: string[], declaredIds: string[], contextSources: ContextSource[], nonCitableIds: string[] = []): ResolvedCitationSegments {
  const byId = new Map(contextSources.map((source) => [source.id, source]));
  const numberByUrl = new Map<string, number>();
  const sources: Source[] = [];

  const numberFor = (source: ContextSource): number => {
    let number = numberByUrl.get(source.url);
    if (number === undefined) {
      number = sources.length + 1;
      numberByUrl.set(source.url, number);
      sources.push({ title: source.title, url: source.url, kind: source.kind });
    }
    return number;
  };

  const segmentSources: Source[][] = [];
  const contents = segments.map((segment) => {
    const cited = new Set<number>();
    let content = segment.replace(MARKER_GROUP, (_match, group: string) => {
      const numbers = [
        ...new Set(
          group
            .split(/[,;]/)
            .map((id) => byId.get(id.trim()))
            .filter((source): source is ContextSource => source !== undefined)
            .map(numberFor),
        ),
      ];
      numbers.forEach((number) => cited.add(number));
      return numbers.map((number) => `[${number}]`).join('');
    });

    // Models occasionally cite internal labels (e.g. a discrepancy id) as if they were
    // sources. The configured ids go first, then anything else label-shaped, which
    // covers labels the model invents from the prompt's own section names.
    for (const id of nonCitableIds) {
      content = content.replaceAll(`[${id}]`, '');
    }
    content = stripInventedCitations(content);

    segmentSources.push([...cited].sort((a, b) => a - b).map((number) => sources[number - 1]!));
    return content
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  });

  for (const id of declaredIds) {
    const source = byId.get(id.trim());
    if (source) numberFor(source);
  }

  return { contents, sources, segmentSources };
}
