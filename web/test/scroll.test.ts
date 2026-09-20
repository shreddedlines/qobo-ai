import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FOLLOW_THRESHOLD_PX, isFollowingBottom, readViewportPosition } from '../src/chat/scroll.ts';

/** A 800px-tall window over `contentHeight` of page, scrolled to `scrollTop`. */
const at = (scrollTop: number, contentHeight: number) => ({ scrollTop, viewportHeight: 800, contentHeight });

describe('following a reply as it is written', () => {
  it('follows someone sitting at the bottom', () => {
    assert.equal(isFollowingBottom(at(1_200, 2_000)), true);
  });

  it('keeps following within the threshold, so a line of new text does not break it', () => {
    assert.equal(isFollowingBottom(at(2_000 - 800 - FOLLOW_THRESHOLD_PX, 2_000)), true, 'exactly at the threshold still counts');
    assert.equal(isFollowingBottom(at(1_120, 2_000)), true, '80px from the bottom');
  });

  it('stops following someone who scrolled up to re-read something', () => {
    assert.equal(isFollowingBottom(at(2_000 - 800 - FOLLOW_THRESHOLD_PX - 1, 2_000)), false, 'one pixel past the threshold');
    assert.equal(isFollowingBottom(at(400, 4_000)), false, 'well up the page');
    assert.equal(isFollowingBottom(at(0, 4_000)), false, 'at the very top');
  });

  it('counts a page with nothing to scroll as following', () => {
    assert.equal(isFollowingBottom(at(0, 800)), true, 'content exactly fills the window');
    assert.equal(isFollowingBottom(at(0, 300)), true, 'content shorter than the window');
  });

  it('tolerates a scroll position rounded past the bottom', () => {
    // Browsers can report a fractional scrollTop that overshoots slightly.
    assert.equal(isFollowingBottom(at(1_200.6, 2_000)), true);
  });

  it('takes a threshold of its own when asked', () => {
    assert.equal(isFollowingBottom(at(1_100, 2_000), 200), true);
    assert.equal(isFollowingBottom(at(1_100, 2_000), 50), false);
  });

  it('reports no position where there is no document, rather than guessing one', () => {
    assert.equal(readViewportPosition(), null);
  });
});
