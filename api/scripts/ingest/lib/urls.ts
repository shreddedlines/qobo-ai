const NON_PAGE_EXTENSION = /\.(xml|txt|json|png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|mp4|webm)$/i;

/**
 * Converts an absolute or relative URL into a canonical same-site path
 * (no query/hash, no trailing slash). Returns null for other origins and assets.
 */
export function toSitePath(href: string, site: string): string | null {
  let url: URL;
  try {
    url = new URL(href, site);
  } catch {
    return null;
  }
  if (url.origin !== new URL(site).origin) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  let path = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  if (NON_PAGE_EXTENSION.test(path)) return null;
  return path || '/';
}

export function parseSitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) =>
    match[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
}

/** Stable snapshot file name for a path: "/" → "home", "/plans" → "plans". */
export function snapshotSlug(path: string): string {
  if (path === '/') return 'home';
  return path
    .replace(/^\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
