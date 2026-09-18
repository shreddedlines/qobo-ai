import type { Source } from '../api/types.ts';

export interface ResolvedCitation {
  /** The number as written in the reply, e.g. 2 for "[2]". */
  number: number;
  source: Source;
}

export interface CitationRun {
  resolved: ResolvedCitation[];
  /** Numbers with no matching source; rendered as literal text rather than dropped. */
  unresolved: number[];
}

/**
 * Connects the numbers in a citation marker to the reply's own sources: the backend
 * numbers sources in first-cited order, so [n] is sources[n - 1].
 *
 * A number with no source is kept as text instead of being hidden — the reply is
 * shown as the assistant actually wrote it, and no citation is invented.
 */
export function resolveCitationRun(numbers: readonly number[], sources: readonly Source[]): CitationRun {
  const resolved: ResolvedCitation[] = [];
  const unresolved: number[] = [];

  for (const number of numbers) {
    const source = Number.isInteger(number) && number >= 1 ? sources[number - 1] : undefined;
    if (source) resolved.push({ number, source });
    else unresolved.push(number);
  }

  return { resolved, unresolved };
}

/** DOM id of a source in the strip, so a marker can point at its own source. */
export function sourceElementId(messageId: string, number: number): string {
  return `source-${messageId}-${number}`;
}

export interface SourceGroups {
  qobo: Source[];
  web: Source[];
}

/** Splits sources by origin: QOBO's own pages and outside web research are labelled apart. */
export function groupSources(sources: readonly Source[]): SourceGroups {
  return {
    qobo: sources.filter((source) => source.kind === 'qobo'),
    web: sources.filter((source) => source.kind === 'web'),
  };
}

/** Host shown under a source title, e.g. "qobo.dev". */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
