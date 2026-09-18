export interface LogoProps {
  /** Rendered pixel size of the square mark. */
  size?: number;
  /** Hide the "QOBO Support" wordmark (e.g. in a narrow header). */
  markOnly?: boolean;
}

/** Served from public/ so the same file backs the favicon and the in-app mark. */
const MARK_URL = '/brand/qobo-mark-192.png';

/**
 * QOBO's official mark (qobo.dev/qobo-logo.png, resized) plus a text wordmark.
 * The brand has no official wordmark asset, so "QOBO Support" is set in Poppins —
 * the display face used on qobo.dev.
 */
export function Logo({ size = 32, markOnly = false }: LogoProps) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img src={MARK_URL} alt="QOBO" width={size} height={size} className="shrink-0 object-contain" />
      {!markOnly && (
        <span className="font-display text-[15px] leading-none font-semibold tracking-tight whitespace-nowrap text-ink">
          QOBO <span className="text-muted">Support</span>
        </span>
      )}
    </span>
  );
}
