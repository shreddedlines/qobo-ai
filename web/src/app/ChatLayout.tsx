import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router';

import type { ConversationSummary } from '../api/types.ts';
import { displayTitle } from '../history/conversation-groups.ts';
import { afterDeleteTarget } from '../history/history-state.ts';
import { HistoryProvider, useHistory } from '../history/HistoryProvider.tsx';
import { Sidebar, SidebarContent } from '../history/Sidebar.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Drawer } from '../ui/Drawer.tsx';

function ChatWorkspace() {
  const { conversationId = null } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { conversations, deletingId, deletedTitle, deleteConversation, clearNotices } = useHistory();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);

  // Links inside the drawer close it themselves; this covers browser back and forward,
  // which would otherwise leave a modal drawer open over a different conversation.
  useEffect(() => {
    const close = () => setDrawerOpen(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, []);

  // The "deleted" announcement is read once, then cleared so it cannot be re-read later.
  useEffect(() => {
    if (!deletedTitle) return;
    const timer = setTimeout(clearNotices, 5_000);
    return () => clearTimeout(timer);
  }, [deletedTitle, clearNotices]);

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;

    const deleted = await deleteConversation(target.id);
    setPendingDelete(null);
    if (!deleted) return;

    const next = afterDeleteTarget(conversations, target.id, conversationId);
    if (next.navigate) navigate(next.to, { replace: true });
  }

  return (
    <div className="flex w-full flex-1">
      {/* "Skip to main content" lands before the history list; this reaches the input. */}
      <a
        href="#composer"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-44 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow-soft"
      >
        Skip to the message box
      </a>
      <Sidebar currentId={conversationId} onRequestDelete={setPendingDelete} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Below desktop width the history lives in a drawer behind this control. */}
        <div className="flex items-center gap-2 border-b border-line py-2 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-[15px] font-medium text-ink hover:bg-sunken"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 4h11M2.5 8h11M2.5 12h11" strokeLinecap="round" />
            </svg>
            Your chats
          </button>
        </div>

        <Outlet />
      </div>

      <Drawer open={drawerOpen} label="Chat history" onClose={() => setDrawerOpen(false)}>
        <SidebarContent currentId={conversationId} onRequestDelete={setPendingDelete} onNavigate={() => setDrawerOpen(false)} />
      </Drawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this conversation?"
        description={`“${displayTitle(pendingDelete?.title, 80)}” and its messages will be removed for good. This cannot be undone.`}
        confirmLabel="Delete conversation"
        busy={pendingDelete !== null && deletingId === pendingDelete.id}
        busyLabel="Deleting…"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <p role="status" aria-live="polite" className="sr-only">
        {deletedTitle ? `Conversation deleted: ${displayTitle(deletedTitle, 80)}` : ''}
      </p>
    </div>
  );
}

/** Layout for the chat routes: conversation history beside the conversation itself. */
export function ChatLayout() {
  return (
    <HistoryProvider>
      <ChatWorkspace />
    </HistoryProvider>
  );
}
