/**
 * Crawls qobo.dev with a real browser and writes reviewable Markdown snapshots.
 *
 *   npm run ingest:crawl
 *
 * Output: kb/snapshots/*.md and kb/snapshots/manifest.json. Exits with code 1 when
 * the manifest lists issues (e.g. unreviewed prices) that must be resolved before
 * the knowledge base is built.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assemblePages } from './lib/assemble.ts';
import { capturePage, createCrawlContext, launchBrowser, type RawPage } from './lib/browser.ts';
import { loadIngestConfig, pageRuleFor } from './lib/config.ts';
import { parseSnapshot, renderSnapshot } from './lib/snapshot.ts';
import { parseSitemapLocations, toSitePath } from './lib/urls.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const kbDir = path.join(repoRoot, 'kb');
const snapshotsDir = path.join(kbDir, 'snapshots');
const manifestPath = path.join(snapshotsDir, 'manifest.json');

async function main(): Promise<void> {
  const config = await loadIngestConfig(path.join(kbDir, 'ingest.config.yaml'));
  const excluded = config.excludePathPatterns.map((pattern) => new RegExp(pattern));
  const isExcluded = (sitePath: string) => excluded.some((pattern) => pattern.test(sitePath));

  const sitemapResponse = await fetch(config.sitemap);
  if (!sitemapResponse.ok) throw new Error(`Sitemap request failed with HTTP ${sitemapResponse.status}`);
  const sitemapPaths = parseSitemapLocations(await sitemapResponse.text())
    .map((loc) => toSitePath(loc, config.site))
    .filter((p): p is string => p !== null);

  const queue = [...new Set([...sitemapPaths, ...config.extraPaths])].filter((p) => !isExcluded(p));
  const visited = new Set<string>();
  const captured = new Map<string, RawPage>();
  const redirects: Array<{ from: string; to: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const browser = await launchBrowser();
  console.log(`Browser: ${browser.version()} | ${queue.length} seed paths (${sitemapPaths.length} from sitemap)`);

  try {
    const context = await createCrawlContext(browser);
    while (queue.length > 0 && visited.size < config.maxPages) {
      const requestedPath = queue.shift()!;
      if (visited.has(requestedPath)) continue;
      visited.add(requestedPath);

      const raw = await captureWithRetry(() =>
        capturePage(context, config.site, requestedPath, pageRuleFor(config, requestedPath), config.navigationTimeoutMs),
      ).catch((error: Error) => {
        skipped.push({ path: requestedPath, reason: `capture failed: ${error.message.split('\n')[0]}` });
        return null;
      });

      if (raw) {
        if (raw.notFound) {
          skipped.push({ path: requestedPath, reason: 'renders the site 404 page' });
        } else if (raw.finalPath !== requestedPath) {
          // Client-side redirect: capture the target directly, with its own page rules.
          redirects.push({ from: requestedPath, to: raw.finalPath });
          if (!visited.has(raw.finalPath) && !queue.includes(raw.finalPath)) queue.unshift(raw.finalPath);
        } else {
          captured.set(raw.finalPath, raw);
          for (const href of raw.hrefs) {
            const linked = toSitePath(href, config.site);
            if (linked && !visited.has(linked) && !queue.includes(linked) && !isExcluded(linked)) queue.push(linked);
          }
        }
        console.log(`  ${raw.notFound ? '404 ' : 'ok  '} ${requestedPath}${raw.finalPath !== requestedPath ? ` → ${raw.finalPath}` : ''}`);
      } else {
        console.log(`  FAIL ${requestedPath}`);
      }

      await new Promise((resolve) => setTimeout(resolve, config.requestDelayMs));
    }
    await context.close();
  } finally {
    await browser.close();
  }

  const previous = await readPreviousSnapshots();
  const crawledAt = new Date().toISOString();
  const result = assemblePages(config, [...captured.values()], previous.bodyLengths, crawledAt);

  await mkdir(snapshotsDir, { recursive: true });
  const newFiles = new Set(result.pages.map((page) => page.file));
  const removedFiles = previous.files.filter((file) => !newFiles.has(file));
  for (const file of removedFiles) await rm(path.join(snapshotsDir, file));
  for (const page of result.pages) await writeFile(path.join(snapshotsDir, page.file), renderSnapshot(page.snapshot), 'utf8');

  const manifest = {
    site: config.site,
    crawledAt,
    browser: browser.version(),
    pages: result.pages
      .map((page) => ({
        path: page.snapshot.meta.path,
        file: page.file,
        type: page.snapshot.meta.page_type,
        title: page.snapshot.meta.title,
        chars: page.snapshot.body.length,
        contentHash: page.snapshot.meta.content_hash,
        prices: page.prices,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    redirects,
    skipped,
    removedSnapshots: removedFiles,
    boilerplateRemoved: result.boilerplateRemoved,
    issues: result.issues,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`\nSnapshots: ${result.pages.length} | redirects: ${redirects.length} | skipped: ${skipped.length} | removed: ${removedFiles.length}`);
  for (const entry of skipped) console.log(`  skipped ${entry.path}: ${entry.reason}`);
  if (result.issues.length > 0) {
    console.log(`\n${result.issues.length} issue(s) need review before building the knowledge base:`);
    for (const issue of result.issues) console.log(`  [${issue.kind}] ${issue.path}: ${issue.message}`);
    process.exitCode = 1;
  } else {
    console.log('\nNo issues. Review the snapshot diff, then build the knowledge base.');
  }
}

async function captureWithRetry(run: () => Promise<RawPage>): Promise<RawPage> {
  try {
    return await run();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return run();
  }
}

async function readPreviousSnapshots(): Promise<{ files: string[]; bodyLengths: Map<string, number> }> {
  const bodyLengths = new Map<string, number>();
  let files: string[] = [];
  try {
    files = (await readdir(snapshotsDir)).filter((file) => file.endsWith('.md'));
  } catch {
    return { files, bodyLengths };
  }
  for (const file of files) {
    const snapshot = parseSnapshot(await readFile(path.join(snapshotsDir, file), 'utf8'), file);
    bodyLengths.set(snapshot.meta.path, snapshot.body.length);
  }
  return { files, bodyLengths };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
