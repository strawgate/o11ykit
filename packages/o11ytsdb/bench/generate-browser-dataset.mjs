import { chromium } from '@playwright/test';
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const outFile = join(dataDir, 'browser-telemetry.jsonl');
writeFileSync(outFile, ''); // Clear file before starting

async function main() {
  console.log('Launching browser to generate live telemetry dataset...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to an interesting site
  await page.goto('https://en.wikipedia.org/wiki/Time_series');

  await page.evaluate(() => {
    window.__scraperState = {
      mouseX: 0, mouseY: 0,
      clicks: 0, keypresses: 0,
      scrollX: 0, scrollY: 0
    };
    window.addEventListener('mousemove', e => {
      window.__scraperState.mouseX = e.clientX;
      window.__scraperState.mouseY = e.clientY;
    });
    window.addEventListener('click', () => window.__scraperState.clicks++);
    window.addEventListener('keydown', () => window.__scraperState.keypresses++);
    window.addEventListener('scroll', () => {
      window.__scraperState.scrollX = window.scrollX;
      window.__scraperState.scrollY = window.scrollY;
    });
  });

  const durationSec = 10; // Generate 10 seconds of telemetry for immediate results
  const intervalMs = 100; // Scrape 10 times a second for high-res time series
  console.log(`Scraping browser metrics every ${intervalMs}ms for ${durationSec}s...`);

  for (let i = 0; i < (durationSec * 1000) / intervalMs; i++) {
    // Simulate user interaction
    if (i % 5 === 0) {
      await page.mouse.move(Math.random() * 800, Math.random() * 600);
      await page.mouse.wheel(0, (Math.random() - 0.5) * 600);
    }

    try {
      const state = await page.evaluate(() => {
      const now = Date.now();
      const mem = (performance && performance.memory) || { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0 };
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const resCount = performance.getEntriesByType('resource').length;
      return {
        now,
        state: window.__scraperState,
        memory: {
          used: mem.usedJSHeapSize,
          total: mem.totalJSHeapSize,
          limit: mem.jsHeapSizeLimit
        },
        network: {
          online: navigator.onLine ? 1 : 0,
          downlink: navigator.connection ? navigator.connection.downlink : 0
        },
        resources: resCount,
        nav: {
          load: nav.loadEventEnd || 0,
          dom: nav.domContentLoadedEventEnd || 0
        },
        env: {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          width: window.innerWidth,
          height: window.innerHeight
        }
      };
    });

    const timeUnixNano = (BigInt(Math.floor(state.now)) * 1_000_000n).toString();

    function makePoint(value, attrs) {
      return {
        timeUnixNano,
        asDouble: value,
        attributes: Object.entries(attrs).map(([key, val]) => ({
          key, value: { stringValue: String(val) }
        }))
      };
    }

    const metrics = [
      { name: "browser.mouse.pos", gauge: { dataPoints: [
        makePoint(state.state.mouseX, { axis: "x" }),
        makePoint(state.state.mouseY, { axis: "y" })
      ] } },
      { name: "browser.scroll.offset", gauge: { dataPoints: [
        makePoint(state.state.scrollX, { axis: "x" }),
        makePoint(state.state.scrollY, { axis: "y" })
      ] } },
      { name: "browser.interaction.clicks", gauge: { dataPoints: [
        makePoint(state.state.clicks, {})
      ] } },
      { name: "browser.interaction.keypresses", gauge: { dataPoints: [
        makePoint(state.state.keypresses, {})
      ] } },
      { name: "browser.memory.heap", gauge: { dataPoints: [
        makePoint(state.memory.used, { state: "used" }),
        makePoint(state.memory.total, { state: "total" }),
        makePoint(state.memory.limit, { state: "limit" })
      ] } },
      { name: "browser.network.online", gauge: { dataPoints: [
        makePoint(state.network.online, {})
      ] } },
      { name: "browser.network.downlink", gauge: { dataPoints: [
        makePoint(state.network.downlink, {})
      ] } },
      { name: "browser.resource.count", gauge: { dataPoints: [
        makePoint(state.resources, {})
      ] } },
      { name: "browser.window.size", gauge: { dataPoints: [
        makePoint(state.env.width, { dim: "width" }),
        makePoint(state.env.height, { dim: "height" })
      ] } },
    ];

    if (state.nav.load > 0) {
      metrics.push({ name: "browser.navigation.load_time", gauge: { dataPoints: [
        makePoint(state.nav.load, { type: "load" }),
        makePoint(state.nav.dom, { type: "dom_content_loaded" })
      ] } });
    }

    const doc = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "live-browser-dataset" } },
            { key: "browser.platform", value: { stringValue: state.env.platform } },
            { key: "browser.user_agent", value: { stringValue: state.env.userAgent } }
          ]
        },
        scopeMetrics: [{
          scope: { name: "browser.scraper", version: "1.0.0" },
          metrics
        }]
      }]
    };

    appendFileSync(outFile, JSON.stringify(doc) + '\n');
    } catch (e) {
      console.warn("Failed to scrape this tick:", e.message);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  console.log(`Dataset generated at ${outFile}`);
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});