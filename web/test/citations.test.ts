import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Source } from '../src/api/types.ts';
import { groupSources, resolveCitationRun, sourceElementId, sourceHost } from '../src/chat/citations.ts';

const qobo: Source = { title: 'Pricing', url: 'https://qobo.dev/pricing', kind: 'qobo' };
const web: Source = { title: 'GST rates', url: 'https://www.gst.gov.in/rates', kind: 'web' };

describe('resolveCitationRun', () => {
  it('maps [n] to the nth source, because the API numbers them in first-cited order', () => {
    const run = resolveCitationRun([1, 2], [qobo, web]);
    assert.deepEqual(run.resolved, [
      { number: 1, source: qobo },
      { number: 2, source: web },
    ]);
    assert.deepEqual(run.unresolved, []);
  });

  it('keeps a number with no source unresolved instead of inventing a citation', () => {
    const run = resolveCitationRun([1, 3], [qobo]);
    assert.deepEqual(run.resolved, [{ number: 1, source: qobo }]);
    assert.deepEqual(run.unresolved, [3]);
  });

  it('rejects zero, negatives and fractions', () => {
    assert.deepEqual(resolveCitationRun([0, -1, 1.5], [qobo]).unresolved, [0, -1, 1.5]);
  });

  it('resolves nothing when the message carries no sources', () => {
    assert.deepEqual(resolveCitationRun([1], []), { resolved: [], unresolved: [1] });
  });
});

describe('source presentation', () => {
  it('keeps QOBO pages and web research apart', () => {
    const about: Source = { ...qobo, title: 'About' };
    assert.deepEqual(groupSources([qobo, web, about]), { qobo: [qobo, about], web: [web] });
  });

  it('shows the host without a www prefix, and falls back to the raw value', () => {
    assert.equal(sourceHost('https://www.gst.gov.in/rates'), 'gst.gov.in');
    assert.equal(sourceHost('https://qobo.dev/pricing'), 'qobo.dev');
    assert.equal(sourceHost('nonsense'), 'nonsense');
  });

  it('builds ids that are unique per message and number', () => {
    assert.equal(sourceElementId('m1', 2), 'source-m1-2');
    assert.notEqual(sourceElementId('m1', 2), sourceElementId('m2', 2));
  });
});
