import type { InputHTMLAttributes } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-invalid'> {
  id: string;
  label: string;
  /** Persistent helper text (e.g. password rules), read out with the input. */
  description?: string;
  error?: string | undefined;
}

/**
 * Labelled input with helper text and an inline error. The label is always visible
 * (never a placeholder standing in for one) and the error sits next to the field it
 * belongs to, not only in the summary.
 */
export function Field({ id, label, description, error, className = '', ...rest }: FieldProps) {
  const describedBy = [description ? `${id}-description` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-medium text-ink">
        {label}
      </label>
      {description && (
        <p id={`${id}-description`} className="text-[13px] text-muted">
          {description}
        </p>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`min-h-11 rounded-md border bg-surface px-3.5 text-[15px] text-ink placeholder:text-muted disabled:opacity-60 ${
          error ? 'border-danger' : 'border-line'
        } ${className}`}
        {...rest}
      />
      {error && (
        <p id={`${id}-error`} className="text-[13px] font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
