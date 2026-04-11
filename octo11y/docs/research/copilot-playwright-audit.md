# Copilot + Playwright Audit: benchkit Demo Site

**Audited URL:** https://strawgate.github.io/octo11y/  
**Audit Date:** 2026-04-02  
**Playwright Version:** 1.59.1  
**Browser:** Chromium (headless-shell 147.0.7727.15)

---

## 1. How Copilot Used Playwright

### Approach

Copilot used Playwright's Node.js API (ESM, `playwright` package) in headless Chromium mode to:

1. **Crawl the site** — starting from the root URL and following same-origin links to discover all reachable pages.
2. **Capture screenshots** — at full-page height for each page and at three viewport widths (1280 px, 768 px, 375 px).
3. **Intercept network traffic** — logging all HTTP responses and `requestfailed` events to identify broken assets.
4. **Collect console output** — listening for `page.on('console')` events to surface JavaScript errors and warnings.
5. **Inspect the DOM** — via `page.evaluate()` to extract structural, semantic, and accessibility-relevant information without needing a separate audit tool.
6. **Simulate user interaction** — clicking each metric tab button (Overview, allocs/op, bytes/op, ns/op) and screenshotting the resulting state.

### Key Playwright APIs Used

| API | Purpose |
|-----|---------|
| `chromium.launch({ headless: true })` | Launch a headless browser |
| `browser.newContext({ viewport })` | Create isolated contexts per viewport size |
| `page.goto(url, { waitUntil: 'networkidle' })` | Navigate and wait for all network activity to settle |
| `page.waitForTimeout(ms)` | Allow client-side JavaScript (Preact) to finish rendering |
| `page.screenshot({ fullPage: true })` | Capture full-page screenshots |
| `page.evaluate(() => { … })` | Execute JavaScript in the page context to inspect the DOM |
| `page.on('console', cb)` | Capture browser console messages |
| `page.on('requestfailed', cb)` | Detect failed network requests |
| `page.on('response', cb)` | Monitor HTTP response status codes |
| `page.getByRole('button', { name })` | Find buttons by accessible name for interaction |

### Scripts Used

Two scripts were written (executed ad-hoc, not committed to the repository):

**`audit.mjs`** — Breadth-first crawl of the site, capturing per-page data and screenshots.

**`deep-audit.mjs`** — Detailed single-page inspection covering:
- Responsive layout at three viewport widths
- Button/tab interaction states
- Computed color contrast ratios via `window.getComputedStyle`
- DOM structure (headings, landmarks, ARIA attributes, tables)
- Full network request log

Both scripts used:

```javascript
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await context.newPage();
await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000); // let Preact hydrate
```

---

## 2. Pages Visited

The demo site is a **single-page application (SPA)** with client-side tab switching. Playwright discovered one distinct URL at the base route. No hash-routed sub-pages or separate HTML files were found.

| URL | HTTP Status | Title |
|-----|------------|-------|
| `https://strawgate.github.io/octo11y/` | 301 → 200 | Benchkit · Self-Benchmarks |

> **Note:** The GitHub Pages URL issues a 301 redirect to `https://strawgate.com/octo11y/`. All subsequent asset requests are served from `strawgate.com`. This is expected for a repository with a custom domain configured.

### Tab States Screenshotted

Although there is only one URL, four distinct dashboard states were captured by clicking the metric tab buttons:

| Tab | Charts Rendered |
|-----|----------------|
| Overview | 9 (one per series) |
| allocs/op | 21 (expanded metric view) |
| bytes/op | 21 |
| ns/op | 21 |

---

## 3. Findings

### 3.1 Infrastructure & Network

| Finding | Severity | Detail |
|---------|----------|--------|
| 301 redirect on entry | ✅ Info | `strawgate.github.io/octo11y/` redirects to `strawgate.com/octo11y/`. Normal for a custom domain. |
| Zero failed requests | ✅ Pass | All 8 network requests returned HTTP 200. CSS, JS, and four JSON data files all loaded successfully. |
| Zero console errors | ✅ Pass | No JavaScript errors or warnings were emitted during page load or tab interactions. |
| Data from `raw.githubusercontent.com` | ✅ Info | Chart data is fetched live from the `bench-data` branch via GitHub's raw CDN. No backend required. |

