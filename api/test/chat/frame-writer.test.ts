import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Response } from 'express';

import { createFrameWriter } from '../../src/chat/routes.ts';

/**
 * Records what reached the response. 'close' is deliberately never emitted: the
 * point of these tests is that the writer stops writing the moment it ends, without
 * waiting for the event.
 */
function fakeResponse() {
  const writes: string[] = [];
  let ended = 0;

  const res = {
    status: () => res,
    setHeader: () => res,
    flushHeaders: () => undefined,
    on: () => res,
    write: (chunk: string) => {
      if (ended > 0) throw new Error('write after end');
      writes.push(chunk);
      return true;
    },
    end: () => {
      ended += 1;
      return res;
    },
  };

  return {
    res: res as unknown as Response,
    writes,
    get ended() {
      return ended;
    },
  };
}

describe('SSE frame writer', () => {
  it('writes nothing once the stream has ended', () => {
    const target = fakeResponse();
    const frames = createFrameWriter(target.res);

    frames.open();
    frames.send('delta', { text: 'in time' });
    const beforeEnd = target.writes.length;
    assert.equal(beforeEnd, 1);

    frames.end();

    // Work that outlived the response — the pipeline keeps running after a timeout —
    // must not reach res.write(), which would throw ERR_STREAM_WRITE_AFTER_END.
    frames.send('delta', { text: 'too late' });
    frames.send('error', { code: 'timeout', message: 'too late' });
    frames.heartbeat();

    assert.equal(target.writes.length, beforeEnd, 'no frame was written after end()');
    assert.deepEqual(target.writes, ['event: delta\ndata: {"text":"in time"}\n\n']);
  });

  it('ends the response exactly once, however often end() is called', () => {
    const target = fakeResponse();
    const frames = createFrameWriter(target.res);

    frames.open();
    frames.end();
    frames.end();
    frames.end();

    assert.equal(target.ended, 1);
  });

  it('closes before res.end(), not when the close event arrives', () => {
    // The fake throws on a write after end, so a writer that stayed open until
    // 'close' would fail here rather than quietly no-op.
    const target = fakeResponse();
    const frames = createFrameWriter(target.res);

    frames.open();
    frames.end();

    assert.doesNotThrow(() => {
      frames.send('delta', { text: 'late' });
      frames.heartbeat();
    });
  });
});
