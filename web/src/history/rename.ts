/** Renaming a conversation: what counts as a usable title. */

/** Matches the column's own limit, so the API can never be the first to say no. */
export const MAX_TITLE_CHARS = 120;

/**
 * The title as it would be saved, or null when there is nothing to save.
 *
 * Whitespace is trimmed because the database counts it as content: a title of three
 * spaces passes its length check, so the emptiness rule lives here and on the server.
 */
export function normalizeTitle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_TITLE_CHARS) return null;
  return trimmed;
}

/** Why a title cannot be saved, for the person editing it. */
export function titleProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return 'Enter a name for this chat.';
  if (trimmed.length > MAX_TITLE_CHARS) return `Use ${MAX_TITLE_CHARS} characters or fewer.`;
  return null;
}

/** True when saving would change nothing, so the request can be skipped. */
export function isUnchanged(raw: string, current: string): boolean {
  return normalizeTitle(raw) === current;
}
