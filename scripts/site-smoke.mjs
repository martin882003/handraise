import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SITE_ROOT = join(ROOT, 'site');
const CHROME_CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
]);

function createStaticServer() {
  return createServer((request, response) => {
    const requestPath = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const filePath = normalize(join(SITE_ROOT, relativePath));
    if (!filePath.startsWith(`${SITE_ROOT}/`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': MIME.get(extname(filePath)) || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  });
}

function launchChrome(binary, profile) {
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--metrics-recording-only', '--no-first-run',
    '--no-proxy-server', '--hide-scrollbars', `--user-data-dir=${profile}`, '--remote-debugging-pipe',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const input = child.stdio[3];
  const output = child.stdio[4];
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let sessionId;
  const pending = new Map();
  const exceptions = [];

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    for (let boundary = buffer.indexOf('\0'); boundary >= 0; boundary = buffer.indexOf('\0')) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params?.exceptionDetails?.text || 'Runtime exception');
        continue;
      }
      const waiting = pending.get(message.id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result || {});
    }
  });

  const send = (method, params = {}, targetSession = sessionId) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`Chrome protocol timed out at ${method}: ${stderr.slice(-800)}`));
    }, 12_000);
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    input.write(`${JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })}\0`);
  });

  const ensurePage = async () => {
    if (sessionId) return;
    const target = await send('Target.createTarget', { url: 'about:blank' }, null);
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null);
    sessionId = attached.sessionId;
    await send('Page.enable');
    await send('Runtime.enable');
  };

  return {
    exceptions,
    async setViewport(width, height, mobile = false) {
      await ensurePage();
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    },
    async setReducedMotion(enabled) {
      await ensurePage();
      await send('Emulation.setEmulatedMedia', {
        media: '', features: [{ name: 'prefers-reduced-motion', value: enabled ? 'reduce' : 'no-preference' }],
      });
    },
    async navigate(url) {
      await ensurePage();
      await send('Page.navigate', { url });
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const ready = await this.evaluate('document.readyState === "complete" && Boolean(document.querySelector("main"))');
        if (ready) {
          await this.evaluate('new Promise((resolve) => setTimeout(resolve, 850))');
          return;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      }
      throw new Error(`Page did not become ready: ${url}`);
    },
    async evaluate(expression) {
      await ensurePage();
      const evaluated = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || 'Browser evaluation failed');
      return evaluated.result?.value;
    },
    async screenshot(path) {
      await ensurePage();
      const captured = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      writeFileSync(path, Buffer.from(captured.data, 'base64'));
    },
    async close() {
      try { await send('Browser.close', {}, null); } catch { child.kill('SIGTERM'); }
      await Promise.race([
        new Promise((resolvePromise) => child.once('close', resolvePromise)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

const chromeBinary = CHROME_CANDIDATES.find(existsSync);
assert.ok(chromeBinary, 'A Chrome/Chromium binary is required for the launch-site smoke test.');
assert.ok(existsSync(join(SITE_ROOT, 'index.html')), 'site/index.html is missing.');

const server = createStaticServer();
const profile = mkdtempSync(join(tmpdir(), 'handraise-site-chrome-'));
let browser;

try {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = launchChrome(chromeBinary, profile);

  await browser.setViewport(1440, 1000);
  await browser.setReducedMotion(false);
  await browser.navigate(origin);
  const desktop = await browser.evaluate(`(() => ({
    title: document.title,
    h1: document.querySelector('h1')?.innerText,
    overflow: document.documentElement.scrollWidth - innerWidth,
    canvas: Boolean(document.querySelector('[data-particle-field]')?.width),
    visibleHero: getComputedStyle(document.querySelector('.hero-copy')).opacity,
    overflowSources: [...document.querySelectorAll('body *')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: String(element.className || ''), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter((rect) => rect.left < -1 || rect.right > innerWidth + 1).slice(0, 12),
    brokenAnchors: [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href')).filter((href) => !document.querySelector(href)),
    productHuntLinks: [...document.querySelectorAll('[data-product-hunt]')].map((a) => a.href),
    socialImage: new URL(document.querySelector('meta[property="og:image"]')?.content || '', location.href).href,
  }))()`);
  assert.match(desktop.title, /Handraise/);
  assert.match(desktop.h1, /Understand the system/);
  assert.ok(desktop.overflow <= 1, `Desktop horizontal overflow: ${desktop.overflow}px from ${JSON.stringify(desktop.overflowSources)}`);
  assert.equal(desktop.canvas, true);
  assert.ok(Number(desktop.visibleHero) > 0.99, `Hero should be visible, got opacity ${desktop.visibleHero}`);
  assert.deepEqual(desktop.brokenAnchors, []);
  assert.ok(desktop.productHuntLinks.every((href) => href === 'https://www.producthunt.com/posts/handraise'));
  assert.equal(desktop.socialImage, 'https://handraise.pages.dev/assets/handraise-social.png');
  await browser.screenshot('/tmp/handraise-site-desktop.png');

  await browser.evaluate(`document.querySelector('#principle').scrollIntoView(); new Promise((resolve) => setTimeout(resolve, 1_350))`);
  const kineticVisible = await browser.evaluate(`getComputedStyle(document.querySelector('.kinetic-message')).opacity`);
  assert.ok(Number(kineticVisible) > 0.99, `Kinetic chapter should remain visible after a direct scroll, got ${kineticVisible}.`);
  await browser.screenshot('/tmp/handraise-site-kinetic.png');

  await browser.evaluate(`document.querySelector('#workflow').scrollIntoView(); new Promise((resolve) => setTimeout(resolve, 850))`);
  await browser.evaluate(`document.querySelector('[data-demo-tab="design"]').click(); new Promise((resolve) => setTimeout(resolve, 650))`);
  const tabs = await browser.evaluate(`(() => ({
    selected: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.demoTab,
    designHidden: document.querySelector('[data-demo-panel="design"]').hidden,
    headingOpacity: getComputedStyle(document.querySelector('#workflow .section-heading')).opacity,
  }))()`);
  assert.equal(tabs.selected, 'design');
  assert.equal(tabs.designHidden, false);
  assert.ok(Number(tabs.headingOpacity) > 0.99, `Workflow heading should be visible, got ${tabs.headingOpacity}`);
  await browser.screenshot('/tmp/handraise-site-workflow.png');

  await browser.evaluate(`document.querySelector('[data-demo-tab="design"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  assert.equal(await browser.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.demoTab`), 'run');

  await browser.evaluate(`document.querySelector('#safety').scrollIntoView(); new Promise((resolve) => setTimeout(resolve, 850))`);
  await browser.screenshot('/tmp/handraise-site-safety.png');

  await browser.evaluate(`document.querySelector('#install').scrollIntoView(); new Promise((resolve) => setTimeout(resolve, 700))`);
  await browser.screenshot('/tmp/handraise-site-install.png');
  await browser.evaluate(`document.querySelector('[data-copy-install]').click(); new Promise((resolve) => setTimeout(resolve, 80))`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-copy-install] span')?.textContent`), 'Copied');

  await browser.setViewport(390, 844, false);
  await browser.navigate(origin);
  const mobile = await browser.evaluate(`(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    h1Right: document.querySelector('h1').getBoundingClientRect().right,
    viewport: innerWidth,
    productVisible: document.querySelector('.hero-product').getBoundingClientRect().height > 300,
    overflowSources: [...document.querySelectorAll('body *')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: String(element.className || ''), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter((rect) => rect.left < -1 || rect.right > innerWidth + 1).slice(0, 16),
  }))()`);
  assert.ok(mobile.overflow <= 1, `Mobile horizontal overflow: ${mobile.overflow}px from ${JSON.stringify(mobile.overflowSources)}`);
  assert.ok(mobile.h1Right <= mobile.viewport + 1, `Mobile headline exceeds viewport: ${JSON.stringify(mobile)}`);
  assert.equal(mobile.productVisible, true);
  await browser.screenshot('/tmp/handraise-site-mobile.png');
  await browser.evaluate(`document.querySelector('[data-nav-toggle]').click()`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-nav-toggle]').getAttribute('aria-expanded')`), 'true');
  assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('[data-nav-links]')).display`), 'flex');
  await browser.screenshot('/tmp/handraise-site-mobile-menu.png');
  await browser.evaluate(`document.querySelector('[data-nav-links] a[href="#workflow"]').click(); new Promise((resolve) => setTimeout(resolve, 850))`);
  assert.equal(await browser.evaluate(`document.querySelector('[data-nav-toggle]').getAttribute('aria-expanded')`), 'false');
  await browser.screenshot('/tmp/handraise-site-mobile-workflow.png');

  await browser.evaluate(`document.querySelector('#principle').scrollIntoView(); new Promise((resolve) => setTimeout(resolve, 1_350))`);
  await browser.screenshot('/tmp/handraise-site-mobile-kinetic.png');

  await browser.evaluate(`document.querySelector('#install').scrollIntoView(); new Promise((resolve) => setTimeout(resolve, 1_500))`);
  assert.ok(Number(await browser.evaluate(`getComputedStyle(document.querySelector('.install-card')).opacity`)) > 0.99, 'Mobile install card should be fully visible.');
  await browser.screenshot('/tmp/handraise-site-mobile-install.png');

  await browser.setViewport(320, 780, false);
  await browser.navigate(`${origin}/?narrow=1`);
  const narrow = await browser.evaluate(`(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    headerRight: document.querySelector('.nav-actions').getBoundingClientRect().right,
    viewport: innerWidth,
    overflowSources: [...document.querySelectorAll('body *')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: String(element.className || ''), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter((rect) => rect.left < -1 || rect.right > innerWidth + 1).slice(0, 20),
  }))()`);
  assert.ok(narrow.overflow <= 1, `Narrow mobile horizontal overflow: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.headerRight <= narrow.viewport + 1, `Narrow mobile header exceeds viewport: ${JSON.stringify(narrow)}`);

  await browser.setViewport(390, 844, false);
  await browser.setReducedMotion(true);
  await browser.navigate(`${origin}/?reduced=1#workflow`);
  const reduced = await browser.evaluate(`(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    headingOpacity: getComputedStyle(document.querySelector('#workflow .section-heading')).opacity,
    revealTransform: getComputedStyle(document.querySelector('#workflow .section-heading')).transform,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }))()`);
  assert.deepEqual(reduced, { reduced: true, headingOpacity: '1', revealTransform: 'none', overflow: 0 });
  await browser.screenshot('/tmp/handraise-site-mobile-reduced.png');

  assert.deepEqual(browser.exceptions, [], `Browser runtime exceptions: ${browser.exceptions.join('; ')}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    desktop,
    mobile,
    narrow,
    reduced,
    screenshots: [
      '/tmp/handraise-site-desktop.png', '/tmp/handraise-site-kinetic.png',
      '/tmp/handraise-site-workflow.png', '/tmp/handraise-site-safety.png', '/tmp/handraise-site-install.png',
      '/tmp/handraise-site-mobile.png',
      '/tmp/handraise-site-mobile-menu.png', '/tmp/handraise-site-mobile-workflow.png',
      '/tmp/handraise-site-mobile-kinetic.png', '/tmp/handraise-site-mobile-install.png',
      '/tmp/handraise-site-mobile-reduced.png',
    ],
  }, null, 2)}\n`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(profile, { recursive: true, force: true });
}