### 3.2 Layout & Responsive Design

| Finding | Severity | Detail |
|---------|----------|--------|
| No horizontal overflow | ✅ Pass | At all three tested widths (1280 px, 768 px, 375 px), `document.body.scrollWidth` did not exceed `window.innerWidth`. |
| Charts resize correctly | ✅ Pass | The three trend charts (allocs/op, bytes/op, ns/op) render and resize across breakpoints. |
| Header is minimal but functional | ✅ Pass | The dark header shows the app name and subtitle at all viewports. |

### 3.3 Accessibility

The most significant findings are in the accessibility category.

#### Critical

| Finding | WCAG Criterion | Detail |
|---------|---------------|--------|
| **No `<h1>` element** | 1.3.1 Info and Relationships | The visible page title "Benchkit" is a `<span>` inside `<header>` — not a heading element. The first real heading in the DOM is `<h2>Performance overview</h2>`, creating a gap in the heading hierarchy. Screen reader users and SEO crawlers cannot identify the top-level page title semantically. |
| **Metric tabs lack tab role and `aria-selected`** | 4.1.2 Name, Role, Value | The three filter buttons (allocs/op, bytes/op, ns/op) and the Overview button use `class="bk-tab"` / `class="bk-link-button"` but have no `role="tab"`, no `role="tablist"` wrapper, and no `aria-selected` attribute. Screen readers cannot determine which tab is active or navigate with the standard tab-key pattern. |
| **No `<nav>` landmark for tab bar** | 1.3.6 Identify Purpose | The metric tab buttons are not wrapped in a `<nav>` or `role="tablist"` container. Keyboard-only and assistive technology users cannot jump to the navigation/filtering controls using landmark shortcuts. |

#### Serious

| Finding | WCAG Criterion | Detail |
|---------|---------------|--------|
| **No skip-navigation link** | 2.4.1 Bypass Blocks | There is no "skip to main content" link at the top of the page. Keyboard-only users must tab through all interactive header/tab elements before reaching the chart content on every page load. |
| **`<section>` elements not labelled** | 1.3.1 Info and Relationships | Four `<section>` elements exist; three have a visible heading but none have `aria-label` or `aria-labelledby`. One section (the tab/filter bar section) has no heading at all, making it impossible for screen readers to identify its purpose. |
| **Run table missing `<caption>` and `scope`** | 1.3.1 Info and Relationships | The "Recent runs" `<table>` has header cells (`<th>`) but no `<caption>` or `aria-label` to name the table, and no `scope="col"` attributes on the header cells. Screen readers may not associate headers with data cells correctly. |

#### Moderate

| Finding | WCAG Criterion | Detail |
|---------|---------------|--------|
| **Muted text contrast borderline** | 1.4.3 Contrast (Minimum) | Several `rgb(100, 116, 139)` muted-text elements (label spans like "METRICS", "RUNS", "SERIES", "MONITOR", the subtitle "BENCHKIT DASHBOARD", and the latest-run paragraph) measured **4.41:1** contrast ratio against a transparent background — just below the 4.5:1 AA threshold for small text. The actual contrast depends on the parent background; against the `#f8fafc` card background these elements appear on, the ratio drops further. |
| **`procs` filter chip lacks context** | 2.4.6 Headings and Labels | The chip button showing `"4"` has `aria-label="procs: 4"` (good), but there is no visible label nearby explaining it filters by number of CPUs. New users may not understand the control without prior knowledge of the domain. |

#### Minor / Informational

