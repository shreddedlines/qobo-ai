/**
 * Incremental extraction of one top-level string field from a JSON document that
 * arrives in pieces.
 *
 * The answer models are schema-bound and return one object, e.g.
 * `{"status":"answered","answer":"…","citations":["S1"]}`. While it streams, the
 * document is syntactically incomplete, so it cannot be parsed — but the text of
 * the `answer` field can still be read out as it arrives.
 *
 * Searching the raw text for `"answer":"` would also match those characters inside
 * another string value, so this scans properly instead: it tracks the container
 * stack, tells a key apart from a value, and decodes JSON escapes. Only the wanted
 * field's decoded text is ever returned; JSON syntax and every other field stay in.
 *
 * What comes out here is a provisional view for display. The authoritative value is
 * still the whole document, parsed and schema-validated once the stream ends.
 */

export interface JsonStringFieldExtractor {
  /** Feeds the next raw chunk and returns the newly decoded text of the field (often ''). */
  push(chunk: string): string;
  /** True once the field's value has been read to its closing quote. */
  readonly done: boolean;
}

type Mode = 'scan' | 'key' | 'skipString' | 'capture';
type Container = 'object' | 'array';

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

const HEX = /^[0-9a-fA-F]{4}$/;

/** Half of a surrogate pair: on its own it is not yet a character. */
const isHighSurrogate = (char: string): boolean => char >= '\uD800' && char <= '\uDBFF';

export function createJsonStringFieldExtractor(field: string): JsonStringFieldExtractor {
  const stack: Container[] = [];
  let mode: Mode = 'scan';
  /** True where a value belongs (after ':' or inside an array), false where a key does. */
  let expectValue = false;
  /** The most recent key, so the right string is the one captured. */
  let currentKey = '';
  let keyBuffer = '';
  let escaped = false;
  /** Hex digits collected so far for a \uXXXX escape, or null outside one. */
  let unicode: string | null = null;
  /**
   * A lone high surrogate is held back until its pair arrives in the next chunk, so
   * no delta ever ends mid-character.
   */
  let heldSurrogate = '';
  let done = false;

  /** Reads one character of a string value, returning decoded text and whether the string ended. */
  function readStringChar(char: string): { text: string; closed: boolean } {
    if (unicode !== null) {
      const digits = unicode + char;
      if (digits.length < 4) {
        unicode = digits;
        return { text: '', closed: false };
      }
      unicode = null;
      // Not hex: the model wrote something invalid. Keep it as it came rather than
      // guessing — the final parse is what decides whether the document is usable.
      return { text: HEX.test(digits) ? String.fromCharCode(Number.parseInt(digits, 16)) : `\\u${digits}`, closed: false };
    }
    if (escaped) {
      escaped = false;
      if (char === 'u') {
        unicode = '';
        return { text: '', closed: false };
      }
      return { text: ESCAPES[char] ?? char, closed: false };
    }
    if (char === '\\') {
      escaped = true;
      return { text: '', closed: false };
    }
    if (char === '"') return { text: '', closed: true };
    return { text: char, closed: false };
  }

  /** Decides what an opening quote starts here: the wanted value, another value, or a key. */
  function openString(): Mode {
    if (!expectValue && stack.at(-1) === 'object') {
      keyBuffer = '';
      return 'key';
    }
    const atRoot = stack.length === 1 && stack[0] === 'object';
    return expectValue && atRoot && !done && currentKey === field ? 'capture' : 'skipString';
  }

  return {
    get done() {
      return done;
    },

    push(chunk: string): string {
      let out = heldSurrogate;
      heldSurrogate = '';

      for (const char of chunk) {
        switch (mode) {
          case 'capture': {
            const { text, closed } = readStringChar(char);
            out += text;
            if (closed) {
              done = true;
              mode = 'scan';
              expectValue = false;
            }
            break;
          }

          case 'skipString': {
            if (readStringChar(char).closed) {
              mode = 'scan';
              expectValue = false;
            }
            break;
          }

          case 'key': {
            const { text, closed } = readStringChar(char);
            keyBuffer += text;
            if (closed) {
              currentKey = keyBuffer;
              mode = 'scan';
            }
            break;
          }

          case 'scan': {
            if (char === '{') {
              stack.push('object');
              expectValue = false;
            } else if (char === '[') {
              stack.push('array');
              expectValue = true; // array elements are values, never keys
            } else if (char === '}' || char === ']') {
              stack.pop();
              expectValue = false;
            } else if (char === ':') {
              expectValue = true;
            } else if (char === ',') {
              expectValue = stack.at(-1) === 'array';
            } else if (char === '"') {
              mode = openString();
            }
            break;
          }
        }
      }

      if (!done && out !== '' && isHighSurrogate(out.slice(-1))) {
        heldSurrogate = out.slice(-1);
        out = out.slice(0, -1);
      }
      return out;
    },
  };
}
