// Serve the checkout first, then SITE=http://127.0.0.1:8672 npm run test:browser.
// CHROME may select a local Chromium installation; no browser is downloaded.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const site = process.env.SITE || 'http://127.0.0.1:8672';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/opt/google/chrome/chrome', headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run'], protocolTimeout: 120000 });
const errors = [], results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, info) => { results.push({ name, info }); console.log(`PASS ${name}`, info ?? ''); };
await fs.mkdir('test-results', { recursive: true });
const frames = (page, n = 3) => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame); }, n);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('503')) errors.push(m.text()); });
  await page.goto(site);
  await page.waitForFunction(() => window.NAV, { timeout: 30000 });
  check('startup', await page.evaluate(() => NAV.S.episode.episode));
  await page.click('#pause');
  assert.equal(await page.$eval('#pause .lbl', (e) => e.textContent), 'Resume');
  assert.equal(await page.evaluate(() => NAV.S.view), 'review');
  check('pause control matches playback');

  // Deliberately finish an earlier request after the newest requested scene.
  await page.setRequestInterception(true);
  let failDownload = true;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('gate-0.json')) setTimeout(() => r.continue(), 700);
    else if (new URL(r.url()).pathname.endsWith('empty-1.json') && failDownload) { failDownload = false; r.respond({ status: 503, body: 'unavailable' }); }
    else r.continue();
  });
  assert.equal(await page.evaluate(async () => {
    const first = NAV.playRecorded('gate-0.json');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const last = NAV.playRecorded('open-0.json');
    await Promise.all([first, last]);
    return NAV.S.episode.scene;
  }), 'open');
  check('latest scene wins when downloads finish out of order');
  assert.equal(await page.evaluate(async () => {
    await NAV.playRecorded('empty-1.json');
    await NAV.playRecorded('empty-1.json');
    return NAV.S.episode.episode;
  }), 'empty-1.json');
  check('failed download retries successfully');

  const runs = await page.evaluate(() => NAV.S.runs.map((r) => r.file));
  for (const file of runs) {
    const outcome = await page.evaluate(async (file) => {
      await NAV.playRecorded(file);
      const { S } = NAV;
      document.getElementById('pause').click();
      // Exercise poses, plans and trace on both sides of every plan transition.
      for (const plan of S.plans) {
        S.disp = plan.t;
        await new Promise(requestAnimationFrame);
      }
      S.disp = S.ticks.at(-1).t;
      await new Promise(requestAnimationFrame);
      return { scene: S.episode.scene, tile: document.querySelector('#scenes .on').dataset.scene,
        reached: S.events.some((e) => e.type === 'reached'),
        contacts: S.events.filter((e) => ['contact', 'fall'].includes(e.type)).length,
        meta: S.episode.meta, label: document.getElementById('outcome').textContent,
        finalDistance: Math.hypot(...S.episode.goal.map((x, i) => x - S.ticks.at(-1).q[i])),
        cachedRuns: NAV.stats().cachedRuns };
    }, file);
    assert.equal(outcome.scene, outcome.tile);
    assert.ok(outcome.meta.provenance);
    assert.ok(outcome.label.startsWith('Recorded outcome:'));
    if (outcome.meta.clean) { assert.ok(outcome.reached); assert.equal(outcome.contacts, 0); assert.ok(outcome.finalDistance < 0.4); }
    else assert.notEqual(outcome.meta.outcome, 'reached');
    assert.ok(outcome.cachedRuns <= 4);
    check(`all plan transitions: ${file}`, { scene: outcome.scene, outcome: outcome.meta.outcome,
      finalDistance: outcome.finalDistance, cachedRuns: outcome.cachedRuns });
  }
  assert.equal(await page.evaluate(async () => {
    await NAV.playRecorded('course-0.json'); document.getElementById('pause').click(); NAV.S.disp = NAV.S.ticks.at(-1).t;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { state: document.getElementById('state').textContent, outcome: NAV.S.episode.meta.outcome };
  }).then(({ state, outcome }) => state === ({ reached: 'Reached the goal', contact: 'Obstacle contact', fall: 'Fell', time_limit: 'Time limit · goal not reached', stopped_near_goal: 'Stopped near the goal' })[outcome]), true);
  check('final state reports the recorded outcome');

  await page.click('#reset');
  assert.equal(await page.evaluate(() => NAV.S.eventCursor), -1);
  assert.equal(await page.$eval('#trace', (e) => e.textContent.includes('Reached')), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => NAV.S.view), 'review');
  check('reset clears future events; Escape pauses');

  // Focused buttons must retain native keyboard activation.
  await page.focus('[data-scene="slalom"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => NAV.S.episode.scene === 'slalom');
  await page.focus('#about-open'); await page.keyboard.press('Enter');
  assert.ok(await page.$eval('#about', (e) => e.open));
  const viewBefore = await page.evaluate(() => NAV.S.view);
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => NAV.S.view), viewBefore);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#about', (e) => e.open), false);
  check('keyboard scene buttons and dialog work without global shortcut interference');

  // Repeated scene changes should return to the same GPU allocation count.
  const cycle = async () => {
    for (const file of ['lowbar-0.json', 'gate-0.json', 'course-0.json', 'empty-0.json', 'lowbar-0.json']) {
      await page.evaluate(async (file) => { await NAV.playRecorded(file); document.getElementById('pause').click(); NAV.S.disp = 3.5; }, file);
      await frames(page);
    }
    return page.evaluate(() => NAV.stats());
  };
  const warm = await cycle();
  for (let i = 0; i < 3; i++) await cycle();
  const final = await page.evaluate(() => NAV.stats());
  assert.equal(final.textures, warm.textures);
  assert.equal(final.geometries, warm.geometries);
  check('20 scene switches do not accumulate GPU resources', { warm, final });
  await pause(5000);
  const before = await page.evaluate(() => NAV.stats().renderedFrames);
  await pause(1000);
  const rendered = await page.evaluate(() => NAV.stats().renderedFrames) - before;
  assert.ok(rendered <= 1, `paused view rendered ${rendered} frames`);
  check('settled paused view stops rendering', { framesPerSecond: rendered });
  await page.screenshot({ path: 'test-results/desktop.png' });

  // Resume a complete run with normal supported 2x playback and observe its final state.
  await page.evaluate(async () => {
    window.reachedObserved = false;
    window.traceObserver = new MutationObserver(() => { if (document.getElementById('trace').textContent.includes('Entered goal region')) window.reachedObserved = true; });
    window.traceObserver.observe(document.getElementById('trace'), { childList: true });
    await NAV.playRecorded('empty-0.json'); NAV.S.replaySpeed = 2;
  });
  await page.waitForFunction(() => NAV.S.view === 'review', { timeout: 30000 });
  await pause(200);
  assert.equal(await page.$eval('#pause .lbl', (e) => e.textContent), 'Resume');
  assert.ok(await page.evaluate(() => { window.traceObserver.disconnect(); return window.reachedObserved; }));
  check('full 2x replay reaches the goal and stops with correct controls');

  // Seek backward using the actual timeline, then resume without reporting future events.
  const bar = await page.$('#runbar'); const box = await bar.boundingBox();
  await page.mouse.click(box.x + 1, box.y + box.height / 2);
  assert.equal(await page.$eval('#trace', (e) => e.textContent.includes('Reached')), false);
  check('scrubbing backwards rebuilds event history');

  const phone = await browser.newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.goto(site); await phone.waitForFunction(() => window.NAV);
  assert.ok(await phone.evaluate(() => document.body.classList.contains('side-closed')));
  assert.equal(await phone.evaluate(() => NAV.ui.candidates), false);
  await phone.tap('#menu');
  // The tile enters the viewport before the panel's slide finishes. Wait for a stable tap target.
  await phone.waitForFunction(() => getComputedStyle(document.getElementById('side')).transform === 'none');
  await phone.tap('[data-scene="gate"]');
  await phone.waitForFunction(() => NAV.S.episode.scene === 'gate');
  await phone.evaluate(async () => { await NAV.playRecorded('empty-0.json'); await NAV.playRecorded('gate-0.json'); });
  assert.ok(await phone.evaluate(() => NAV.stats().cachedRuns <= 2));
  await phone.tap('#menu');
  await phone.waitForFunction(() => document.getElementById('side').getBoundingClientRect().top >= innerHeight);
  await phone.tap('#play');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await frames(phone);
  await phone.screenshot({ path: 'test-results/phone.png' });
  check('phone touch controls, scene switch, viewport and reduced overlays');
  await phone.close();

  const recovery = await browser.newPage(); let failStartup = true;
  await recovery.setRequestInterception(true);
  recovery.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('index.json') && failStartup) { failStartup = false; r.respond({ status: 503, body: 'unavailable' }); }
    else r.continue();
  });
  recovery.on('pageerror', (e) => errors.push(e.message));
  await recovery.goto(site);
  await recovery.waitForSelector('#load-retry:not([hidden])');
  await recovery.click('#load-retry');
  await recovery.waitForFunction(() => window.NAV, { timeout: 30000 });
  check('startup failure offers a working retry');
  await recovery.close();
  assert.deepEqual(errors, []);
  check('no uncaught browser errors');
} finally {
  await fs.writeFile('test-results/browser.json', JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
