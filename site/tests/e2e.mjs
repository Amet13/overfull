#!/usr/bin/env node
/**
 * End-to-end checks for the built site (run `pnpm --filter site build` first).
 *
 *   pnpm --filter site test:e2e
 *
 * Serves dist/ under the base path, then with Playwright (Chromium):
 *  - loads every page at 1280px and 375px, light and dark: no console errors,
 *    no horizontal overflow, axe-core with zero serious/critical violations;
 *  - checks every internal link (and #fragment) resolves;
 *  - runs the browser check with a sample log and a sample .bib, offline;
 *  - drops a project .zip (built here from packages/cli/test/fixtures/project)
 *    and a folder, and checks the main file and .bib are found, a choice is
 *    offered when the main file is ambiguous, and bad zips are explained;
 *  - looks up a DataCite DOI and an arXiv id with the network mocked, so the
 *    Content-Security-Policy must allow the hosts doi.org redirects to;
 *  - reads the profile from overfull.yml in a zip, skips a file over the size
 *    limit, names an empty log, and moves focus to the report on a phone;
 *  - writes screenshots to test-screenshots/ (git-ignored).
 *
 * Env: SITE_BASE (default /overfull), PORT (default 4391), E2E_FULL_AXE=1 to
 * scan every rule page in every variant (default: the main pages only).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, '..');
const shots = join(siteDir, 'test-screenshots');
mkdirSync(shots, { recursive: true });

const rawBase = process.env.SITE_BASE ?? '/overfull';
const base = rawBase === '/' ? '/' : `/${rawBase.replace(/^\/+|\/+$/g, '')}/`;
const port = Number(process.env.PORT ?? 4391);
const origin = `http://127.0.0.1:${port}`;
const root = origin + base;

// A minimal ZIP writer (deflate), so the tests need no binary fixture.
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries, flags = 0) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const raw = Buffer.from(data);
    const body = deflateRawSync(raw);
    const nm = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nm.length, 26);
    parts.push(local, nm, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nm.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nm);
    offset += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
const projectDir = join(here, '..', '..', 'packages', 'cli', 'test', 'fixtures', 'project');
const projectFiles = () =>
  readdirSync(projectDir)
    .filter((f) => statSync(join(projectDir, f)).isFile())
    .map((f) => [`my-paper/${f}`, readFileSync(join(projectDir, f))]);

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
};

// A small static server for dist/, mounted at the base path like GitHub Pages.
const dist = join(siteDir, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ is missing: run `pnpm --filter site build` first.');
  process.exit(2);
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
  const send = (status, file) => {
    try {
      const body = readFileSync(file);
      res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(500).end('dist/ changed while the tests ran');
    }
  };
  if (!path.startsWith(base)) return send(404, join(dist, '404.html'));
  let file = normalize(join(dist, path.slice(base.length)));
  if (!file.startsWith(dist)) return send(404, join(dist, '404.html'));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) return send(404, join(dist, '404.html'));
  send(200, file);
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

let browser;
try {
  // CHROMIUM_PATH: use an installed Chrome/Chromium instead of Playwright's download.
  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );

  // ---- Discover pages ----
  const discover = await browser.newPage();
  await discover.goto(`${root}docs/`);
  const docPages = await discover.$$eval('.docs-nav a', (as) =>
    as.map((a) => new URL(a.href).pathname),
  );
  await discover.goto(`${root}rules/`);
  const rulePages = await discover.$$eval('.rule-list a', (as) =>
    as.map((a) => new URL(a.href).pathname),
  );
  await discover.close();
  const mainPages = [
    base,
    `${base}docs/`,
    `${base}rules/`,
    `${base}check/`,
    `${base}templates/`,
    `${base}does-not-exist/`,
  ];
  const rulesSample = rulePages.slice(0, 3);
  const corpusRule = await (async () => {
    const p = await browser.newPage();
    await p.goto(`${root}rules/`);
    const href = await p.$$eval('.rule-list li', (lis) => {
      const li = lis.find((l) => l.querySelector('.rule-case'));
      return li ? new URL(li.querySelector('a').href).pathname : null;
    });
    await p.close();
    return href;
  })();
  if (corpusRule) rulesSample.push(corpusRule);
  const allPages = [...new Set([...mainPages, ...docPages, ...rulePages])];
  console.log(`Pages: ${allPages.length} (${docPages.length} docs, ${rulePages.length} rules)`);

  const variants = [
    { width: 1280, height: 900, scheme: 'light' },
    { width: 1280, height: 900, scheme: 'dark' },
    { width: 375, height: 812, scheme: 'light' },
    { width: 375, height: 812, scheme: 'dark' },
  ];
  const fullAxe = process.env.E2E_FULL_AXE === '1';
  const links = new Map(); // href -> first page seen on

  // The four viewports run side by side: each gets its own browser context.
  const runVariant = async (v) => {
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: 1,
      colorScheme: v.scheme,
      // Animations end at once, so screenshots need no wait.
      reducedMotion: 'reduce',
    });
    const label = `${v.width}-${v.scheme}`;
    const pages =
      v.width === 1280 && v.scheme === 'light'
        ? allPages
        : [...new Set([...mainPages, ...docPages.slice(0, 4), ...rulesSample])];
    for (const path of pages) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && !(path.includes('does-not-exist') && /404/.test(m.text())))
          errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin + path, { waitUntil: 'load' });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) fail(`${label} ${path}: horizontal overflow ${overflow}px`);
      if (errors.length) fail(`${label} ${path}: console errors: ${errors.join(' | ')}`);
      const isMain =
        mainPages.includes(path) ||
        docPages.slice(0, 4).includes(path) ||
        rulesSample.includes(path);
      if (isMain || fullAxe) {
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
          .analyze();
        const bad = axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical');
        for (const x of bad)
          fail(
            `${label} ${path}: axe ${x.impact} ${x.id}: ${x.nodes
              .slice(0, 3)
              .map((n) => n.target.join(' '))
              .join(', ')}`,
          );
      }
      if (v.width === 1280 && v.scheme === 'light') {
        const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
        for (const h of hrefs) {
          const u = new URL(h);
          if (u.origin === origin && !links.has(h)) links.set(h, path);
        }
      }
      await page.close();
    }
    // Screenshots of the main pages
    for (const [name, path] of [
      ['home', base],
      ['docs', docPages[1] ?? `${base}docs/`],
      ['rules', `${base}rules/`],
      ['rule', corpusRule ?? rulePages[0]],
      ['templates', `${base}templates/`],
    ]) {
      if (!path) continue;
      const page = await ctx.newPage();
      await page.goto(origin + path, { waitUntil: 'load' });
      await page.screenshot({
        path: join(shots, `${name}-${label}.png`),
        fullPage: name !== 'home' || v.width === 375,
      });
      await page.close();
    }
    await ctx.close();
    console.log(`${label}: ${pages.length} pages`);
  };
  await Promise.all(variants.map(runVariant));

  // ---- Links ----
  console.log(`\nLinks: ${links.size} internal`);
  const fetched = new Map();
  for (const [href, from] of links) {
    const u = new URL(href);
    const key = u.origin + u.pathname;
    if (!fetched.has(key)) {
      const r = await fetch(key);
      fetched.set(key, { status: r.status, html: r.ok ? await r.text() : '' });
    }
    const res = fetched.get(key);
    if (res.status !== 200 && !from.includes('does-not-exist'))
      fail(`broken link ${u.pathname}${u.hash} (from ${from}): HTTP ${res.status}`);
    else if (res.status === 200 && u.hash && u.hash.length > 1) {
      const id = decodeURIComponent(u.hash.slice(1));
      if (!res.html.includes(`id="${id}"`))
        fail(`missing anchor ${u.pathname}${u.hash} (from ${from})`);
    }
    if (/\.md(#|$)/.test(u.pathname))
      fail(`unrewritten Markdown link ${u.pathname} (from ${from})`);
  }

  // ---- Theme toggle persists ----
  {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.goto(root);
    await page.click('[data-theme-toggle]');
    await page.goto(`${root}rules/`);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    if (theme !== 'dark') fail(`theme toggle did not persist (got ${theme})`);
    // A toggle keeps its label; only aria-pressed changes.
    const toggle = await page.$eval('[data-theme-toggle]', (b) => [
      b.textContent?.replace(/\s+/g, ' ').trim(),
      b.getAttribute('aria-pressed'),
    ]);
    if (toggle.join('|') !== 'Dark theme|true')
      fail(`theme toggle: label and state are ${toggle.join('|')}`);
    await ctx.close();
  }

  // ---- Home: the hero terminal fits, install is reachable from the hero ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(root);
    const term = await page.$eval('.term-body', (e) => [e.scrollWidth, e.clientWidth]);
    console.log(`\nHero terminal at 1280px: scrollWidth ${term[0]}, clientWidth ${term[1]}`);
    if (term[0] > term[1]) fail(`hero terminal is cut off at 1280px: ${term[0]} > ${term[1]}`);
    if (!(await page.isVisible('.hero-links a[href="#start-title"]')))
      fail('home: no install link in the hero');
    for (const path of ['', 'check/', 'templates/', 'docs/']) {
      await page.goto(root + path);
      const d = await page.$eval('meta[name="description"]', (m) => m.content);
      if (d.length > 155) fail(`${path || 'home'}: meta description is ${d.length} characters`);
    }
    await ctx.close();
  }

  // ---- Wide docs tables scroll with the keyboard (375px) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto(`${root}docs/cli/`);
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    const bad = axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical');
    console.log(`/docs/cli/ at 375px: ${bad.length} serious or critical axe violations`);
    for (const x of bad) fail(`375 /docs/cli/: axe ${x.impact} ${x.id}`);
    const wrapped = await page.$$eval('table', (ts) =>
      ts.every((t) => t.parentElement?.matches('.table-scroll[role="region"][tabindex="0"]')),
    );
    if (!wrapped) fail('/docs/cli/: a table is not in a focusable region');
    await ctx.close();
  }

  // ---- Browser check ----
  console.log('\nBrowser check');
  for (const v of [variants[0], variants[3]]) {
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: 1,
      colorScheme: v.scheme,
    });
    const page = await ctx.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('request', (r) => {
      if (!r.url().startsWith(origin)) external.push(r.url());
    });
    await page.goto(`${root}check/`, { waitUntil: 'networkidle' });
    await page.uncheck('#online');

    if (await page.isVisible('#result-tools'))
      fail('check page: result tools are visible before there is a report');

    await page.click('[data-sample="log-undefined"]');
    await page.waitForSelector('#sheet-view .sheet', { timeout: 15000 });
    const logChecks = await page.$$eval('#sheet-view .sheet-check', (s) => s.length);
    if (logChecks !== 5) fail(`check page: expected 5 checks in the sheet, got ${logChecks}`);
    if (v.width === 375) {
      // On a phone the report is below the inputs: focus moves to it, and it is scrolled
      // into view.
      await page
        .waitForFunction(
          () => (document.activeElement?.getBoundingClientRect().top ?? 999) < innerHeight / 2,
          null,
          { timeout: 3000 },
        )
        .catch(() => {});
      const focus = await page.evaluate(() => {
        const el = document.activeElement;
        return { id: el?.id, top: Math.round(el?.getBoundingClientRect().top ?? -1) };
      });
      console.log(`  375px after a run: focus #${focus.id}, top ${focus.top}px`);
      if (focus.id !== 'result-title' || focus.top < 0 || focus.top >= v.height / 2)
        fail(`check page 375: report heading not focused and in view: ${JSON.stringify(focus)}`);
      await page.screenshot({ path: join(shots, `check-after-run-375-${v.scheme}.png`) });
    }
    const buildStatus = await page.textContent('#sheet-view .sheet-check .sheet-status');
    console.log(`  log sample: build ${buildStatus?.replace('Status: ', '').trim()}`);
    await page.screenshot({
      path: join(shots, `check-log-${v.width}-${v.scheme}.png`),
      fullPage: true,
    });

    await page.click('[data-sample="bib"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#sheet-view .sheet-target')
          ?.textContent?.includes('references.bib'),
      null,
      { timeout: 15000 },
    );
    const refs = await page.textContent('#sheet-view #sheet-references');
    if (!refs) fail('check page: references check missing for the bib sample');
    const refText = await page.textContent(
      '#sheet-view section[aria-labelledby="sheet-references"]',
    );
    if (!/ongaro2014raft/.test(refText ?? ''))
      fail('check page: missing cited key not reported for the bib sample');
    const progress = await page.textContent('#progress');
    if (!/Done/.test(progress ?? '')) fail(`check page: progress not done: ${progress}`);

    await page.click('#agent-toggle');
    const json = await page.textContent('#json-out');
    try {
      const parsed = JSON.parse(json ?? '');
      if (parsed.tool !== 'overfull' || parsed.checks.length !== 5)
        fail('check page: agent JSON has the wrong shape');
    } catch {
      fail('check page: agent JSON does not parse');
    }
    await page.click('#agent-toggle');
    await page.screenshot({
      path: join(shots, `check-bib-${v.width}-${v.scheme}.png`),
      fullPage: true,
    });

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    for (const x of axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical'))
      fail(
        `check page with report (${v.width}-${v.scheme}): axe ${x.impact} ${x.id}: ${x.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' '))
          .join(', ')}`,
      );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 0)
      fail(`check page with report (${v.width}): horizontal overflow ${overflow}px`);
    if (errors.length) fail(`check page: console errors: ${errors.join(' | ')}`);
    if (external.length)
      fail(
        `check page made external requests with verification off: ${external.slice(0, 3).join(', ')}`,
      );

    // Unsupported, unreadable and duplicate PDFs are reported, not dropped silently
    await page.setInputFiles('#file-input', [
      { name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK') },
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot really') },
      { name: 'b.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nnot either') },
    ]);
    await page.waitForFunction(
      () => /readable PDF/.test(document.querySelector('#notice')?.textContent ?? ''),
      null,
      { timeout: 15000 },
    );
    const noticeText = (await page.textContent('#notice')) ?? '';
    if (!/Skipped notes\.docx/.test(noticeText))
      fail(`check page: unsupported file not reported: ${noticeText}`);
    if (!/One PDF at a time; checking the first: a\.pdf/.test(noticeText))
      fail(`check page: second PDF not reported: ${noticeText}`);
    if (!/a\.pdf: This file isn’t a readable PDF \(pdf\.js: /.test(noticeText))
      fail(`check page: unreadable PDF not explained: ${noticeText}`);

    // Keyboard: the drop zone's button is reachable and labelled
    const chooseVisible = await page.isVisible('#choose');
    if (!chooseVisible) fail('check page: "Choose files" button not visible');

    // A project .zip (Overleaf "Download source"): offline, so assert on what
    // needs no network: detection of the files, and that the report renders.
    const waitDone = () =>
      page.waitForFunction(
        () => /Done\./.test(document.querySelector('#progress')?.textContent ?? ''),
        null,
        {
          timeout: 20000,
        },
      );
    await page.evaluate(() => {
      document.querySelector('#progress').textContent = '';
    });
    await page.setInputFiles('#file-input', {
      name: 'my-paper.zip',
      mimeType: 'application/zip',
      buffer: makeZip([
        ...projectFiles(),
        ['my-paper/__MACOSX/._main.tex', 'junk'],
        ['my-paper/.git/config', 'junk'],
        ['my-paper/../escape.tex', 'bad'],
      ]),
    });
    await waitDone();
    const zipNotice = (await page.textContent('#notice')) ?? '';
    if (!/main file main\.tex/.test(zipNotice) || !/1 \.bib file/.test(zipNotice))
      fail(`check page zip: main file or .bib not reported: ${zipNotice}`);
    const listed = (await page.$$eval('#files .name', (n) => n.map((x) => x.textContent))).sort();
    for (const want of ['main.tex', 'references.bib', 'thesis.log', 'thesis.pdf', 'thesis.aux'])
      if (!listed.includes(want)) fail(`check page zip: ${want} not listed (got ${listed})`);
    if (listed.some((n) => /escape|MACOSX|\.git/.test(n ?? '')))
      fail(`check page zip: unsafe or hidden file listed: ${listed}`);
    const zipChecks = await page.$$eval('#sheet-view .sheet-check', (c) => c.length);
    if (zipChecks !== 5) fail(`check page zip: expected 5 checks, got ${zipChecks}`);
    const zipTarget = (await page.textContent('#sheet-view .sheet-target')) ?? '';
    if (!/my-paper\.zip/.test(zipTarget) || !/main\.tex/.test(zipTarget))
      fail(`check page zip: report target is ${zipTarget}`);
    const zipRefs =
      (await page.textContent('#sheet-view section[aria-labelledby="sheet-references"]')) ?? '';
    if (!/ghost2020/.test(zipRefs)) fail('check page zip: missing citation ghost2020 not reported');
    await page.screenshot({
      path: join(shots, `check-zip-${v.width}-${v.scheme}.png`),
      fullPage: true,
    });

    // A file dropped after the zip joins the project
    await page.evaluate(() => {
      document.querySelector('#progress').textContent = '';
    });
    await page.setInputFiles('#file-input', {
      name: 'thesis.pdf',
      mimeType: 'application/pdf',
      buffer: readFileSync(join(projectDir, 'thesis.pdf')),
    });
    await waitDone();
    if (!/my-paper\.zip/.test((await page.textContent('#sheet-view .sheet-target')) ?? ''))
      fail('check page zip: a file added after the zip left the project');

    // The same project as a folder (input with webkitdirectory)
    if (await page.evaluate(() => 'webkitdirectory' in document.querySelector('#folder-input'))) {
      if (!(await page.isVisible('#choose-folder')))
        fail('check page: "Choose a folder" button not visible');
      await page.evaluate(() => {
        document.querySelector('#progress').textContent = '';
      });
      await page.setInputFiles('#folder-input', projectDir);
      await waitDone();
      const folderNotice = (await page.textContent('#notice')) ?? '';
      if (!/main file main\.tex/.test(folderNotice) || !/1 \.bib file/.test(folderNotice))
        fail(`check page folder: main file or .bib not reported: ${folderNotice}`);
    }

    // Several candidate main files: the page asks, and runs after the choice
    await page.evaluate(() => {
      document.querySelector('#progress').textContent = '';
    });
    await page.setInputFiles('#file-input', {
      name: 'two-mains.zip',
      mimeType: 'application/zip',
      buffer: makeZip([
        ['a.tex', '\\documentclass{article}\\begin{document}A\\end{document}'],
        ['b.tex', '\\documentclass{article}\\begin{document}B\\end{document}'],
      ]),
    });
    await page.waitForSelector('#main-pick:not([hidden])', { timeout: 10000 });
    const options = await page.$$eval('#main-select option', (o) => o.map((x) => x.value));
    if (options.join() !== ',a.tex,b.tex')
      fail(`check page zip: main file choices are ${options.join('|')}`);
    await page.selectOption('#main-select', 'b.tex');
    await waitDone();
    const chosenTarget = (await page.textContent('#sheet-view .sheet-target')) ?? '';
    if (!/main file: b\.tex/.test(chosenTarget))
      fail(`check page zip: chosen main file not used: ${chosenTarget}`);

    // Encrypted and non-zip archives are explained
    await page.setInputFiles('#file-input', {
      name: 'locked.zip',
      mimeType: 'application/zip',
      buffer: makeZip([['main.tex', 'x']], 1),
    });
    await page.waitForFunction(
      () => /password-protected/.test(document.querySelector('#notice')?.textContent ?? ''),
      null,
      { timeout: 10000 },
    );
    await page.setInputFiles('#file-input', {
      name: 'broken.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('this is not a zip file at all'),
    });
    await page.waitForFunction(
      () => /not a readable \.zip/.test(document.querySelector('#notice')?.textContent ?? ''),
      null,
      { timeout: 10000 },
    );
    // overfull.yml in a zip sets the profile, as in `overfull check`
    const venueCount = await page.$$eval(
      '#profile optgroup[label="Venues"] option',
      (o) => o.length,
    );
    if (venueCount !== 12) fail(`check page: ${venueCount} venue profiles offered, expected 12`);
    await page.evaluate(() => {
      document.querySelector('#progress').textContent = '';
    });
    await page.setInputFiles('#file-input', {
      name: 'venue-paper.zip',
      mimeType: 'application/zip',
      buffer: makeZip([
        ...projectFiles().filter(([n]) => !n.endsWith('/overfull.yml')),
        ['my-paper/overfull.yml', 'main: main.tex\nprofile: neurips-2026 # the venue\n'],
      ]),
    });
    await waitDone();
    const profile = await page.inputValue('#profile');
    if (profile !== 'neurips-2026') fail(`check page: overfull.yml profile not used (${profile})`);
    if (!(await page.isVisible('#profile-note')))
      fail('check page: "profile from overfull.yml" not shown');

    // Loose files: over the size limit is skipped; an empty log is named, not "0 checks"
    const huge = join(shots, 'huge.pdf');
    writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024, 0x20));
    await page.setInputFiles('#file-input', huge);
    await page.waitForFunction(
      () => /huge\.pdf: too large/.test(document.querySelector('#notice')?.textContent ?? ''),
      null,
      { timeout: 15000 },
    );
    await page.click('#clear');
    await page.setInputFiles('#file-input', {
      name: 'empty.log',
      mimeType: 'text/plain',
      buffer: Buffer.from(''),
    });
    await waitDone();
    const emptyMsg = (await page.textContent('#progress')) ?? '';
    if (!/empty\.log: the file is empty/.test(emptyMsg) || /0 checks/.test(emptyMsg))
      fail(`check page: empty log reported as: ${emptyMsg}`);

    const axeZip = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    for (const x of axeZip.violations.filter(
      (x) => x.impact === 'serious' || x.impact === 'critical',
    ))
      fail(`check page zip (${v.width}-${v.scheme}): axe ${x.impact} ${x.id}`);
    if (external.length)
      fail(`check page zip made external requests: ${external.slice(0, 3).join(', ')}`);
    await ctx.close();
  }

  // ---- References online, network mocked: DataCite DOIs and arXiv ids ----
  // doi.org redirects a DataCite DOI (Zenodo, figshare, software, arXiv's 10.48550)
  // to data.crosscite.org; the page's CSP must allow it, or the lookup fails.
  {
    console.log('\nDataCite lookups (mocked)');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const csl = (doi, title) => ({
      DOI: doi,
      type: 'article',
      title,
      author: [{ given: 'Ada', family: 'Lovelace' }],
      issued: { 'date-parts': [[2020]] },
    });
    const records = {
      '10.5281/zenodo.4242424': csl('10.5281/zenodo.4242424', 'A Dataset of Proof Sheets'),
      '10.48550/arxiv.2001.01234': csl('10.48550/arXiv.2001.01234', 'Learning to Typeset'),
    };
    // Playwright's page.route does not see the request a redirect leads to, so the
    // lookups are answered through the DevTools Fetch domain, which does; the CSP is
    // enforced on the redirect as in a real browser.
    const asked = [];
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Fetch.enable', {
      patterns: ['doi.org', 'data.crosscite.org', 'api.crossref.org', 'api.openalex.org'].map(
        (h) => ({ urlPattern: `https://${h}/*` }),
      ),
    });
    cdp.on('Fetch.requestPaused', async (e) => {
      const u = new URL(e.request.url);
      const reply = (status, headers = {}, body) =>
        cdp.send('Fetch.fulfillRequest', {
          requestId: e.requestId,
          responseCode: status,
          responseHeaders: Object.entries({
            'access-control-allow-origin': '*',
            'content-type': 'application/json',
            ...headers,
          }).map(([name, value]) => ({ name, value })),
          ...(body === undefined
            ? {}
            : { body: Buffer.from(JSON.stringify(body)).toString('base64') }),
        });
      if (u.hostname === 'doi.org') {
        const doi = decodeURIComponent(u.pathname.slice(1)).toLowerCase();
        asked.push(`doi.org ${doi}`);
        if (!records[doi]) return reply(404, {}, {});
        return reply(302, {
          location: `https://data.crosscite.org/application/vnd.citationstyles.csl+json/${doi}`,
        });
      }
      if (u.hostname === 'data.crosscite.org') {
        const doi = decodeURIComponent(u.pathname.split('/').slice(3).join('/')).toLowerCase();
        asked.push(`data.crosscite.org ${doi}`);
        return reply(records[doi] ? 200 : 404, {}, records[doi] ?? {});
      }
      asked.push(u.hostname);
      return reply(
        200,
        {},
        u.hostname === 'api.crossref.org' ? { message: { items: [] } } : { results: [] },
      );
    });
    await page.goto(`${root}check/`, { waitUntil: 'networkidle' });
    const csp = await page.$eval('meta[http-equiv="content-security-policy"]', (m) => m.content);
    for (const host of ['https://data.crosscite.org', 'https://api.datacite.org'])
      if (!csp.includes(host)) fail(`CSP connect-src does not allow ${host}`);
    for (const host of ['export.arxiv.org', 'dblp.org'])
      if (csp.includes(host)) fail(`CSP still allows ${host}, which the page never calls`);
    await page.setInputFiles('#file-input', {
      name: 'datacite.bib',
      mimeType: 'text/plain',
      buffer:
        Buffer.from(`@misc{zenodo, author = {Lovelace, Ada}, title = {A Dataset of Proof Sheets},
  year = {2020}, doi = {10.5281/zenodo.4242424}}
@misc{arxiv, author = {Lovelace, Ada}, title = {Learning to Typeset}, year = {2020},
  eprint = {2001.01234}, archiveprefix = {arXiv}}`),
    });
    await page.waitForFunction(
      () => /Done\./.test(document.querySelector('#progress')?.textContent ?? ''),
      null,
      { timeout: 20000 },
    );
    const refs =
      (await page.textContent('#sheet-view section[aria-labelledby="sheet-references"]')) ?? '';
    const status = await page.getAttribute(
      '#sheet-view section[aria-labelledby="sheet-references"]',
      'class',
    );
    console.log(`  references: ${status}; asked ${[...new Set(asked)].join(', ')}`);
    if (!/st-pass/.test(status ?? ''))
      fail(`DataCite lookups: references not verified (${status}): ${refs.slice(0, 300)}`);
    if (!asked.some((a) => a.startsWith('data.crosscite.org 10.48550/')))
      fail('DataCite lookups: the arXiv id was not resolved through doi.org');
    const blocked = errors.filter((e) => /Content Security Policy|Refused to connect/i.test(e));
    if (blocked.length) fail(`DataCite lookups: CSP blocked: ${blocked[0]}`);
    await ctx.close();
  }
} catch (err) {
  fail(`harness error: ${err?.stack ?? err}`);
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll e2e checks passed.');
process.exit(failures.length ? 1 : 0);
