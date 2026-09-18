import type { ConversationSummary } from '../api/types.ts';

export interface HistoryState {
  conversations: ConversationSummary[];
  status: 'loading' | 'ready' | 'error';
  /** Why the list could not be loaded. */
  error: unknown | null;
  /** The conversation currently being deleted, so its row can show progress. */
  deletingId: string | null;
  deleteError: unknown | null;
  /** The conversation whose new name is being saved. */
  renamingId: string | null;
  renameError: unknown | null;
  /** Title of the conversation just deleted, announced once and then cleared. */
  deletedTitle: string | null;
}

export type HistoryAction =
  | { type: 'load' }
  | { type: 'loaded'; conversations: ConversationSummary[] }
  | { type: 'failed'; error: unknown }
  /** A conversation was created or used; it moves to the front of the list. */
  | { type: 'upsert'; conversation: ConversationSummary }
  | { type: 'rename/start'; id: string }
  | { type: 'rename/succeeded'; conversation: ConversationSummary }
  | { type: 'rename/failed'; error: unknown }
  | { type: 'delete/start'; id: string }
  | { type: 'delete/succeeded'; id: string }
  | { type: 'delete/failed'; error: unknown }
  | { type: 'notice/clear' };

export const initialHistoryState: HistoryState = {
  conversations: [],
  status: 'loading',
  error: null,
  deletingId: null,
  deleteError: null,
  renamingId: null,
  renameError: null,
  deletedTitle: null,
};

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'load':
      return { ...state, status: 'loading', error: null };

    case 'loaded':
      return { ...state, conversations: action.conversations, status: 'ready', error: null };

    case 'failed':
      return { ...state, status: 'error', error: action.error };

    case 'upsert': {
      const others = state.conversations.filter((conversation) => conversation.id !== action.conversation.id);
      return { ...state, conversations: [action.conversation, ...others], status: 'ready', error: null };
    }

    case 'rename/start':
      return { ...state, renamingId: action.id, renameError: null };

    case 'rename/succeeded':
      return {
        ...state,
        // Renaming is not activity, so the row keeps its place in the list.
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversation.id ? { ...conversation, title: action.conversation.title } : conversation,
        ),
        renamingId: null,
        renameError: null,
      };

    case 'rename/failed':
      return { ...state, renamingId: null, renameError: action.error };

    case 'delete/start':
      return { ...state, deletingId: action.id, deleteError: null };

    case 'delete/succeeded': {
      const deleted = state.conversations.find((conversation) => conversation.id === action.id);
      return {
        ...state,
        conversations: state.conversations.filter((conversation) => conversation.id !== action.id),
        deletingId: state.deletingId === action.id ? null : state.deletingId,
        deleteError: null,
        deletedTitle: deleted?.title ?? null,
      };
    }

    case 'delete/failed':
      return { ...state, deletingId: null, deleteError: action.error };

    case 'notice/clear':
      return { ...state, deletedTitle: null, deleteError: null, renameError: null };
  }
}

/**
 * Where to go after a delete. Deleting some other conversation leaves the open one
 * alone; deleting the open one moves to the next conversation in the list, or to a new
 * chat when none is left — so the person is never left looking at a deleted chat.
 */
export function afterDeleteTarget(
  conversations: readonly ConversationSummary[],
  deletedId: string,
  currentId: string | null,
): { navigate: boolean; to: string } {
  if (currentId !== deletedId) return { navigate: false, to: `/chat/${currentId ?? ''}` };

  const remaining = conversations.filter((conversation) => conversation.id !== deletedId);
  const next = remaining[0];
  return { navigate: true, to: next ? `/chat/${next.id}` : '/chat' };
}

export function isActiveConversation(id: string, currentId: string | null): boolean {
  return currentId !== null && id === currentId;
}

/**
 * Arrow-key movement within the conversation list. Focus clamps at the ends rather than
 * wrapping, so holding a key cannot silently cycle a long list.
 */
export function nextFocusIndex(current: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return Math.min(current + 1, count - 1);
    case 'ArrowUp':
      return Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
