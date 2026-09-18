import type { ReactNode } from 'react';

import type { Source } from '../api/types.ts';
import type { Block, Inline } from './markdown.ts';
import { parseMarkdown, withoutCitations } from './markdown.ts';

export interface MarkdownContentProps {
  content: string;
  /** Sources for this message, listed under the answer by SourceStrip. */
  sources: readonly Source[];
  messageId: string;
}

function renderInline(nodes: readonly Inline[], context: { sources: readonly Source[]; messageId: string }): ReactNode[] {
  return nodes.map((node, index) => {
    const key = index;
    switch (node.type) {
      case 'text':
        return node.value;
      case 'code':
        return (
          <code key={key} className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-[0.9em] text-ink">
            {node.value}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold">
            {renderInline(node.children, context)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline(node.children, context)}</em>;
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-medium text-ink underline underline-offset-2"
          >
            {renderInline(node.children, context)}
          </a>
        );
      case 'citation':
        // Markers are removed before rendering; this keeps the switch exhaustive.
        return null;
    }
  });
}

function renderBlock(block: Block, key: number, context: { sources: readonly Source[]; messageId: string }): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p key={key} className="text-[15px] leading-relaxed text-ink">
          {renderInline(block.children, context)}
        </p>
      );
    case 'heading':
      return block.level === 2 ? (
        <h2 key={key} className="text-[17px] font-semibold text-ink">
          {renderInline(block.children, context)}
        </h2>
      ) : (
        <h3 key={key} className="text-[15px] font-semibold text-ink">
          {renderInline(block.children, context)}
        </h3>
      );
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className="pl-1 text-[15px] leading-relaxed text-ink">
          {renderInline(item, context)}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} className="ml-5 flex list-decimal flex-col gap-1">
          {items}
        </ol>
      ) : (
        <ul key={key} className="ml-5 flex list-disc flex-col gap-1">
          {items}
        </ul>
      );
    }
    case 'code':
      return (
        <pre key={key} className="overflow-x-auto rounded-md bg-sunken p-3 font-mono text-[13px] text-ink">
          <code>{block.value}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={key} className="border-l-2 border-line pl-3 text-[15px] text-muted italic">
          {renderInline(block.children, context)}
        </blockquote>
      );
  }
}

/**
 * Renders an assistant reply. The Markdown is parsed to data and rendered as React
 * elements, so no HTML from the model is ever inserted into the page.
 *
 * The inline [n] markers are stripped: the answer reads as prose, and the pages it came
 * from stay listed and clickable under it.
 */
export function MarkdownContent({ content, sources, messageId }: MarkdownContentProps) {
  const blocks = withoutCitations(parseMarkdown(content));
  const context = { sources, messageId };
  return <div className="flex flex-col gap-3">{blocks.map((block, index) => renderBlock(block, index, context))}</div>;
}
