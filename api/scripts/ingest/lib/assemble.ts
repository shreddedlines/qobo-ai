import type { RawPage } from './browser.ts';
import { applyHeadings, findBoilerplate, findPrices, normalizeLines, toContactLink, type ContactLink } from './clean.ts';
import { pageRuleFor, pageTypeFor, type IngestConfig } from './config.ts';
import { contentHash, type Snapshot } from './snapshot.ts';
import { snapshotSlug } from './urls.ts';

export type IssueKind =
  | 'unreviewed_price'
  | 'exclusion_unmatched'
  | 'exclusion_too_broad'
  | 'excluded_content_leaked'
  | 'content_shrunk'
  | 'too_little_content';

export interface Issue {
  path: string;
  kind: IssueKind;
  message: string;
}

export interface AssembledPage {
  snapshot: Snapshot;
  file: string;
  prices: string[];
}

export interface AssembleResult {
  pages: AssembledPage[];
  boilerplateRemoved: string[];
  issues: Issue[];
}

const MIN_CONTENT_CHARS = 150;
const CONTACT_LABELS: Record<ContactLink['kind'], string> = { whatsapp: 'WhatsApp', phone: 'Phone call', email: 'Email' };

/**
 * Turns raw browser captures into reviewable snapshots and flags anything that
 * needs a human decision before the knowledge base can be built.
 */
export function assemblePages(
  config: IngestConfig,
  rawPages: RawPage[],
  previousBodyLengths: Map<string, number>,
  crawledAt: string,
): AssembleResult {
  const issues: Issue[] = [];
  const normalized = rawPages.map((page) => ({ page, lines: normalizeLines(page.lines) }));
  const boilerplate = findBoilerplate(
    normalized.map((entry) => entry.lines),
    config.boilerplate,
  );

  const pages = normalized.map(({ page, lines }): AssembledPage => {
    const path = page.finalPath;
    const rule = pageRuleFor(config, path);

    page.exclusions.forEach((exclusion, index) => {
      const optional = rule.exclude[index]?.optional ?? false;
      if (exclusion.matched === 0 && !optional) {
        issues.push({ path, kind: 'exclusion_unmatched', message: `Exclusion "${exclusion.reason}" matched nothing; the page changed or the rule is stale` });
      } else if (exclusion.matched > 0 && !exclusion.applied) {
        issues.push({
          path,
          kind: 'exclusion_too_broad',
          message: `Exclusion "${exclusion.reason}" would hide ${Math.round(exclusion.maxShare * 100)}% of the page; not applied`,
        });
      }
    });

    const contentLines = applyHeadings(
      lines.filter((line) => !boilerplate.has(line)),
      page.headings,
    );
    const contacts = uniqueContacts(page.hrefs);
    const bodyParts = [renderLines(contentLines)];
    if (contacts.length > 0) {
      bodyParts.push(['## Contact details linked on this page', ...contacts.map((c) => `- ${CONTACT_LABELS[c.kind]}: ${c.value} (${c.href})`)].join('\n'));
    }
    const body = bodyParts.join('\n\n');

    const firstH1 = page.headings.find((heading) => heading.level === 1);
    const title = rule.title ?? (firstH1 ? firstH1.parts.map((part) => part.trim()).filter(Boolean).join(' ') : page.documentTitle);

    // Deterministic backstop for rotating widgets: excluded demo content must not survive.
    const normalizedBody = body.replace(/\s+/g, ' ').toLowerCase();
    for (const exclusion of rule.exclude) {
      if (exclusion.containsAll.every((phrase) => normalizedBody.includes(phrase.replace(/\s+/g, ' ').toLowerCase()))) {
        issues.push({ path, kind: 'excluded_content_leaked', message: `Content matching exclusion "${exclusion.reason}" is still in the snapshot` });
      }
    }

    const prices = findPrices(body);
    for (const price of prices) {
      const allowed = config.prices.some((rule) => rule.value === price && (rule.pages.includes('*') || rule.pages.includes(path)));
      if (!allowed) {
        issues.push({ path, kind: 'unreviewed_price', message: `Price ${price} is not in the reviewed price allowlist for this page` });
      }
    }

    if (body.length < MIN_CONTENT_CHARS) {
      issues.push({ path, kind: 'too_little_content', message: `Only ${body.length} characters extracted; rendering may have failed` });
    }
    const previousLength = previousBodyLengths.get(path);
    if (previousLength !== undefined && body.length < previousLength * config.shrinkThreshold) {
      issues.push({ path, kind: 'content_shrunk', message: `Content shrank from ${previousLength} to ${body.length} characters` });
    }

    return {
      file: `${snapshotSlug(path)}.md`,
      prices,
      snapshot: {
        meta: {
          url: new URL(path, config.site).href,
          path,
          title,
          page_type: pageTypeFor(config, path),
          content_hash: contentHash(body),
          crawled_at: crawledAt,
        },
        body,
      },
    };
  });

  return { pages, boilerplateRemoved: [...boilerplate].sort(), issues };
}

function uniqueContacts(hrefs: string[]): ContactLink[] {
  const byHref = new Map<string, ContactLink>();
  for (const href of hrefs) {
    const contact = toContactLink(href);
    if (contact && !byHref.has(contact.href)) byHref.set(contact.href, contact);
  }
  const order: ContactLink['kind'][] = ['whatsapp', 'phone', 'email'];
  return [...byHref.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.value.localeCompare(b.value));
}

/** Blank line before headings; text lines stay one per line. */
function renderLines(lines: string[]): string {
  return lines
    .map((line, index) => (line.startsWith('#') && index > 0 ? `\n${line}` : line))
    .join('\n')
    .trim();
}
