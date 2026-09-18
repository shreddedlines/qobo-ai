import type { AuthFailure } from './errors.ts';
import { toSummaryItems, type AuthField, type FieldErrors } from './validation.ts';

export interface SummaryInput {
  fieldErrors: FieldErrors;
  formFailure: AuthFailure | null;
  /** True only after a submit has failed; a blur alone must not open the summary. */
  showSummary: boolean;
}

export interface SummaryEntry {
  /** Absent for a problem that belongs to the whole form rather than one input. */
  field?: AuthField;
  message: string;
}

/**
 * Builds the error-summary contents. Kept pure because the rule that matters is a
 * timing rule: showing the summary while someone is still filling the form moves the
 * submit button out from under their pointer, so it may only open after a failed submit.
 */
export function buildSummaryItems({ fieldErrors, formFailure, showSummary }: SummaryInput): SummaryEntry[] {
  if (!showSummary) return [];

  const items: SummaryEntry[] = toSummaryItems(fieldErrors).map((item) => ({ field: item.field, message: item.message }));
  // A failure with a field is already listed inline and above; only form-level ones are added.
  if (formFailure && !formFailure.field) items.push({ message: formFailure.message });
  return items;
}
