import type { ChatMessage } from '../api/types.ts';
import { MarkdownContent } from './MarkdownContent.tsx';
import { SourceStrip } from './SourceStrip.tsx';

/** A message the person sent: their own words, shown verbatim. */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-md bg-brand-tint px-4 py-2.5 text-[15px] whitespace-pre-wrap text-brand-ink">
        <span className="sr-only">You said: </span>
        {text}
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

export function MessageView({ message }: AssistantMessageProps) {
  return message.role === 'user' ? <UserMessage text={message.content} /> : <AssistantMessage message={message} />;
}
