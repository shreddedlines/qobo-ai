import type { ConversationSummary } from '../api/types.ts';

export type GroupKey = 'today' | 'yesterday' | 'earlier';

export interface ConversationGroup {
  key: GroupKey;
  label: string;
  conversations: ConversationSummary[];
}

const GROUP_LABELS: Record<GroupKey, string> = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' };

/** Whole days between two instants, counted by local calendar date rather than by hours. */
function calendarDaysAgo(value: Date, now: Date): number {
  const startOfValue = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((startOfNow.getTime() - startOfValue.getTime()) / 86_400_000);
}

function groupKeyFor(isoTimestamp: string, now: Date): GroupKey {
  const value = new Date(isoTimestamp);
  if (Number.isNaN(value.getTime())) return 'earlier';
  const days = calendarDaysAgo(value, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return 'earlier';
}

/**
 * Groups conversations into Today, Yesterday and Earlier by local calendar day, using
 * the last activity rather than when the chat was started — someone returning to an old
 * conversation expects to find it at the top under Today.
 *
 * Empty groups are left out, and each group stays newest-first.
 */
export function groupConversations(conversations: readonly ConversationSummary[], now: Date = new Date()): ConversationGroup[] {
  const buckets: Record<GroupKey, ConversationSummary[]> = { today: [], yesterday: [], earlier: [] };

  for (const conversation of conversations) {
    buckets[groupKeyFor(conversation.updatedAt, now)].push(conversation);
  }

  return (['today', 'yesterday', 'earlier'] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({
      key,
      label: GROUP_LABELS[key],
      conversations: [...buckets[key]].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)),
    }));
}

export const TITLE_MAX_CHARS = 42;
export const UNTITLED_CONVERSATION = 'New conversation';

/**
 * The title shown in the sidebar. The API already derives it from the first user
 * message; this collapses whitespace and cuts it at a word boundary so a long question
 * stays readable in a narrow column instead of being clipped mid-word.
 */
export function displayTitle(title: string | null | undefined, maxChars: number = TITLE_MAX_CHARS): string {
  const collapsed = (title ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed === '') return UNTITLED_CONVERSATION;
  if (collapsed.length <= maxChars) return collapsed;

  const cut = collapsed.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break on a space if enough of the title survives; otherwise cut mid-word.
  const kept = lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

/** When a conversation was last used: a time today, "Yesterday", or a short date. */
export function conversationTimeLabel(isoTimestamp: string, now: Date = new Date(), locale?: string): string {
  const value = new Date(isoTimestamp);
  if (Number.isNaN(value.getTime())) return '';

  const days = calendarDaysAgo(value, now);
  if (days <= 0) return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(value);
  if (days === 1) return 'Yesterday';
  const sameYear = value.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(value);
}
