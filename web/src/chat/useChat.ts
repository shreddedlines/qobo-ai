import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { getApiClient } from '../api/instance.ts';
import type { SendMessageResponse } from '../api/types.ts';
import { chatReducer, chatStateFor, type ChatState } from './conversation-state.ts';
import { runSend } from './send.ts';

export interface UseChat {
  state: ChatState;
  send: (text: string) => Promise<SendMessageResponse | null>;
  retry: () => Promise<SendMessageResponse | null>;
  stop: () => void;
  dismissFailure: () => void;
  reloadHistory: () => void;
}

/**
 * Chat state for one conversation: loads its history, sends messages, and cancels a
 * send in flight. The conversation id may be null (a new chat), in which case the first
 * successful send returns the conversation the API created.
 */
export function useChat(conversationId: string | null): UseChat {
  const [state, dispatch] = useReducer(chatReducer, conversationId, chatStateFor);

  // The send routine needs the current state without being rebuilt on every keystroke.
  // The ref is synced after commit; refs must not be written during render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /** Conversation whose history is already in state, so navigating to it does not refetch. */
  const loadedIdRef = useRef<string | null>(null);
  const sendControllerRef = useRef<AbortController | null>(null);
  /** Bumped to ask for the history again after a failed load. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (conversationId === null) {
      loadedIdRef.current = null;
      if (stateRef.current.conversationId !== null) dispatch({ type: 'conversation/reset' });
      return;
    }
    if (conversationId === loadedIdRef.current) return;

    const controller = new AbortController();
    dispatch({ type: 'history/load' });
    getApiClient()
      .getConversationMessages(conversationId, { signal: controller.signal })
      .then((result) => {
        loadedIdRef.current = conversationId;
        dispatch({ type: 'history/loaded', conversation: result.conversation, messages: result.messages });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'history/failed', error });
      });

    return () => controller.abort();
  }, [conversationId, reloadToken]);

  // Abandon a request in flight when the conversation changes or the page unmounts.
  useEffect(() => () => sendControllerRef.current?.abort(), []);

  const attempt = useCallback(async (text: string): Promise<SendMessageResponse | null> => {
    if (stateRef.current.outgoing) return null;

    const controller = new AbortController();
    sendControllerRef.current = controller;

    const response = await runSend({
      state: stateRef.current,
      text,
      signal: controller.signal,
      deps: {
        client: getApiClient(),
        dispatch,
        newId: () => crypto.randomUUID(),
        now: () => Date.now(),
      },
    });

    sendControllerRef.current = null;
    // The history for this conversation is now in state; do not refetch it on navigation.
    if (response) loadedIdRef.current = response.conversation.id;
    return response;
  }, []);

  const retry = useCallback(async () => {
    const failure = stateRef.current.failure;
    return failure ? attempt(failure.text) : null;
  }, [attempt]);

  const stop = useCallback(() => sendControllerRef.current?.abort(), []);
  const dismissFailure = useCallback(() => dispatch({ type: 'failure/dismiss' }), []);
  const reloadHistory = useCallback(() => {
    loadedIdRef.current = null;
    setReloadToken((token) => token + 1);
  }, []);

  return { state, send: attempt, retry, stop, dismissFailure, reloadHistory };
}
