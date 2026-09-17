/// <reference lib="dom" />
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { mergeCaptures, normalizeLines, type HeadingInfo } from './clean.ts';
import type { PageRule } from './config.ts';

export interface ExclusionResult {
  reason: string;
  matched: number;
  /** Largest share of the page text covered by a matched element. */
  maxShare: number;
  applied: boolean;
}

export interface RawPage {
  requestedPath: string;
  finalPath: string;
  notFound: boolean;
  documentTitle: string;
  lines: string[];
  headings: HeadingInfo[];
  hrefs: string[];
  exclusions: ExclusionResult[];
}

interface Capture {
  lines: string[];
  headings: HeadingInfo[];
  hrefs: string[];
}

/** An exclusion may hide at most this share of the page; broader matches mean a stale rule. */
const MAX_EXCLUSION_SHARE = 0.4;

/**
 * Uses an installed, signed browser by default on Windows (Edge), because
 * application-control policies can block Playwright's downloaded Chromium.
 */
export async function launchBrowser(channel = process.env.INGEST_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium')): Promise<Browser> {
  return chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true });
}

export async function createCrawlContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'en-IN',
    serviceWorkers: 'block',
    userAgent: `${await defaultUserAgent(browser)} QoboSupportKnowledgeBase/1.0`,
  });
  // Text extraction does not need heavy assets.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
  });
  return context;
}

async function defaultUserAgent(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => navigator.userAgent.replace('HeadlessChrome', 'Chrome'));
  } finally {
    await page.close();
  }
}

export async function capturePage(context: BrowserContext, site: string, requestedPath: string, rule: PageRule, timeoutMs: number): Promise<RawPage> {
  const page = await context.newPage();
  page.on('popup', (popup) => void popup.close());

  try {
    await page.goto(new URL(requestedPath, site).href, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForFunction(() => ((document.querySelector('main') ?? document.body).innerText.trim().length > 40), null, {
      timeout: timeoutMs,
    });
    // Client-side redirects and entry animations settle shortly after first render.
    await page.waitForTimeout(1500);

    const finalPath = new URL(page.url()).pathname.replace(/(.)\/+$/, '$1');
    const documentTitle = await page.title();
    const notFound = await page.evaluate(
      () => document.querySelector('h1')?.textContent?.trim() === '404' || /ROUTE NOT FOUND/i.test(document.body.innerText),
    );
    if (notFound) {
      return { requestedPath, finalPath, notFound, documentTitle, lines: [], headings: [], hrefs: [], exclusions: [] };
    }

    await scrollThrough(page);

    // Animated widgets can appear after the first pass, so exclusions are re-applied
    // before every capture and their results aggregated.
    const exclusionPasses: ExclusionResult[][] = [];
    const captures: Capture[] = [];
    const excludeAndCapture = async () => {
      exclusionPasses.push(await applyExclusions(page, rule));
      captures.push(await capture(page));
    };

    await excludeAndCapture();

    if (rule.expandQuestions) {
      // FAQ toggles render as "Is there a free trial? | 03", so match a "?" anywhere.
      const questions = page.locator('main button').filter({ hasText: /\?/ });
      const count = await questions.count();
      for (let i = 0; i < count; i++) {
        await questions.nth(i).click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        await excludeAndCapture();
      }
    }

    for (const text of rule.clickTexts) {
      const target = page.locator('main').getByText(text, { exact: true }).first();
      await target.click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      await excludeAndCapture();
    }

    const sampleUntil = Date.now() + rule.sampleMs;
    while (Date.now() < sampleUntil) {
      await page.waitForTimeout(1_500);
      await excludeAndCapture();
    }

    const pathAfterInteractions = new URL(page.url()).pathname.replace(/(.)\/+$/, '$1');
    if (pathAfterInteractions !== finalPath) {
      throw new Error(`Interaction navigated away from ${finalPath} to ${pathAfterInteractions}; adjust the page rule`);
    }

    return {
      requestedPath,
      finalPath,
      notFound: false,
      documentTitle,
      lines: mergeCaptures(captures.map((c) => normalizeLines(c.lines))),
      headings: uniqueHeadings(captures.flatMap((c) => c.headings)),
      hrefs: [...new Set(captures.flatMap((c) => c.hrefs))],
      exclusions: aggregateExclusions(exclusionPasses),
    };
  } finally {
    await page.close();
  }
}

async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
}

function capture(page: Page): Promise<Capture> {
  return page.evaluate(() => {
    const root = document.querySelector('main') ?? document.body;
    const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3')]
      .filter((heading) => heading.getClientRects().length > 0)
      .map((heading) => ({ level: Number(heading.tagName[1]) as 1 | 2 | 3, parts: heading.innerText.split('\n') }));
    const hrefs = [...document.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href') ?? '').filter(Boolean);
    return { lines: root.innerText.split('\n'), headings, hrefs };
  });
}

/**
 * Hides every minimal element that contains all of a rule's phrases (marquees
 * repeat mock-ups, so there can be several). Attributes survive React re-renders
 * of text, and rules are re-applied before each capture.
 */
function applyExclusions(page: Page, rule: PageRule): Promise<ExclusionResult[]> {
  if (rule.exclude.length === 0) return Promise.resolve([]);
  return page.evaluate(
    ({ rules, maxShare }) => {
      const root = document.querySelector('main') ?? document.body;
      if (!document.getElementById('kb-exclude-style')) {
        const style = document.createElement('style');
        style.id = 'kb-exclude-style';
        style.textContent = '[data-kb-excluded] { display: none !important; }';
        document.head.append(style);
      }
      const rootLength = Math.max(1, root.textContent?.length ?? 1);
      // Snapshot text comes from innerText (CSS text-transform applied); the DOM may differ in case and spacing.
      const normalize = (value: string) => value.replace(/\s+/g, ' ').toLowerCase();

      return rules.map((exclusion) => {
        const phrases = exclusion.containsAll.map(normalize);
        const containsAll = (element: Element) => {
          const text = normalize(element.textContent ?? '');
          return phrases.every((phrase) => text.includes(phrase));
        };
        const matches = [...root.querySelectorAll('*')].filter(containsAll);
        const minimal = matches.filter((element) => !matches.some((other) => other !== element && element.contains(other)));
        const largestShare = Math.max(0, ...minimal.map((element) => (element.textContent?.length ?? 0) / rootLength));
        const applied = minimal.length > 0 && largestShare <= maxShare;
        if (applied) minimal.forEach((element) => element.setAttribute('data-kb-excluded', exclusion.reason));
        return { reason: exclusion.reason, matched: minimal.length, maxShare: largestShare, applied };
      });
    },
    { rules: rule.exclude, maxShare: MAX_EXCLUSION_SHARE },
  );
}

export function aggregateExclusions(passes: ExclusionResult[][]): ExclusionResult[] {
  const [first, ...rest] = passes;
  if (!first) return [];
  return first.map((initial, index) =>
    rest.reduce(
      (acc, pass) => {
        const result = pass[index]!;
        return {
          reason: acc.reason,
          matched: Math.max(acc.matched, result.matched),
          maxShare: Math.max(acc.maxShare, result.maxShare),
          applied: acc.applied || result.applied,
        };
      },
      { ...initial },
    ),
  );
}

function uniqueHeadings(headings: HeadingInfo[]): HeadingInfo[] {
  const seen = new Map<string, HeadingInfo>();
  for (const heading of headings) {
    const key = `${heading.level}:${heading.parts.map((part) => part.trim()).join(' ')}`;
    if (!seen.has(key)) seen.set(key, heading);
  }
  return [...seen.values()];
}
