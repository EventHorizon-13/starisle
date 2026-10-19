// Compare the zoomed Virgo cluster with the previous or current frontend.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.STAR_CHART_URL || 'http://127.0.0.1:18080';
const source = process.env.STAR_CHART_SCRIPT || `${__dirname}/../static/app.js`;
const before = process.env.STAR_CHART_BEFORE === '1';
const output = '/tmp/star-chart-density-verification';
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
      await context.addInitScript(() => {
        localStorage.setItem('night-sky-location', JSON.stringify({ lat: 51.4779, lon: 0.0, elevation: 0 }));
        localStorage.setItem('night-sky-satellites', '[]');
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (process.env.STAR_CHART_SCRIPT || process.env.STAR_CHART_WORKING_COPY === '1') {
        await page.route('**/app.v*.js', route => route.fulfill({ path: source, contentType: 'text/javascript' }));
      }
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => state.sky && !state.timeline.previewLoading);
      await page.evaluate(async () => {
        document.querySelector('#timeInput').value = '2026-04-01T23:00:00';
        resetTimeline(selectedDate());
        await refreshSky();
      });
      for (const zoom of before ? [6] : [2, 3, 4, 6]) {
        await page.evaluate(async (zoom) => {
          const m = canvasMetrics();
          const target = findTarget('messier:87');
          const p = projectPoint(target.azimuth, target.altitude, m.w, m.h, m.cx, m.cy, m.radius);
          state.selected = null;
          view.zoom = zoom;
          view.x = -(p.x - m.cx) * zoom;
          view.y = -(p.y - m.cy) * zoom;
          updateViewUi();
          await loadField();
          drawSky();
        }, zoom);
        const snapshot = await page.evaluate((before) => {
          const m = canvasMetrics();
          const all = [...state.sky.messier, ...state.field.deep_sky];
          const candidates = all.filter(item => item.above_horizon).map(item => ({ item, p: screenOf(item.azimuth, item.altitude, m) }))
            .filter(({p}) => p.x >= 8 && p.x <= m.w - 8 && p.y >= (m.plotTop || 0) + 8 && p.y <= (m.plotBottom || m.h) - 8);
          const rendered = before ? candidates.filter(({item}) => messierDisplay(item, false).marker) : state.deepSkyMarkers;
          const labels = before ? [] : state.deepSkyLabels;
          return { zoom: view.zoom, loaded: state.field.deep_sky.length, candidates: candidates.length, count: rendered.length,
            markers: rendered.map(({item,p}) => ({ id: item.id, x: p.x, y: p.y })), labels };
        }, before);
        if (!before) {
          assert(snapshot.count <= (mobile ? 20 : 60), 'marker budget');
          assert(snapshot.labels.length <= (mobile ? 6 : 12), 'label budget');
          for (let i = 0; i < snapshot.markers.length; i++) for (let j = i + 1; j < snapshot.markers.length; j++) {
            const a = snapshot.markers[i], b = snapshot.markers[j];
            assert(Math.hypot(a.x - b.x, a.y - b.y) >= (mobile ? 38 : 32) - .001, 'marker spacing');
          }
          for (let i = 0; i < snapshot.labels.length; i++) for (let j = i + 1; j < snapshot.labels.length; j++) {
            const a = snapshot.labels[i], b = snapshot.labels[j];
            assert(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2, 'label collision');
          }
        }
        await page.screenshot({ path: `${output}/${before ? 'before' : 'after'}-${mobile ? 'mobile' : 'desktop'}-${zoom}x.png`, fullPage: true });
        results.push({ mobile, zoom, loaded: snapshot.loaded, candidates: snapshot.candidates, markers: snapshot.count, labels: snapshot.labels.length });
      }
      if (!before) {
        // Unknown magnitudes must not act as magnitude zero. A selected faint
        // target remains visible even when background targets are thinned.
        const checks = await page.evaluate(() => {
          const oldZoom = view.zoom;
          view.zoom = 1.75;
          const unknownShown = deepSkyDisplay({ magnitude: null }, false).marker;
          view.zoom = oldZoom;
          const shown = new Set(state.deepSkyMarkers.map(({item}) => item.id));
          const target = state.field.deep_sky.find(item => !shown.has(item.id));
          if (!target) return { unknownShown, selectedShown: true, hiddenPick: false };
          const m = canvasMetrics();
          const p = screenOf(target.azimuth, target.altitude, m);
          const hiddenPick = selectAt(p.x + m.rect.left, p.y + m.rect.top)?.id === target.id;
          setSelected(target);
          return { unknownShown, hiddenPick, selectedShown: state.deepSkyMarkers.some(({item}) => item.id === target.id) };
        });
        assert(!checks.unknownShown);
        assert(!checks.hiddenPick, 'hidden markers must not intercept taps');
        assert(checks.selectedShown, 'selected target must bypass the background filter');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log(JSON.stringify({ before, status: 'passed', results, artifacts: output }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
