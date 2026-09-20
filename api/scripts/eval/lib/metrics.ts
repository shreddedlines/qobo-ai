/**
 * Classification metrics for the intent router, computed from the cases the suite
 * already labels — no new ground truth.
 *
 * A case counts only when it declares a single expected intent. The one case that
 * declares `intentIn` is genuinely ambiguous (two intents are both acceptable), so it
 * has no single gold label and is excluded from the matrix rather than resolved
 * arbitrarily; it still passes or fails the suite as it always did.
 *
 * Note what is being measured: the intent the pipeline acted on, which is not always
 * the router's first answer — a general reply that produced code becomes a redirect,
 * and deterministic rules can override a classification. The router's own label is not
 * recorded, so these are end-to-end routing metrics.
 */

export interface IntentPrediction {
  /** Case id, for reporting which cases were excluded. */
  id: string;
  /** The single expected intent, or undefined when the case does not declare one. */
  gold?: string | undefined;
  /** What the pipeline decided, or undefined when the case errored before answering. */
  predicted?: string | undefined;
  /** True when the case accepts several intents, so it cannot contribute a gold label. */
  ambiguous?: boolean;
}

export interface ClassMetrics {
  label: string;
  /** Cases whose gold label is this class. */
  support: number;
  /** Cases predicted as this class. */
  predicted: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ExcludedCase {
  id: string;
  reason: 'ambiguous' | 'no gold intent' | 'no prediction';
}

export interface IntentMetrics {
  labels: string[];
  /** matrix[gold][predicted], indexed against `labels`. */
  matrix: number[][];
  scored: number;
  correct: number;
  accuracy: number;
  perClass: ClassMetrics[];
  /** Averaged over classes that appear as a gold label or a prediction. */
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  /** Classes the macro averages cover, so a reader can see what was averaged. */
  macroLabels: string[];
  excluded: ExcludedCase[];
}

/** Zero rather than NaN when a class was never predicted or never occurred. */
const ratio = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

const mean = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);

/**
 * Builds the confusion matrix and the usual derived scores.
 *
 * `labels` fixes the reporting order; it defaults to every class seen in the gold
 * labels or the predictions, sorted, so an unexpected intent cannot go unnoticed.
 */
export function intentMetrics(predictions: readonly IntentPrediction[], labels?: readonly string[]): IntentMetrics {
  const excluded: ExcludedCase[] = [];
  const scoredPairs: Array<{ gold: string; predicted: string }> = [];

  for (const prediction of predictions) {
    if (prediction.ambiguous) excluded.push({ id: prediction.id, reason: 'ambiguous' });
    else if (!prediction.gold) excluded.push({ id: prediction.id, reason: 'no gold intent' });
    else if (!prediction.predicted) excluded.push({ id: prediction.id, reason: 'no prediction' });
    else scoredPairs.push({ gold: prediction.gold, predicted: prediction.predicted });
  }

  const observed = [...new Set(scoredPairs.flatMap((pair) => [pair.gold, pair.predicted]))].sort();
  const order = labels ? [...labels] : observed;
  // A class seen in the data but missing from the caller's order would vanish silently.
  for (const label of observed) if (!order.includes(label)) order.push(label);

  const index = new Map(order.map((label, at) => [label, at]));
  const matrix = order.map(() => order.map(() => 0));
  for (const { gold, predicted } of scoredPairs) matrix[index.get(gold)!]![index.get(predicted)!]! += 1;

  const perClass: ClassMetrics[] = order.map((label, at) => {
    const truePositives = matrix[at]![at]!;
    const support = matrix[at]!.reduce((total, count) => total + count, 0);
    const predicted = matrix.reduce((total, row) => total + row[at]!, 0);
    const falsePositives = predicted - truePositives;
    const falseNegatives = support - truePositives;
    const precision = ratio(truePositives, truePositives + falsePositives);
    const recall = ratio(truePositives, truePositives + falseNegatives);
    return {
      label,
      support,
      predicted,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1: ratio(2 * precision * recall, precision + recall),
    };
  });

  // A class with no cases and no predictions would otherwise drag every macro average
  // towards zero for a class the suite never exercised.
  const averaged = perClass.filter((entry) => entry.support > 0 || entry.predicted > 0);
  const correct = perClass.reduce((total, entry) => total + entry.truePositives, 0);

  return {
    labels: order,
    matrix,
    scored: scoredPairs.length,
    correct,
    accuracy: ratio(correct, scoredPairs.length),
    perClass,
    macroPrecision: mean(averaged.map((entry) => entry.precision)),
    macroRecall: mean(averaged.map((entry) => entry.recall)),
    macroF1: mean(averaged.map((entry) => entry.f1)),
    macroLabels: averaged.map((entry) => entry.label),
    excluded,
  };
}
