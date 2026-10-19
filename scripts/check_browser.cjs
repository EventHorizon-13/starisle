// NODE_PATH must contain Playwright; set STAR_CHART_URL for a preview instance.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.STAR_CHART_URL || 'http://127.0.0.1:18080';
const output = process.env.STAR_CHART_CHECK_OUTPUT || '/tmp/star-chart-verification';
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('night-sky-location', JSON.stringify({ lat: 51.4779, lon: 0.0, elevation: 0 }));
      localStorage.setItem('night-sky-satellites', '[]');
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => state.sky && !state.timeline.previewLoading);
    await page.locator('#timeInput').fill('2026-10-06T15:35:30');
    await page.locator('#timeInput').dispatchEvent('change');
    await page.waitForFunction(() => state.sky?.requested_time === '2026-10-06T07:35:30+00:00' && !state.timeline.previewLoading);
    await page.locator('#moonStatusBtn').click();
    await page.locator('#trailBtn').click();
    await page.locator('#trailSpan [data-hours="24"]').click();
    await page.waitForFunction(() => currentTrailData()?.span_minutes === 2880 && !state.timeline.previewLoading);
    await page.locator('#timelineMode [data-mode="day"]').click();
    await page.waitForFunction(() => state.timeline.solarSamples.size === 61 && !state.timeline.previewLoading);
    await page.evaluate(() => setTimeFromSlider(11));
    assert(await page.evaluate(() => state.trail.data === null && document.querySelector('#eventsResult').hidden));
    const previewMoon = await page.evaluate(() => ({ ...state.sky.moon }));
    assert.equal(previewMoon.illumination, 37.7);
    await page.evaluate(() => finishTimelineScrub());
    await page.waitForFunction(() => state.sky?.requested_time === '2026-10-17T07:35:30+00:00' && currentTrailData()?.requestedCenter === selectedDate().getTime());
    const snapshot = await page.evaluate(() => ({ moon: state.sky.moon, trail: state.trail.data, center: state.timeline.centerMs }));
    assert.equal(snapshot.trail.span_minutes, 2880);
    assert.equal(snapshot.trail.count, 193);
    assert.equal(snapshot.center, Date.parse('2026-10-06T07:35:30Z'));
    assert.equal(snapshot.moon.illumination, 37.7);
    assert.equal(snapshot.moon.magnitude, -9.41);
    assert(Math.abs(snapshot.trail.target.points[96][0] - snapshot.moon.azimuth) < .01);
    assert(Math.abs(snapshot.trail.target.points[96][1] - snapshot.moon.altitude) < .01);
    assert.match(await page.locator('#selectedSubline').innerText(), /蛾眉月/);
    assert.match(await page.locator('#trailNote').innerText(), /10\/16.*10\/18/);
    await page.waitForFunction(() => document.querySelector('#eventsResult').innerText.length > 0);
    await page.screenshot({ path: `${output}/moon-fixed-desktop.png`, fullPage: true });

    // Switching dates/targets while previous requests are pending cannot reuse them.
    await page.evaluate(() => { setSelected(findTarget('venus')); setSelected(findTarget('moon')); setTimeFromSlider(12); finishTimelineScrub(); setTimeFromSlider(13); finishTimelineScrub(); });
    await page.waitForFunction(() => state.sky?.requested_time === '2026-10-19T07:35:30+00:00' && currentTrailData()?.requestedCenter === selectedDate().getTime());
    assert.equal(await page.evaluate(() => currentTrailData().target.id), 'moon');

    // Hour-mode preview follows JPL samples, including the Moon's own motion.
    await page.locator('#timelineMode [data-mode="hour"]').click();
    await page.waitForFunction(() => state.timeline.solarSamples.size === 193 && !state.timeline.previewLoading && currentTrailData());
    await page.evaluate(() => setTimeFromSlider(187));
    const hourPreview = await page.evaluate(() => ({ ...state.sky.moon }));
    const queryTime = await page.evaluate(() => skyTimeIso());
    const response = await page.request.get(`${base}/api/sky?lat=51.4779&lon=0.0&datetime=${encodeURIComponent(queryTime)}`);
    assert.equal(response.status(), 200);
    const exact = (await response.json()).moon;
    assert(Math.abs(hourPreview.altitude - exact.altitude) < .03, 'hour preview altitude');
    assert(Math.abs((hourPreview.azimuth - exact.azimuth + 540) % 360 - 180) < .03, 'hour preview azimuth');
    await page.evaluate(() => finishTimelineScrub());
    await page.waitForFunction(() => !state.timeline.scrub && new Date(state.sky?.requested_time).getTime() === selectedDate().getTime());

    // Search, deep-star loading and a southern-hemisphere observer remain functional.
    await page.locator('#searchInput').fill('M42');
    await page.locator('#searchBtn').click();
    await page.waitForFunction(() => state.selected?.id === 'messier:42');
    await page.evaluate(() => { setLocation(-33.9, 151.2, 0); setNow(); zoomTo(3); });
    await page.waitForFunction(() => state.sky?.location.latitude === -33.9 && state.field.stars.length > 0);
    await page.waitForFunction(() => !state.timeline.previewLoading);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      setLocation(51.4779, 0.0, 0);
      document.querySelector('#timeInput').value = '2026-10-17T15:35:30';
      resetTimeline(selectedDate());
      resetView();
      await refreshSky();
      setSelected(findTarget('moon'));
    });
    await page.waitForFunction(() => currentTrailData()?.target.id === 'moon');
    const compactHeader = await page.evaluate(() => {
      const location = document.querySelector('.location-trigger').getBoundingClientRect();
      const time = document.querySelector('.time-row').getBoundingClientRect();
      return { locationTop: location.top, timeTop: time.top, scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    assert(Math.abs(compactHeader.locationTop - compactHeader.timeTop) < 2, 'coordinates and time must stay on the same mobile row');
    assert(compactHeader.scrollWidth <= compactHeader.viewportWidth + 1, 'compact header must not overflow horizontally');
    await page.screenshot({ path: `${output}/moon-fixed-mobile.png`, fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    await page.goto(`${base}/moon-calendar`, { waitUntil: 'networkidle' });
    await page.locator('#monthInput').fill('2026-10');
    await page.locator('#monthInput').dispatchEvent('change');
    await page.waitForFunction(() => state.data?.year === 2026 && state.data.month === 10);
    await page.locator('[data-index="16"]').click();
    assert.match(await page.locator('#selectedPhaseName').innerText(), /蛾眉月/);
    assert.match(await page.locator('#selectedPhaseTag').innerText(), /6\.5/);
    await page.screenshot({ path: `${output}/moon-calendar-fixed-mobile.png`, fullPage: true });
    await page.goto(`${base}/solar-system`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('canvas')?.width > 0);
    await page.waitForFunction(() => state.satelliteFetched && state.satellites.length === 21);
    await page.locator('.planet-row[data-id="saturn"]').click();
    assert.match(await page.locator('#satelliteCaption').innerText(), /7 颗/);
    await page.screenshot({ path: `${output}/saturn-satellites-fixed-mobile.png`, fullPage: true });
    const homepage = await (await page.request.get(base)).text();
    const scriptPath = homepage.match(/<script src="([^\"]+)"/)[1];
    const script = await page.request.get(`${base}${scriptPath}`);
    assert.equal(await script.text(), fs.readFileSync(`${__dirname}/../static/app.js`, 'utf8'));
    const sw = await (await page.request.get(`${base}/sw.js`)).text();
    const shell = JSON.parse(sw.match(/const SHELL = (\[[^;]*\]);/)[1]);
    for (const resource of shell) assert.equal((await page.request.get(`${base}${resource}`)).status(), 200, resource);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'passed', checks: ['day timeline and 48h moon trajectory', 'old-response isolation', 'hour timeline versus exact ephemeris', 'catalog search', 'southern observer and deep stars', 'mobile layout', 'moon calendar age and phase', 'all 21 planetary satellites including seven Saturn moons', 'deployed assets and offline shell'], screenshotMoon: snapshot.moon, artifacts: output }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