| Finding | WCAG Criterion | Detail |
|---------|---------------|--------|
| **No `<meta name="description">`** | SEO / best practice | The page has no meta description tag. This does not affect accessibility directly but impacts search engine discoverability. |
| **No Open Graph tags** | SEO / best practice | Sharing the URL on social platforms or in Slack/Teams will produce a generic unfurl with no title, description, or image. |
| **External links not labelled** | 2.4.4 Link Purpose | The two commit hash links ("15cbdcd5") open GitHub in a new tab (`target="_blank"`) but have no `aria-label` describing their destination. A screen reader user hears "15cbdcd5" twice with no context. |

### 3.4 UX Observations

| Observation | Detail |
|-------------|--------|
| **URL does not update on tab switch** | Clicking Overview / allocs/op / bytes/op / ns/op changes the displayed charts but the URL stays `https://strawgate.com/octo11y/`. It is not possible to share a link to a specific metric view. |
| **Active tab not visually obvious from screenshot** | In screenshots of the tab-switched states the selected tab styling is subtle. A stronger active-state indicator (underline, bold, or background change) would help users orient themselves. |
| **"VIEW" link text** | A small label "VIEW" appears in the stats summary line; its destination or action is not clear from the label text alone. |
| **Stats panel is informative** | The summary row (Metrics: 3 / Runs: 2 / Series: 9 / Monitor: 0) gives a good at-a-glance overview of the dataset. |
| **"Powered by benchkit" footer link** | The footer attribution link leads to the GitHub repository — appropriate and non-intrusive. |

---

## 4. Screenshots

Screenshots were taken with Playwright and saved locally during the audit run. The following states were captured:

| File | Description |
|------|-------------|
| `home-full.png` | Full-page screenshot of the home/overview dashboard |
| `viewport-desktop-1280.png` | 1280×800 desktop viewport |
| `viewport-tablet-768.png` | 768×1024 tablet viewport |
| `viewport-mobile-375.png` | 375×812 mobile viewport |
| `tab-Overview.png` | Overview tab active (9 charts) |
| `tab-allocs-op.png` | allocs/op tab active (21 charts) |
| `tab-bytes-op.png` | bytes/op tab active (21 charts) |
| `tab-ns-op.png` | ns/op tab active (21 charts) |

> Screenshots were generated in `/tmp/benchkit-audit/screenshots/` during the audit session. They are not committed to the repository since they are binary artifacts of a point-in-time audit.

---

## 5. Limitations Encountered

### What Playwright Can Detect

- HTTP status codes for all loaded resources
- JavaScript console errors and warnings
- DOM structure (headings, landmarks, ARIA attributes)
- Computed CSS styles (color, font-size, etc.) for contrast estimation
- Layout properties (scroll width vs. viewport width for overflow detection)
- Interactive element enumeration (buttons, inputs, links)
- Heading hierarchy
- Keyboard-focusable element count

### What Playwright Cannot Detect (Without Additional Tools)

| Limitation | Explanation |
|------------|-------------|
| **True color contrast** | `getComputedStyle` returns the immediate element's background color, often `rgba(0,0,0,0)` (transparent). Accurate WCAG contrast checking requires compositing all ancestor backgrounds, which Playwright cannot do natively. A dedicated tool like `axe-core` or `lighthouse` is needed for reliable contrast analysis. |
| **Chart accessibility** | The trend charts are rendered as `<canvas>` elements. Playwright cannot inspect the chart content, axis labels, data point values, or keyboard navigation inside canvas. The charts have no ARIA description (`aria-label` on the canvas element was not present). |
| **Keyboard navigation flow** | Playwright can simulate `Tab` key presses, but verifying a logical and complete focus order across the whole page requires manual testing or a purpose-built accessibility runner. |
| **Screen reader output** | Playwright does not simulate a screen reader. The ARIA findings above are structural — whether they actually produce a good screen reader experience requires testing with NVDA, VoiceOver, or JAWS. |
| **Color blindness / visual simulation** | Playwright does not simulate colour-blind vision. Chromium's DevTools protocol has a `setEmulatedVisionDeficiency` command that could be used in a future audit. |
| **Animated content** | If charts animate on load, `waitForTimeout` provides a best-effort wait. Complex animation states may not be captured deterministically. |
| **Performance metrics** | Playwright can expose `page.metrics()` but Core Web Vitals (LCP, CLS, FID) require the Lighthouse integration or Chrome DevTools Protocol tracing. |
| **Server-side rendering / SEO crawlability** | The site is a client-side SPA. Playwright sees the rendered DOM. A Googlebot/crawler without JavaScript sees only the blank pre-render HTML. |

