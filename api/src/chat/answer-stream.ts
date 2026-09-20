import type { StreamHandlers } from '../rag/generator.ts';

/**
 * The sink between the answer model and the browser.
 *
 * What the model writes is not what a reader should see. It cites internal ids —
 * `[S1]` for a knowledge-base source, `[W2]` for a web result — which only mean
 * something to `resolveCitations`, and which are renumbered to `[1]`, `[2]` or
 * dropped once the answer is complete. Sending them out raw would leak the prompt's
 * own bookkeeping and then visibly rewrite itself when the final answer lands.
 *
 * So markers are removed as the text goes past. A marker can be split across chunks
 * ("[S" then "1]"), so an opening bracket is held back until it either closes as a
 * marker — dropped — or turns out to be ordinary prose — released unchanged.
 *
 * Everything here is provisional. The canonical answer, with its resolved citations
 * and guards, is what the caller sends once the pipeline finishes.
 */

/** A complete marker: [S1], [W2], [S1, S2]. Mirrors MARKER_GROUP in rag/sources.ts. */
const MARKER = /^\[\s*[SW]\d+(?:\s*[,;]\s*[SW]\d+)*\s*\]$/;
/** Could still become one: only the characters a marker is made of have arrived. */
const MARKER_PREFIX = /^\[[\sSW\d,;]*$/;
/**
 * A bracket holding back more than this is not a citation, whatever it looks like.
 * Bounded so a stray "[" can never swallow the rest of an answer.
 */
const MAX_HELD = 32;

export interface AnswerStream extends StreamHandlers {
  /**
   * Ends the provisional text. Anything still held back is a bracket that was on its
   * way to being an id when the answer stopped, so it is dropped rather than shown:
   * a stray "[S" is never worth leaking, and the canonical answer follows anyway.
   */
  flush(): void;
}

export interface AnswerStreamTarget {
  onDelta(text: string): void;
  onReset(): void;
}

export function createAnswerStream(target: AnswerStreamTarget): AnswerStream {
  /** A possible marker, from its "[" onwards, waiting to be identified. */
  let held = '';

  const emit = (text: string): void => {
    if (text !== '') target.onDelta(text);
  };

  return {
    onDelta(delta: string): void {
      let out = '';

      for (const char of delta) {
        if (held === '') {
          if (char === '[') held = '[';
          else out += char;
          continue;
        }

        const candidate = held + char;
        if (char === ']') {
          if (!MARKER.test(candidate)) out += candidate;
          held = '';
        } else if (candidate.length <= MAX_HELD && MARKER_PREFIX.test(candidate)) {
          held = candidate;
        } else {
          // Not a marker after all: the bracket was just prose.
          out += held;
          held = '';
          if (char === '[') held = '[';
          else out += char;
        }
      }

      emit(out);
    },

    onReset(): void {
      held = '';
      target.onReset();
    },

    flush(): void {
      held = '';
    },
  };
}
