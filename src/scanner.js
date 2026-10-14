const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const uiAudit = require('./audit-browser');
const uiaPreload = require('./preload-browser');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const DEFAULT_VIEWPORTS = [
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900, mobile: false },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024, mobile: true },
  { id: 'mobile', label: 'Mobile', width: 390, height: 844, mobile: true },
];

function findChrome(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  const home = os.homedir();
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Arc.app/Contents/MacOS/Arc',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    win32: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'],
  };
  return (candidates[process.platform] || []).find((p) => p && fs.existsSync(p)) || null;
}

function fingerprint(issue) {
  // Deliberately without viewport: the same issue on desktop + mobile becomes one issue
  return crypto
    .createHash('sha1')
    .update([issue.rule, issue.selector || '', issue.title, issue.selector ? '' : (issue.detail || '').split('\n')[0]].join('|'))
    .digest('hex')
    .slice(0, 12);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autoScroll(page) {
  // Scroll through the page so lazy-loaded content and animations load
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight && y < 30000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await sleep(250);
}

async function checkLinks(links, pageOrigin, opts, log) {
  const unique = new Map();
  for (const l of links) if (!unique.has(l.url)) unique.set(l.url, l);
  const list = [...unique.values()].filter((l) => opts.checkExternalLinks || new URL(l.url).origin === pageOrigin).slice(0, opts.maxLinks || 80);
  const results = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const l = list[i++];
      let status = 0, error = null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        let res = await fetch(l.url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
        if (res.status === 405 || res.status === 403 || res.status === 501) res = await fetch(l.url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
        clearTimeout(t);
        status = res.status;
      } catch (e) {
        error = e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message;
      }
      if (status >= 400 || error) results.push({ ...l, status, error });
    }
  }
  log && log(`Checking links (${list.length})…`);
  await Promise.all(Array.from({ length: 8 }, worker));
  return results;
}