---

## 6. Recommendations

### Immediate (Accessibility – High Impact)

1. **Add an `<h1>` to the page header.** Change the `<span>` elements in `<header>` to `<h1>` (app name) and a `<p>` or `<span>` (subtitle). This establishes a correct heading hierarchy.

2. **Implement proper tab semantics.** Wrap the metric buttons in `<div role="tablist">` and add `role="tab"` and `aria-selected="true/false"` to each button. Update `aria-selected` in the Preact component state when the active tab changes.

3. **Add a skip-navigation link.** Insert `<a href="#main-content" class="visually-hidden-focusable">Skip to main content</a>` as the first element in `<body>`, and add `id="main-content"` to the `<main>` element.

4. **Label sections.** Add `aria-labelledby` pointing to the section's heading on each `<section>`, or add `aria-label` on the one section without a heading.

5. **Label the runs table.** Add `<caption>Recent benchmark runs</caption>` inside the `<table>`, and add `scope="col"` to each `<th>`.

### Short-Term (UX & SEO)

6. **Add `<meta name="description">`.** A one-sentence description of the dashboard improves search discoverability.

7. **Add Open Graph tags.** `og:title`, `og:description`, and `og:image` enable rich unfurls when the URL is shared.

8. **Update URL on tab change.** Use `history.pushState` or a hash-based routing approach (e.g., `#metric=ns_per_op`) so specific views can be bookmarked and shared.

9. **Improve external link labels.** Add `aria-label="View commit 15cbdcd5 on GitHub"` to the commit hash links in the runs table.

### Process (Repeatable Auditing)

10. **Integrate `axe-core` for automated accessibility scanning.** Add `@axe-core/playwright` to run structured WCAG checks as part of CI:
    ```javascript
    import AxeBuilder from '@axe-core/playwright';
    const results = await new AxeBuilder({ page }).analyze();
    ```

11. **Add a Playwright-based smoke test to CI.** A lightweight test that loads the page, confirms the `<h1>` exists, verifies the tab buttons change chart count, and checks for zero console errors would catch regressions early.

12. **Use Lighthouse CI for performance and SEO.** `lhci autorun` can be added as a GitHub Actions step to track Core Web Vitals, SEO score, and accessibility score over time — dogfooding Benchkit's own CI infrastructure for this purpose.

---

## 7. Making This a Repeatable Process

### Suggested Workflow

```
PR opened / push to main
        │
        ▼
 playwright install chromium
        │
        ▼
 node audit.mjs          ← crawl, screenshot, collect errors
        │
        ▼
 node axe-scan.mjs       ← run axe-core against each page
        │
        ▼
 lhci autorun            ← Lighthouse CI for perf/SEO/a11y scores
        │
        ▼
 Upload artifacts        ← screenshots + JSON reports as workflow artifacts
        │
        ▼
 Fail CI if:
   • any HTTP >= 400
   • any axe violations of impact "critical" or "serious"
   • Lighthouse accessibility score < 90
```

### Minimal Repeatable Script Template

```javascript
// audit.mjs — run with: node audit.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const BASE = 'https://strawgate.github.io/octo11y/';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', r => errors.push(`NET: ${r.url()}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'home.png', fullPage: true });

const h1 = await page.$('h1');
console.assert(h1, 'FAIL: no <h1> found');
console.assert(errors.length === 0, `FAIL: ${errors.length} errors`);

writeFileSync('audit-result.json', JSON.stringify({ errors }, null, 2));
await browser.close();
```

This template can be extended incrementally as the site grows.
