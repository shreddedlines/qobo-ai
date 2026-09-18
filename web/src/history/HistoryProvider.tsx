import { createContext, useCallback, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';

import { getApiClient } from '../api/instance.ts';
import type { ConversationSummary } from '../api/types.ts';
import { historyReducer, initialHistoryState, type HistoryState } from './history-state.ts';

export interface HistoryContextValue extends HistoryState {
  /** Load the list again after a failure. */
  reload: () => void;
  /** Reflect a conversation the chat just created or added to, without refetching. */
  noteConversation: (conversation: ConversationSummary) => void;
  /** Deletes on the API; resolves true when the conversation is gone. */
  deleteConversation: (id: string) => Promise<boolean>;
  clearNotices: () => void;
}

const HistoryContext = createContext<HistoryContextValue | null>(null);

const PAGE_SIZE = 50;

/**
 * Holds the conversation list for everything that needs it: the sidebar renders it and
 * the chat page adds to it, so sending a first message makes the new conversation appear
 * without a second round trip.
 */
export function HistoryProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(historyReducer, initialHistoryState);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getApiClient()
      .listConversations({ limit: PAGE_SIZE }, { signal: controller.signal })
      .then((result) => dispatch({ type: 'loaded', conversations: result.conversations }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: 'failed', error });
      });

    return () => controller.abort();
  }, [reloadToken]);

  const reload = useCallback(() => {
    dispatch({ type: 'load' });
    setReloadToken((token) => token + 1);
  }, []);

  const noteConversation = useCallback((conversation: ConversationSummary) => dispatch({ type: 'upsert', conversation }), []);
  const clearNotices = useCallback(() => dispatch({ type: 'notice/clear' }), []);

  const deleteConversation = useCallback(async (id: string) => {
    dispatch({ type: 'delete/start', id });
    try {
      await getApiClient().deleteConversation(id);
      dispatch({ type: 'delete/succeeded', id });
      return true;
    } catch (error) {
      dispatch({ type: 'delete/failed', error });
      return false;
    }
  }, []);

  return (
    <HistoryContext.Provider value={{ ...state, reload, noteConversation, deleteConversation, clearNotices }}>
      {children}
    </HistoryContext.Provider>
  );
}

export function useHistory(): HistoryContextValue {
  const value = useContext(HistoryContext);
  if (!value) throw new Error('useHistory must be used inside HistoryProvider');
  return value;
}
