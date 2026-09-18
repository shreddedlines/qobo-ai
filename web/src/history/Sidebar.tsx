import { Link } from 'react-router';

import { toUserFacingError } from '../api/errors.ts';
import type { ConversationSummary } from '../api/types.ts';
import { ConversationList } from './ConversationList.tsx';
import { useHistory } from './HistoryProvider.tsx';

export interface SidebarProps {
  currentId: string | null;
  onRequestDelete: (conversation: ConversationSummary) => void;
  /** Closes the drawer after a link is followed; absent on the desktop sidebar. */
  onNavigate?: () => void;
}

function NewChatLink({ onNavigate }: { onNavigate?: (() => void) | undefined }) {
  return (
    <Link
      to="/chat"
      onClick={onNavigate}
      className="mx-3 flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-raised px-4 text-[15px] font-medium text-ink hover:bg-sunken"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
      </svg>
      New chat
    </Link>
  );
}

/** The conversation history: heading, the new-chat action, and the grouped list. */
export function SidebarContent({ currentId, onRequestDelete, onNavigate }: SidebarProps) {
  const { deleteError } = useHistory();

  return (
    <div className="flex flex-col gap-3 py-4">
      <h2 className="px-3 text-[13px] font-semibold text-muted">Your chats</h2>
      <NewChatLink onNavigate={onNavigate} />

      {deleteError ? (
        <div role="alert" className="mx-3 rounded-md border border-danger bg-danger-tint p-2">
          <p className="text-[13px] font-semibold text-danger">{toUserFacingError(deleteError).title}</p>
          <p className="text-[13px] text-danger-ink">{toUserFacingError(deleteError).detail}</p>
        </div>
      ) : null}

      <ConversationList
        currentId={currentId}
        onRequestDelete={onRequestDelete}
        {...(onNavigate ? { onNavigate } : {})}
      />
    </div>
  );
}

/** The always-visible sidebar from desktop width up. */
export function Sidebar(props: SidebarProps) {
  return (
    <nav
      aria-label="Chat history"
      className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[17rem] shrink-0 overflow-y-auto border-r border-line md:block"
    >
      <SidebarContent {...props} />
    </nav>
  );
}
