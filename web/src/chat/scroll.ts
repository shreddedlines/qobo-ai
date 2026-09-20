/**
 * Following a reply as it is written, without taking the page away from someone who
 * scrolled up to re-read something.
 *
 * The page itself scrolls — there is no inner scroll container — so this measures the
 * window against the document.
 */

/**
 * How close to the bottom still counts as following along. Generous enough to absorb
 * sub-pixel rounding and a line of text arriving, small enough that a deliberate
 * scroll away from the bottom is respected.
 */
export const FOLLOW_THRESHOLD_PX = 120;

export interface ViewportPosition {
  /** How far the page is scrolled from the top. */
  scrollTop: number;
  /** Height of the visible area. */
  viewportHeight: number;
  /** Full scrollable height of the content. */
  contentHeight: number;
}

/**
 * True when the bottom of the page is in reach — either already visible, or near
 * enough that the person is plainly still reading the newest text.
 *
 * Content shorter than the viewport has nothing to scroll, which counts as following.
 */
export function isFollowingBottom({ scrollTop, viewportHeight, contentHeight }: ViewportPosition, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return contentHeight - (scrollTop + viewportHeight) <= threshold;
}

/** The page's scroll position, or null where there is no document (tests, SSR). */
export function readViewportPosition(): ViewportPosition | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return { scrollTop: window.scrollY, viewportHeight: window.innerHeight, contentHeight: document.documentElement.scrollHeight };
}
