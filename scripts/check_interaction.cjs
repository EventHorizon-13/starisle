const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.STAR_CHART_URL || 'http://127.0.0.1:18080';
const baseline = process.env.STAR_CHART_BASELINE === '1';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('night-sky-location', JSON.stringify({ lat: 51.4779, lon: 0.0, elevation: 0 }));
      localStorage.setItem('night-sky-satellites', '[]');
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.STAR_CHART_SCRIPT) await page.route('**/app.v*.js', route => route.fulfill({ path: process.env.STAR_CHART_SCRIPT, contentType: 'text/javascript' }));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => state.sky && !state.timeline.previewLoading);
    await page.evaluate(async () => {
      document.querySelector('#timeInput').value = '2026-04-01T23:00:00';
      resetTimeline(selectedDate());
      await refreshSky();
      const m = canvasMetrics(), target = findTarget('messier:87');
      const p = projectPoint(target.azimuth, target.altitude, m.w, m.h, m.cx, m.cy, m.radius);
      view.zoom = 6;
      view.x = -(p.x - m.cx) * 6;
      view.y = -(p.y - m.cy) * 6;
      await loadField();
      drawSky();
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      window.__perf = { draws: [], lists: 0, previews: 0 };
      const originalDraw = drawSky, originalList = renderVisibleList, originalPreview = previewTimeline;
      drawSky = function(...args) { const start = performance.now(); const result = originalDraw(...args); window.__perf.draws.push(performance.now() - start); return result; };
      renderVisibleList = function(...args) { window.__perf.lists++; return originalList(...args); };
      previewTimeline = function(...args) { window.__perf.previews++; return originalPreview(...args); };
    });
    const drawing = await page.evaluate(() => {
      window.__perf.draws = [];
      for (let i = 0; i < 20; i++) drawSky();
      const sorted = [...window.__perf.draws].sort((a,b) => a-b);
      return { medianMs: sorted[Math.floor(sorted.length/2)], p95Ms: sorted[Math.floor(sorted.length*.95)] };
    });
    const pan = await page.evaluate(async () => {
      window.__perf.draws = [];
      const start = performance.now(), initialX = view.x;
      for (let i = 0; i < 100; i++) panBy(.2, 0);
      const handlerMs = performance.now() - start;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      clearTimeout(state.fieldTimer);
      return { handlerMs, paints: window.__perf.draws.length, actualDeltaX: view.x - initialX };
    });
    await page.evaluate(() => { resetView(); resetTimeline(selectedDate()); });
    await page.waitForFunction(() => !state.timeline.previewLoading);
    const slider = await page.evaluate(async () => {
      window.__perf = { draws: [], lists: 0, previews: 0 };
      const start = performance.now(), input = document.querySelector('#timeSlider');
      for (let i = 1; i <= 100; i++) { input.value = i; input.dispatchEvent(new Event('input', { bubbles: true })); }
      const handlerMs = performance.now() - start;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const previewTime = state.sky.requested_time;
      const result = { handlerMs, paints: window.__perf.draws.length, previews: window.__perf.previews, lists: window.__perf.lists,
        previewTime, selectedTime: selectedDate().toISOString() };
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return result;
    });
    await page.waitForFunction(() => !state.timeline.scrub && new Date(state.sky.requested_time).getTime() === selectedDate().getTime());
    if (!baseline) {
      assert(pan.paints <= 2, 'pan events must be coalesced into a frame');
      assert(Math.abs(pan.actualDeltaX - 20) < .01, 'pan must retain all deltas');
      assert(slider.previews <= 2, 'slider inputs must be coalesced');
      assert.equal(slider.lists, 0, 'sidebar list must wait for release');
      assert.equal(slider.previewTime, slider.selectedTime, 'preview must show the latest input');
      // Real pointer handlers must defer field requests until the last finger
      // lifts, while preserving panning and two-finger zoom.
      const requests = [];
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/field') requests.push(request.url()); });
      await page.evaluate(() => {
        clearTimeout(state.fieldTimer);
        view.zoom = 3;
        drawSky();
        const m = canvasMetrics(), x = m.rect.left + m.cx, y = m.rect.top + m.cy;
        window.__gesture = { x, y, initialX: view.x };
        canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 101, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
        for (let i = 1; i <= 30; i++) canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 101, pointerType: 'touch', clientX: x + i, clientY: y, bubbles: true }));
      });
      await page.waitForTimeout(300);
      assert.equal(requests.length, 0, 'no catalogue fetch during a held drag');
      assert.equal(await page.evaluate(() => Math.round(view.x - window.__gesture.initialX)), 30);
      const fieldRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/field');
      await page.evaluate(() => canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 101, pointerType: 'touch', bubbles: true })));
      await fieldRequest;
      await page.waitForFunction(() => !state.field.loading);
      await page.evaluate(() => {
        const m = canvasMetrics(), x = m.rect.left + m.cx, y = m.rect.top + m.cy;
        const event = (type, id, px) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: px, clientY: y, bubbles: true }));
        event('pointerdown', 201, x - 50); event('pointerdown', 202, x + 50);
        event('pointermove', 202, x + 90);
        event('pointerup', 202, x + 90); event('pointerup', 201, x - 50);
      });
      assert.equal(await page.evaluate(() => Math.round(view.zoom * 10)), 42, 'pinch must apply its latest distance');
      await page.waitForFunction(() => !state.field.loading && view.pointers.size === 0);
      await page.screenshot({ path: '/tmp/star-chart-interaction-fixed-mobile.png', fullPage: true });
    }
    assert.deepEqual(errors, []);
    const result = { baseline, cpuSlowdown: 4, deviceScaleFactor: 2, drawing, pan, slider, status: 'passed' };
    if (process.env.STAR_CHART_RESULT) fs.writeFileSync(process.env.STAR_CHART_RESULT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
