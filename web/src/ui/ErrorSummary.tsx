import type { Ref } from 'react';

export interface ErrorSummaryItem {
  /** Input id to link to; omitted for problems that belong to the whole form. */
  fieldId?: string;
  message: string;
}

export interface ErrorSummaryProps {
  items: ErrorSummaryItem[];
  ref?: Ref<HTMLDivElement>;
}

/**
 * Error summary for a failed submit. It receives focus, so keyboard and screen reader
 * users hear the problem immediately, and each item links to its field. Inline field
 * errors stay in place — this complements them rather than replacing them.
 */
export function ErrorSummary({ items, ref }: ErrorSummaryProps) {
  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      aria-labelledby="error-summary-title"
      className="rounded-md border border-danger bg-danger-tint p-4"
    >
      <h2 id="error-summary-title" className="text-[15px] font-semibold text-danger">
        {items.length === 1 ? 'There is a problem' : `There are ${items.length} problems`}
      </h2>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.message} className="text-[14px] text-danger">
            {item.fieldId ? (
              <a href={`#${item.fieldId}`} className="font-medium underline underline-offset-2">
                {item.message}
              </a>
            ) : (
              item.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
