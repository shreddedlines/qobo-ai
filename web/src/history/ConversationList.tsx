import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';

import { toUserFacingError } from '../api/errors.ts';
import type { ConversationSummary } from '../api/types.ts';
import { Button } from '../ui/Button.tsx';
import { conversationTimeLabel, displayTitle, groupConversations } from './conversation-groups.ts';
import { isActiveConversation, nextFocusIndex } from './history-state.ts';
import { useHistory } from './HistoryProvider.tsx';
import { normalizeTitle, titleProblem } from './rename.ts';

export interface ConversationListProps {
  /** Conversation in the address bar, or null on a new chat. */
  currentId: string | null;
  /** Asks to delete; the layout owns the dialog so one dialog serves the whole list. */
  onRequestDelete: (conversation: ConversationSummary) => void;
  /** Called after following a link, so the mobile drawer can close itself. */
  onNavigate?: () => void;
}

interface RenameFormProps {
  conversation: ConversationSummary;
  saving: boolean;
  onSave: (title: string) => void;
  onCancel: () => void;
}

/**
 * Renaming in place: the row becomes a small form. Save stays disabled until the name
 * would survive trimming, so an empty or whitespace-only title is never even sent —
 * the API trims and refuses it too, and the column has its own length check.
 */
function RenameForm({ conversation, saving, onSave, onCancel }: RenameFormProps) {
  const [value, setValue] = useState(conversation.title);
  const fieldId = `rename-${conversation.id}`;
  const problem = titleProblem(value);

  function submit(event: FormEvent) {
    event.preventDefault();
    const title = normalizeTitle(value);
    if (title) onSave(title);
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-1 px-2 py-1.5">
      <label htmlFor={fieldId} className="sr-only">
        Name for this chat
      </label>
      <input
        id={fieldId}
        autoFocus
        value={value}
        disabled={saving}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${fieldId}-problem` : undefined}
        className="min-h-11 w-full rounded-md border border-line bg-surface px-2 text-[14px] text-ink disabled:opacity-60"
      />
      {problem ? (
        <p id={`${fieldId}-problem`} className="text-[12px] font-medium text-danger">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-1">
        <Button type="submit" disabled={saving || problem !== null} className="flex-1 px-2 text-[14px]">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" disabled={saving} onClick={onCancel} className="flex-1 px-2 text-[14px]">
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Placeholder() {
  return (
    <div className="flex flex-col gap-2 px-3 py-2" aria-busy="true">
      <p role="status" className="sr-only">
        Loading your conversations.
      </p>
      {[80, 64, 72, 56].map((width, index) => (
        <div key={index} className="h-4 rounded-sm bg-line" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

export function ConversationList({ currentId, onRequestDelete, onNavigate }: ConversationListProps) {
  const { conversations, status, error, deletingId, renamingId, renameConversation, reload } = useHistory();
  const listRef = useRef<HTMLDivElement>(null);
  const [renamingRow, setRenamingRow] = useState<string | null>(null);
  // The list can be on screen twice (sidebar and drawer), so heading ids must differ.
  const groupIdPrefix = useId();

  // Up and down move between conversations; Tab still reaches the delete buttons.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-conversation]') ?? [])];
    const current = links.findIndex((link) => link === document.activeElement);
    if (current === -1) return;

    const next = nextFocusIndex(current, event.key, links.length);
    if (next === null) return;
    event.preventDefault();
    links[next]?.focus();
  }

  if (status === 'loading') return <Placeholder />;

  if (status === 'error') {
    const { title, detail } = toUserFacingError(error);
    return (
      <div role="alert" className="px-3 py-2">
        <p className="text-[14px] font-semibold text-danger">{title}</p>
        <p className="mt-1 text-[13px] text-danger-ink">{detail}</p>
        <Button variant="secondary" onClick={reload} className="mt-3 min-h-11 px-3 text-[14px]">
          Try again
        </Button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <p className="px-3 py-2 text-[14px] text-muted">
        Your chats will be listed here once you ask QOBO something.
      </p>
    );
  }

  return (
    <div ref={listRef} onKeyDown={handleKeyDown} className="flex flex-col gap-4">
      {groupConversations(conversations).map((group) => (
        <section key={group.key} aria-labelledby={`${groupIdPrefix}-${group.key}`}>
          <h3 id={`${groupIdPrefix}-${group.key}`} className="px-3 text-[12px] font-semibold text-muted">
            {group.label}
          </h3>
          <ul className="mt-1 flex flex-col">
            {group.conversations.map((conversation) => {
              const active = isActiveConversation(conversation.id, currentId);
              const deleting = deletingId === conversation.id;

              if (renamingRow === conversation.id) {
                return (
                  <li key={conversation.id} className="flex items-center">
                    <RenameForm
                      conversation={conversation}
                      saving={renamingId === conversation.id}
                      onCancel={() => setRenamingRow(null)}
                      onSave={async (title) => {
                        const saved = await renameConversation(conversation.id, title);
                        if (saved) setRenamingRow(null);
                      }}
                    />
                  </li>
                );
              }

              return (
                <li key={conversation.id} className="group/row relative flex items-center">
                  <Link
                    to={`/chat/${conversation.id}`}
                    data-conversation={conversation.id}
                    aria-current={active ? 'page' : undefined}
                    onClick={onNavigate}
                    className={`flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md py-1.5 pr-22 pl-3 text-[14px] ${
                      active ? 'bg-brand-tint font-medium text-brand-ink' : 'text-ink hover:bg-sunken'
                    } ${deleting ? 'opacity-55' : ''}`}
                  >
                    <span className="truncate">{displayTitle(conversation.title)}</span>
                    <span className={`text-[12px] ${active ? 'text-brand-ink' : 'text-muted'}`}>
                      {deleting ? 'Deleting…' : conversationTimeLabel(conversation.updatedAt)}
                    </span>
                  </Link>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => setRenamingRow(conversation.id)}
                    className="absolute right-12 flex size-11 cursor-pointer items-center justify-center rounded-md text-muted opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 disabled:cursor-not-allowed max-md:opacity-100"
                    aria-label={`Rename conversation: ${displayTitle(conversation.title, 80)}`}
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M11.3 2.7a1.4 1.4 0 0 1 2 2L5.6 12.4l-2.8.7.7-2.8 7.8-7.6Z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => onRequestDelete(conversation)}
                    // Always reachable by keyboard and touch; only the pointer needs hover.
                    className="absolute right-1 flex size-11 cursor-pointer items-center justify-center rounded-md text-muted opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100 disabled:cursor-not-allowed max-md:opacity-100"
                    aria-label={`Delete conversation: ${displayTitle(conversation.title, 80)}`}
                  >
                    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8l.7-8.2" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
