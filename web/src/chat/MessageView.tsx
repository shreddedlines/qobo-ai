import type { ChatMessage } from '../api/types.ts';
import { editActionLabel } from './editing.ts';
import { MarkdownContent } from './MarkdownContent.tsx';
import { SourceStrip } from './SourceStrip.tsx';

export interface UserMessageProps {
  text: string;
  /** Absent for a message that cannot be edited, such as one still being sent. */
  onEdit?: (() => void) | undefined;
  /** True while this message's text is loaded in the composer. */
  editing?: boolean;
}

/**
 * A message the person sent: their own words, shown verbatim.
 *
 * The Edit control sits beside the bubble rather than under it, in space that is empty
 * anyway, so offering it costs no vertical room. On a pointer device it appears on
 * hover or keyboard focus; on a touch screen, where there is no hover, it is always
 * there.
 */
export function UserMessage({ text, onEdit, editing = false }: UserMessageProps) {
  return (
    <div className="group/message flex items-center justify-end gap-1">
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label={editActionLabel(text)}
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover/message:opacity-100 max-md:opacity-100"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M11.3 2.7a1.4 1.4 0 0 1 2 2L5.6 12.4l-2.8.7.7-2.8 7.8-7.6Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <div
        className={`max-w-[85%] rounded-md px-4 py-2.5 text-[15px] whitespace-pre-wrap ${
          editing ? 'bg-brand-tint text-brand-ink ring-2 ring-brand-strong' : 'bg-brand-tint text-brand-ink'
        }`}
      >
        <span className="sr-only">You said: </span>
        {text}
        {editing ? <span className="sr-only"> (being edited)</span> : null}
      </div>
    </div>
  );
}

export interface AssistantMessageProps {
  message: ChatMessage;
}

/** A reply from QOBO: rendered Markdown, then the sources it was based on. */
export function AssistantMessage({ message }: AssistantMessageProps) {
  return (
    <div className="measure">
      <span className="sr-only">QOBO replied: </span>
      <MarkdownContent content={message.content} sources={message.sources} messageId={message.id} />
      <SourceStrip sources={message.sources} messageId={message.id} />
    </div>
  );
}

export interface MessageViewProps {
  message: ChatMessage;
  /** Called with this message when the person asks to edit it. */
  onEdit?: ((message: ChatMessage) => void) | undefined;
  editing?: boolean;
}

export function MessageView({ message, onEdit, editing = false }: MessageViewProps) {
  if (message.role !== 'user') return <AssistantMessage message={message} />;

  return (
    <UserMessage
      text={message.content}
      editing={editing}
      {...(onEdit ? { onEdit: () => onEdit(message) } : {})}
    />
  );
}
