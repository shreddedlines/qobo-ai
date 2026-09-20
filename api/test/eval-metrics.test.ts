import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { intentMetrics, type IntentPrediction } from '../scripts/eval/lib/metrics.ts';

const LABELS = ['qobo', 'general', 'off_topic', 'smalltalk'] as const;

/** Shorthand for a scored case: gold → predicted. */
const p = (id: string, gold: string, predicted: string): IntentPrediction => ({ id, gold, predicted });

const byLabel = (metrics: ReturnType<typeof intentMetrics>, label: string) => metrics.perClass.find((entry) => entry.label === label)!;

describe('intent classification metrics', () => {
  it('scores a perfect classification as 1 across the board', () => {
    const metrics = intentMetrics(
      [p('a', 'qobo', 'qobo'), p('b', 'qobo', 'qobo'), p('c', 'general', 'general'), p('d', 'off_topic', 'off_topic'), p('e', 'smalltalk', 'smalltalk')],
      LABELS,
    );

    assert.equal(metrics.scored, 5);
    assert.equal(metrics.correct, 5);
    assert.equal(metrics.accuracy, 1);
    assert.equal(metrics.macroPrecision, 1);
    assert.equal(metrics.macroRecall, 1);
    assert.equal(metrics.macroF1, 1);
    // Every count sits on the diagonal.
    assert.deepEqual(metrics.matrix, [
      [2, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
  });

  it('counts a false positive and a false negative on the right classes', () => {
    // One qobo case is misread as general: qobo loses recall, general loses precision.
    const metrics = intentMetrics([p('a', 'qobo', 'qobo'), p('b', 'qobo', 'general'), p('c', 'general', 'general')], LABELS);

    assert.equal(metrics.scored, 3);
    assert.equal(metrics.correct, 2);
    assert.equal(metrics.accuracy, 2 / 3);

    const qobo = byLabel(metrics, 'qobo');
    assert.deepEqual([qobo.support, qobo.predicted, qobo.truePositives, qobo.falsePositives, qobo.falseNegatives], [2, 1, 1, 0, 1]);
    assert.equal(qobo.precision, 1, 'everything called qobo was qobo');
    assert.equal(qobo.recall, 0.5, 'one of two qobo cases was missed');
    assert.equal(qobo.f1, (2 * 1 * 0.5) / 1.5);

    const general = byLabel(metrics, 'general');
    assert.deepEqual([general.support, general.predicted, general.truePositives, general.falsePositives, general.falseNegatives], [1, 2, 1, 1, 0]);
    assert.equal(general.precision, 0.5, 'one of two general predictions was wrong');
    assert.equal(general.recall, 1);
  });

  it('reports a class with no cases and no predictions as zero, and leaves it out of the macro averages', () => {
    const metrics = intentMetrics([p('a', 'qobo', 'qobo'), p('b', 'general', 'general')], LABELS);

    const smalltalk = byLabel(metrics, 'smalltalk');
    assert.deepEqual([smalltalk.support, smalltalk.predicted], [0, 0]);
    assert.deepEqual([smalltalk.precision, smalltalk.recall, smalltalk.f1], [0, 0, 0], 'zero rather than NaN');

    assert.deepEqual(metrics.macroLabels, ['qobo', 'general'], 'only classes the suite exercised are averaged');
    assert.equal(metrics.macroF1, 1, 'an unexercised class does not drag the average down');
  });

  it('scores a class that was predicted but never occurred', () => {
    // Nothing is really off_topic, yet one case was routed there.
    const metrics = intentMetrics([p('a', 'qobo', 'off_topic'), p('b', 'qobo', 'qobo')], LABELS);

    const offTopic = byLabel(metrics, 'off_topic');
    assert.deepEqual([offTopic.support, offTopic.predicted, offTopic.falsePositives], [0, 1, 1]);
    assert.equal(offTopic.precision, 0);
    assert.equal(offTopic.recall, 0, 'no support, so recall is reported as zero');
    assert.equal(offTopic.f1, 0);
    assert.ok(metrics.macroLabels.includes('off_topic'), 'a class that was predicted is averaged, even with no support');
  });

  it('excludes an ambiguous case, and says why', () => {
    const metrics = intentMetrics(
      [p('a', 'qobo', 'qobo'), { id: 'general-seo-and-qobo', predicted: 'general', ambiguous: true }, p('c', 'general', 'general')],
      LABELS,
    );

    assert.equal(metrics.scored, 2, 'the ambiguous case does not enter the matrix');
    assert.equal(metrics.matrix.flat().reduce((total, count) => total + count, 0), 2);
    assert.deepEqual(metrics.excluded, [{ id: 'general-seo-and-qobo', reason: 'ambiguous' }]);
    assert.equal(metrics.accuracy, 1);
  });

  it('excludes a case with no gold intent and one that never answered', () => {
    const metrics = intentMetrics([p('a', 'qobo', 'qobo'), { id: 'unlabelled', predicted: 'qobo' }, { id: 'errored', gold: 'qobo' }], LABELS);

    assert.equal(metrics.scored, 1);
    assert.deepEqual(metrics.excluded, [
      { id: 'unlabelled', reason: 'no gold intent' },
      { id: 'errored', reason: 'no prediction' },
    ]);
  });

  it('keeps the reporting order, and surfaces a label the caller did not expect', () => {
    const metrics = intentMetrics([p('a', 'qobo', 'qobo'), p('b', 'qobo', 'something_new')], LABELS);

    assert.deepEqual(metrics.labels.slice(0, 4), [...LABELS], 'the given order is preserved');
    assert.ok(metrics.labels.includes('something_new'), 'an unknown predicted class is not silently dropped');
    assert.equal(byLabel(metrics, 'something_new').falsePositives, 1);
  });

  it('returns zeroed metrics rather than NaN when nothing can be scored', () => {
    const metrics = intentMetrics([{ id: 'only-ambiguous', predicted: 'qobo', ambiguous: true }], LABELS);

    assert.equal(metrics.scored, 0);
    assert.equal(metrics.accuracy, 0);
    assert.equal(metrics.macroF1, 0);
    assert.deepEqual(metrics.macroLabels, []);
  });
});
