import type { Source } from '../api/types.ts';
import { resolveCitationRun, sourceElementId, sourceHost } from './citations.ts';

export interface CitationProps {
  numbers: readonly number[];
  sources: readonly Source[];
  messageId: string;
}

/**
 * A citation marker. Each number links down to its entry in the message's source list,
 * where the outgoing link lives — so a reader can check a claim in one step, by keyboard
 * or by pointer. A number with no matching source stays plain text: the reply is never
 * shown as citing something it cannot.
 */
export function Citation({ numbers, sources, messageId }: CitationProps) {
  const { resolved, unresolved } = resolveCitationRun(numbers, sources);

  // The run is one unbreakable unit, tight against the word before it: a marker that
  // wraps to the next line or floats away from its sentence stops reading as a citation.
  return (
    <span className="whitespace-nowrap">
      {resolved.map(({ number, source }) => (
        <a
          key={number}
          href={`#${sourceElementId(messageId, number)}`}
          className={`ml-0.5 rounded-sm px-[3px] align-super text-[11px] leading-none font-semibold no-underline ${
            source.kind === 'web' ? 'bg-support-tint text-support-ink' : 'bg-brand-tint text-brand-ink'
          }`}
          aria-label={`Source ${number}: ${source.title} — ${sourceHost(source.url)}`}
        >
          {number}
        </a>
      ))}
      {unresolved.map((number) => (
        <span key={`unresolved-${number}`}>{`[${number}]`}</span>
      ))}
    </span>
  );
}