async function clickTest(page, buttons, viewport, log) {
  // Clicks buttons we're not sure do anything, and checks whether something changes.
  // The list of risky words includes Dutch terms so Dutch sites are covered too.
  const out = [];
  const risky = /(verwijder|delete|remove|betaal|pay|bestel|order|koop|buy|checkout|afrekenen|uitloggen|logout|sign out|annuleer abonnement|unsubscribe|send|verstuur|verzend)/i;
  const targets = buttons.filter((b) => b.state !== 'direct' && b.state !== 'ancestor' && !risky.test(b.text)).slice(0, 25);
  if (!targets.length) return out;
  log && log(`Click test on ${targets.length} buttons (${viewport.label})…`);
  const startUrl = page.url();
  for (const b of targets) {
    try {
      const before = await page.evaluate((id) => {
        window.__uiaMut = 0;
        window.__uiaObs && window.__uiaObs.disconnect();
        window.__uiaObs = new MutationObserver((m) => (window.__uiaMut += m.length));
        window.__uiaObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const el = document.querySelector(`[data-uia-btn="${id}"]`);
        return { exists: !!el, url: location.href, scroll: window.scrollY };
      }, b.id);
      if (!before.exists) continue;
      let requests = 0;
      const onReq = () => requests++;
      page.on('request', onReq);
      const navP = page.waitForNavigation({ timeout: 1200 }).then(() => true).catch(() => false);
      await page.click(`[data-uia-btn="${b.id}"]`, { delay: 20 }).catch(() => {});
      const navigated = await navP;
      page.off('request', onReq);
      let after = { mut: 0, url: page.url(), scroll: 0 };
      if (!navigated) after = await page.evaluate(() => ({ mut: window.__uiaMut || 0, url: location.href, scroll: window.scrollY })).catch(() => after);
      const didSomething = navigated || requests > 0 || after.mut > 0 || after.url !== before.url || Math.abs(after.scroll - before.scroll) > 5;
      out.push({ ...b, didSomething, effect: { navigated, requests, mutations: after.mut } });
      if (navigated || page.url() !== startUrl) {
        await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        // set the data-uia-btn attributes again
        await page.evaluate(uiAudit, { isMobile: viewport.mobile, spacingBase: 4 }).catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch (e) {
      /* next button */
    }
  }
  return out;
}

/**
 * Scans one URL across multiple viewports.
 * @returns {Promise<{issues: any[], screenshots: Record<string,string>, meta: any}>}
 */
async function scan(url, options = {}) {
  const log = options.log || (() => {});
  const viewports = (options.viewports && options.viewports.length ? options.viewports : DEFAULT_VIEWPORTS).map((v) => ({ ...v }));
  const outDir = options.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-'));
  fs.mkdirSync(outDir, { recursive: true });
  const executablePath = findChrome(options.chromePath);
  if (!executablePath) {
    throw new Error('No Chrome, Edge or Chromium found. Install Chrome or set "uiAudit.chromePath".');
  }
  log('Starting browser…');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions', '--mute-audio'],
    defaultViewport: null,
  });

  const allIssues = [];
  const screenshots = {};
  const metas = {};
  const backendSeen = new Set();
  let allLinks = [];
  let pageOrigin = null;

  try {
    for (const vp of viewports) {
      if (options.isCancelled && options.isCancelled()) break;
      log(`Loading ${vp.label} (${vp.width}px)…`);
      const page = await browser.newPage();
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
      if (vp.mobile && vp.width < 600) await page.setUserAgent(MOBILE_UA);
      await page.evaluateOnNewDocument(uiaPreload);

      const backend = [];
      const reqStart = new Map();
      page.on('console', (msg) => {
        if (msg.type() === 'error' && /^Failed to load resource/.test(msg.text())) return; // already reported via the network listener
        if (msg.type() === 'error') backend.push({ kind: 'console', text: msg.text(), location: msg.location() });
        else if (msg.type() === 'warning' && /deprecat|hydration|key prop|unique "key"|failed prop type/i.test(msg.text())) backend.push({ kind: 'console-warn', text: msg.text(), location: msg.location() });
      });
      page.on('pageerror', (err) => backend.push({ kind: 'exception', text: err.message, stack: (err.stack || '').split('\n').slice(0, 4).join('\n') }));
      page.on('request', (req) => reqStart.set(req, Date.now()));
      const TRACKERS = /(google-analytics|googletagmanager|doubleclick|hotjar|facebook\.net|clarity\.ms|segment\.(io|com)|sentry\.io|plausible|vercel-insights|vitals\.vercel|_vercel\/insights|linkedin\.com\/px|tiktok|cookiebot|intercom)/i;
      page.on('requestfailed', (req) => {
        const f = req.failure();
        if (TRACKERS.test(req.url())) return;
        if (f && /ERR_ABORTED/.test(f.errorText)) return; // cancelled by navigation/prefetch, usually harmless
        backend.push({ kind: 'request-failed', text: `${req.method()} ${req.url()} → ${f ? f.errorText : 'failed'}`, url: req.url(), type: req.resourceType() });
      });
      page.on('response', (res) => {
        const req = res.request();
        const ms = Date.now() - (reqStart.get(req) || Date.now());
        if (res.status() >= 400) backend.push({ kind: 'http', status: res.status(), text: `${req.method()} ${res.url()} → HTTP ${res.status()}`, url: res.url(), type: req.resourceType() });
        else if (ms > 3000 && /xhr|fetch|document/.test(req.resourceType())) backend.push({ kind: 'slow', text: `${req.method()} ${res.url()} took ${(ms / 1000).toFixed(1)}s`, url: res.url(), ms });
      });

      let response;
      try {
        response = await page.goto(url, { waitUntil: 'networkidle2', timeout: options.timeout || 30000 });
      } catch (e) {
        if (/timeout/i.test(e.message)) {
          backend.push({ kind: 'slow', text: `Page still had network traffic after ${(options.timeout || 30000) / 1000}s (networkidle not reached)` });
        } else {
          await page.close();
          throw new Error(`Cannot open ${url}: ${e.message}. Is your dev server running?`);
        }
      }
      if (response && response.status() >= 400) backend.push({ kind: 'http', status: response.status(), text: `The page itself returns HTTP ${response.status()}`, url });
      pageOrigin = pageOrigin || new URL(page.url()).origin;

      await autoScroll(page);
      await sleep(options.settleMs || 400);

      log(`${vp.label}: analyzing…`);
      const result = await page.evaluate(uiAudit, { isMobile: !!vp.mobile, spacingBase: options.spacingBase || 4 });

      // screenshot (full page, capped at 12000px to keep files small)
      // Layout width can differ from the device width (e.g. 980px without a viewport meta)
      const layoutW = Math.max(vp.width, result.meta.viewport.w || vp.width);
      vp.shotWidth = layoutW;
      const docH = Math.min(result.meta.docHeight, 12000);
      const shotPath = path.join(outDir, `${vp.id}.jpg`);
      try {
        await page.screenshot({ path: shotPath, type: 'jpeg', quality: 72, clip: { x: 0, y: 0, width: layoutW, height: docH }, captureBeyondViewport: true });
        screenshots[vp.id] = shotPath;
      } catch (e) {
        log('Screenshot failed: ' + e.message);
      }

      // Crops per issue (with a red marker) — handy for Claude Code and the mail to the developer
      const withRect = result.issues.filter((i) => i.rect && i.rect.w > 0 && i.rect.h > 0).slice(0, options.maxCrops || 60);
      for (const [n, i] of withRect.entries()) {
        try {
          const pad = 32;
          const x = Math.max(0, i.rect.x - pad), y = Math.max(0, i.rect.y - pad);
          const w = Math.min(layoutW - x, i.rect.w + pad * 2, 1200), h = Math.min(i.rect.h + pad * 2, 700);
          if (w < 4 || h < 4) continue;
          await page.evaluate((r) => {
            const d = document.createElement('div');
            d.id = '__uia_mark';
            Object.assign(d.style, { position: 'absolute', left: r.x - 3 + 'px', top: r.y - 3 + 'px', width: r.w + 6 + 'px', height: r.h + 6 + 'px', border: '2px solid #ff2d55', borderRadius: '3px', boxShadow: '0 0 0 9999px rgba(0,0,0,.08)', zIndex: 2147483647, pointerEvents: 'none' });
            document.body.appendChild(d);
          }, i.rect);
          const crop = path.join(outDir, `crop-${vp.id}-${n}.jpg`);
          await page.screenshot({ path: crop, type: 'jpeg', quality: 80, clip: { x, y, width: w, height: h }, captureBeyondViewport: true });
          i.crop = crop;
        } catch (e) {
          /* no crop */
        } finally {
          await page.evaluate(() => document.getElementById('__uia_mark')?.remove()).catch(() => {});
        }
      }

      if (options.clickTest) {
        const ct = await clickTest(page, result.buttons, vp, log);
        for (const b of ct) {
          if (b.didSomething && b.state === 'none') {
            // The click did do something → not a dead button (remove the false positive)
            result.issues = result.issues.filter((i) => !(i.rule === 'dead-button' && i.selector === b.selector));
          } else if (!b.didSomething && b.state !== 'none') {
            result.issues.push({
              rule: 'click-noop', category: 'functional', severity: 'error',
              title: `Button "${b.text || '(no text)'}" does not respond to clicks`,
              detail: 'After a real click nothing changed: no navigation, no network request and no change to the page.',
              suggestion: 'Check that the click handler is actually attached and does not throw an error (see console errors).',
              selector: b.selector, html: b.html, rect: b.rect, hints: b.hints,
            });
          }
        }
      }

      for (const i of result.issues) {
        i.viewport = vp.id;
        i.id = fingerprint(i);
        allIssues.push(i);
      }
      allLinks = allLinks.concat(result.links);
      metas[vp.id] = result.meta;

      // Backend/console errors: report each unique text only once
      for (const b of backend) {
        const key = b.kind + '|' + b.text;
        if (backendSeen.has(key)) continue;
        backendSeen.add(key);
        const sev = /favicon\.ico/.test(b.url || '') ? 'info' : b.kind === 'slow' || b.kind === 'console-warn' ? 'warning' : 'error';
        const titles = {
          console: 'JavaScript error in the console',
          'console-warn': 'Warning in the console',
          exception: 'Uncaught JavaScript exception',
          'request-failed': 'Network request failed',
          http: `Server returned HTTP ${b.status}`,
          slow: 'Slow response',
        };
        const issue = {
          rule: 'backend-' + b.kind, category: 'backend', severity: sev,
          title: titles[b.kind] + (b.type ? ` (${b.type})` : ''),
          detail: b.text + (b.stack ? '\n' + b.stack : '') + (b.location && b.location.url ? `\n@ ${b.location.url}:${b.location.lineNumber || 0}` : ''),
          suggestion: b.kind === 'http' && b.status >= 500 ? 'Check the server logs for this endpoint; the backend crashes or returns an error.' :
            b.kind === 'http' && b.status === 404 ? 'The file/endpoint does not exist. Check the path or the route.' :
            b.kind === 'http' && (b.status === 401 || b.status === 403) ? 'Authorization failed. Check tokens/cookies/CORS.' :
            b.kind === 'slow' ? 'Optimize the query/endpoint or add caching/loading states.' :
            'Open the DevTools console on this page and fix the error; it often breaks buttons or data too.',
          selector: null, html: null, rect: null, hints: null, viewport: vp.id,
        };
        issue.id = fingerprint(issue);
        allIssues.push(issue);
      }
      await page.close();
    }

    if (options.checkLinks !== false && allLinks.length && !(options.isCancelled && options.isCancelled())) {
      const broken = await checkLinks(allLinks, pageOrigin, options, log);
      for (const l of broken) {
        const issue = {
          rule: 'broken-link', category: 'functional', severity: 'error',
          title: l.error ? `Link unreachable (${l.error})` : `Link returns HTTP ${l.status}`,
          detail: `"${l.text}" → ${l.url}`,
          suggestion: l.status === 404 ? 'The page does not exist (anymore). Update the link or create the page/route.' : 'Check that the target URL is correct and the server is reachable.',
          selector: l.selector, html: l.html, rect: l.rect, hints: l.hints, viewport: viewports[0].id,
        };
        issue.id = fingerprint(issue);
        allIssues.push(issue);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Merge the same issue across multiple viewports into one issue
  const byId = new Map();
  for (const i of allIssues) {
    const ex = byId.get(i.id);
    if (!ex) {
      i.viewports = [i.viewport];
      i.rects = i.rect ? { [i.viewport]: i.rect } : {};
      i.crops = i.crop ? { [i.viewport]: i.crop } : {};
      byId.set(i.id, i);
    } else if (!ex.viewports.includes(i.viewport)) {
      ex.viewports.push(i.viewport);
      if (i.rect) ex.rects[i.viewport] = i.rect;
      if (i.crop) ex.crops[i.viewport] = i.crop;
      const rank = { error: 0, warning: 1, info: 2 };
      if (rank[i.severity] < rank[ex.severity]) ex.severity = i.severity;
    }
  }
  const issues = [...byId.values()];
  for (const i of issues) { delete i.viewport; delete i.crop; delete i.rect; }
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.rect ? a.rect.y : 0) - (b.rect ? b.rect.y : 0));
  return { issues, screenshots, meta: metas, url, scannedAt: new Date().toISOString(), viewports };
}

module.exports = { scan, findChrome, DEFAULT_VIEWPORTS };
