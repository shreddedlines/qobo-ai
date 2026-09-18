import type { Source } from '../api/types.ts';
import { sourceElementId, sourceHost } from './citations.ts';

export interface SourceStripProps {
  sources: readonly Source[];
  messageId: string;
}

/**
 * The sources behind one reply, numbered exactly as the markers in the text.
 *
 * QOBO's own pages and outside web research are told apart by label and by colour —
 * teal is used for nothing else in this interface — so a reader always knows whether a
 * claim comes from QOBO or from the wider web.
 *
 * Each row is one link covering both lines, which keeps the target at least 44px tall
 * and puts the origin ("QOBO", "Web research") inside the link's accessible name.
 */
export function SourceStrip({ sources, messageId }: SourceStripProps) {
  if (sources.length === 0) return null;
  const hasWeb = sources.some((source) => source.kind === 'web');

  return (
    <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted">Sources</h3>
      <ol className="mt-1 flex flex-col">
        {sources.map((source, index) => {
          const number = index + 1;
          const isWeb = source.kind === 'web';
          return (
            <li key={`${number}-${source.url}`} id={sourceElementId(messageId, number)} tabIndex={-1} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={`mt-3 inline-flex min-w-5 justify-center rounded-sm px-1 text-[12px] font-semibold ${
                  isWeb ? 'bg-support-tint text-support-ink' : 'bg-brand-tint text-brand-ink'
                }`}
              >
                {number}
              </span>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md py-1.5"
              >
                <span className="text-[14px] font-medium text-ink underline underline-offset-2">{source.title}</span>
                <span className="text-[12px] text-muted">
                  {isWeb ? (
                    <>
                      <span className="font-medium text-support-ink">Web research</span>
                      {` · ${sourceHost(source.url)}`}
                    </>
                  ) : (
                    `QOBO · ${sourceHost(source.url)}`
                  )}
                </span>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          );
        })}
      </ol>
      {hasWeb ? (
        <p className="mt-2 text-[12px] text-muted">Web research comes from outside QOBO and is not QOBO&rsquo;s own information.</p>
      ) : null}
    </div>
  );
}
