import type { Source } from '../conversations/types.ts';
import type { Discrepancy } from './discrepancies.ts';

/**
 * Deterministic post-generation guards. The prompt asks the model to handle known
 * discrepancies and to attribute marketing figures; these guards make sure the
 * user still gets that context when the model does not comply.
 */
export interface GuardOutcome {
  content: string;
  applied: string[];
  extraSources: Source[];
}

export function applyDiscrepancyGuards(content: string, discrepancies: Discrepancy[]): GuardOutcome {
  let result = content;
  const applied: string[] = [];
  const extraSources: Source[] = [];

  for (const discrepancy of discrepancies) {
    const onTopic = discrepancy.answerPatterns.some((pattern) => pattern.test(result));
    if (!onTopic || discrepancy.isCompliant(result)) continue;
    result = `${result}\n\n${discrepancy.userNote}`;
    applied.push(`discrepancy:${discrepancy.id}`);
    for (const statement of discrepancy.statements) extraSources.push({ title: statement.title, url: statement.url, kind: 'qobo' });
  }
  return { content: result, applied, extraSources };
}

const STATISTIC_PATTERNS = [
  /\b\d+(?:\.\d+)?x\b/i, // 4.5x ROAS
  /\d+(?:\.\d+)?\s?%/, // 98%, +300%
  /\b\d{1,3}(?:,\d{3})+\+|\b\d+\+(?!\d)/, // 1,000+ websites, 120+ hours
  /\b\d+(?:\.\d+)?\s?[KMB]\+/, // 10M+ interactions
  /₹\s?\d+(?:\.\d+)?\s?(?:M|K|L|Cr)\b/, // ₹20M+
  /\b\d(?:\.\d)?\s?\/\s?5\b/, // 4.9/5
  /\b(?:rating|roas|uptime|satisfaction|conversion rate)\b[^.\n]{0,40}\d|\d[^.\n]{0,40}\b(?:rating|roas|uptime|satisfaction)\b/i,
];

const ATTRIBUTION =
  /according to (?:qobo'?s |our |the )?website|(?:qobo'?s|our|the) website (?:states|says|mentions|lists|shows|reports|highlights|claims|notes|cites)|as (?:stated|listed|shown|mentioned|highlighted|claimed) on (?:qobo'?s |our |the )?website|वेबसाइट के अनुसार/i;

export const STATISTICS_NOTE = "_Figures mentioned above are marketing statements from QOBO's website, not guaranteed results._";

/** Appends an attribution note when the answer quotes figures without attributing them. */
export function applyStatisticAttributionGuard(content: string): GuardOutcome {
  const withoutCitationMarkers = content.replace(/\[\d+\]/g, '');
  const hasStatistic = STATISTIC_PATTERNS.some((pattern) => pattern.test(withoutCitationMarkers));
  if (!hasStatistic || ATTRIBUTION.test(content)) return { content, applied: [], extraSources: [] };
  return { content: `${content}\n\n${STATISTICS_NOTE}`, applied: ['statistics-attribution'], extraSources: [] };
}
