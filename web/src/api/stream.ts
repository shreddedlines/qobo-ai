/**
 * Reading a chat reply as it is written.
 *
 * POST /api/chat/stream answers with server-sent events: `delta` frames carrying
 * provisional text, `reset` when what came before is being discarded, and finally
 * either `done` — the same body POST /api/chat returns — or `error`.
 *
 * Both kinds of failure end up as the same ApiError the rest of the app already
 * knows: a status before the stream opens, and an `error` frame after it. So
 * toUserFacingError, isRetryable and the quota copy keep working unchanged, whether
 * a reply was streamed or not.
 */
import { ApiError, apiErrorCodeForStatus, isApiErrorCode } from './errors.ts';
import type { SendMessageRequest, SendMessageResponse, StreamErrorData, StreamFrame, StreamHandlers } from './types.ts';
import { STREAM_EVENTS } from './types.ts';

const UNREADABLE = 'The API returned an unreadable response';

/** A frame arrived that this client cannot read. Never shown; mapped to an ApiError. */
class MalformedFrameError extends Error {}

function isStreamEvent(value: string): value is StreamFrame['event'] {
  return (STREAM_EVENTS as readonly string[]).includes(value);
}

/**
 * Turns raw chunks into frames. A chunk is whatever arrived over the wire, so a frame
 * can be split across several of them and several frames can share one: the tail is
 * kept until its blank-line terminator shows up.
 */
export function createFrameParser() {
  let buffer = '';

  return {
    push(chunk: string): StreamFrame[] {
      // The spec allows CRLF; normalising once keeps the split below simple.
      buffer += chunk.replace(/\r\n/g, '\n');
      const frames: StreamFrame[] = [];

      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        let event = '';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line === '' || line.startsWith(':')) continue; // keep-alive comments
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }

        // An event this version does not know is ignored rather than fatal, so the
        // API can add one without breaking clients already in people's browsers.
        if (data.length === 0 || !isStreamEvent(event)) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data.join('\n'));
        } catch (error) {
          throw new MalformedFrameError(`${event} frame is not valid JSON`, { cause: error });
        }
        frames.push({ event, data: parsed } as StreamFrame);
      }

      return frames;
    },
  };
}

function errorFromFrame(data: StreamErrorData, requestId: string | null): ApiError {
  // The HTTP status really was 200 — the failure happened after the reply started.
  return new ApiError({
    status: 200,
    code: isApiErrorCode(data?.code) ? data.code : 'internal_error',
    message: typeof data?.message === 'string' && data.message !== '' ? data.message : 'QOBO could not finish this reply',
    details: data?.details,
    requestId,
  });
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export interface StreamChatInput {
  url: string;
  accessToken: string;
  body: SendMessageRequest;
  handlers: StreamHandlers;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Sends one message and resolves with the saved exchange, reporting the answer on the
 * way. The resolved value is exactly what the non-streaming endpoint returns.
 */
export async function streamChatMessage({ url, accessToken, body, handlers, fetchImpl, timeoutMs, signal: callerSignal }: StreamChatInput): Promise<SendMessageResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;

  /** A caller-triggered abort is the person's own choice, not a failure to explain. */
  const asApiError = (error: unknown, requestId: string | null = null): unknown => {
    if (callerSignal?.aborted) return error;
    if (error instanceof ApiError) return error;
    if (error instanceof MalformedFrameError) return new ApiError({ status: 200, code: 'internal_error', message: UNREADABLE, requestId, cause: error });
    return isTimeout(error)
      ? new ApiError({ status: 0, code: 'timeout', message: 'The request timed out', requestId, cause: error })
      : new ApiError({ status: 0, code: 'network', message: 'The connection to QOBO was lost', requestId, cause: error });
  };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
    });
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    throw isTimeout(error)
      ? new ApiError({ status: 0, code: 'timeout', message: 'The request timed out', cause: error })
      : new ApiError({ status: 0, code: 'network', message: 'The request could not be sent', cause: error });
  }

  const requestId = response.headers.get('X-Request-Id');

  // Anything settled before the stream opens — validation, the daily cap, a
  // conversation that is not yours — arrives as an ordinary status, as it always has.
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined;
    const code = isApiErrorCode(errorBody?.error?.code) ? errorBody.error.code : apiErrorCodeForStatus(response.status);
    const message = typeof errorBody?.error?.message === 'string' ? errorBody.error.message : `Request failed with HTTP ${response.status}`;
    throw new ApiError({ status: response.status, code, message, details: errorBody?.error?.details, requestId });
  }

  if (!response.headers.get('Content-Type')?.includes('text/event-stream') || !response.body) {
    throw new ApiError({ status: response.status, code: 'internal_error', message: UNREADABLE, requestId });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createFrameParser();
  let result: SendMessageResponse | null = null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        switch (frame.event) {
          case 'delta':
            handlers.onDelta(frame.data.text);
            break;
          case 'reset':
            handlers.onReset?.();
            break;
          case 'done':
            result = frame.data;
            break;
          case 'error':
            throw errorFromFrame(frame.data, requestId);
        }
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw asApiError(error, requestId);
  }

  // The stream ended without saying how it went, so the reply is simply not here.
  if (!result) {
    throw new ApiError({ status: 200, code: 'network', message: 'The connection closed before QOBO finished replying', requestId });
  }
  return result;
}
