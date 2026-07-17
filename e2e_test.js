// End-to-end test: two separate browser profiles share roster data via the API.
const { chromium } = require('playwright');

(async () => {
  const base = 'http://localhost:3000';
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    proxy: proxy ? { server: proxy, bypass: 'localhost' } : undefined,
  });
  let failures = 0;
  const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name); if (!ok) failures++; };

  // --- User A opens people.html and adds a roster entry via localStorage ---
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(base + '/people.html', { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(1500); // let initial pull settle

  // Simulate the app saving new shared data
  const marker = 'e2e-marker-' + Math.floor(Date.now() / 1000);
  await pageA.evaluate((m) => {
    localStorage.setItem('wincon_people', JSON.stringify({ testEntry: m, people: [{ name: m, division: 'Volunteers' }] }));
  }, marker);
  await pageA.waitForTimeout(2000); // debounce (800ms) + upload

  // Server should now have it
  const serverState = await pageA.evaluate(async () => (await (await fetch('/api/state')).json()).states);
  check('server received user A write', !!serverState.wincon_people && serverState.wincon_people.v.includes('e2e-marker'));

  // --- User B (fresh profile, empty localStorage) opens the same page ---
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(base + '/people.html', { waitUntil: 'networkidle' });
  await pageB.waitForTimeout(2500); // initial pull + possible one-time reload
  const seenByB = await pageB.evaluate(() => localStorage.getItem('wincon_people'));
  check('user B sees user A data', !!seenByB && seenByB.includes(marker));

  // --- User B edits; A's next poll picks it up (banner path) ---
  const marker2 = marker + '-fromB';
  await pageB.evaluate((m) => {
    localStorage.setItem('wincon_people', JSON.stringify({ testEntry: m }));
  }, marker2);
  await pageB.waitForTimeout(2000);
  const serverState2 = await pageB.evaluate(async () => (await (await fetch('/api/state')).json()).states);
  check('server received user B write', serverState2.wincon_people.v.includes('-fromB'));

  // --- All pages load without JS errors with sync.js installed ---
  const pages = ['index.html', 'people.html', 'outreach_map.html', 'adventure_planner.html',
    'adventure_quest.html', 'mindmap.html', 'player_journey.html', 'dashboard.html', 'schedule.html'];
  for (const p of pages) {
    const errors = [];
    const pg = await ctxA.newPage();
    pg.on('pageerror', (e) => errors.push(String(e)));
    await pg.goto(base + '/' + p, { waitUntil: 'load', timeout: 20000 }).catch((e) => errors.push(String(e)));
    await pg.waitForTimeout(1200);
    check(p + ' loads clean', errors.length === 0);
    if (errors.length) console.log('   errors:', errors.slice(0, 2).join(' | '));
    await pg.close();
  }

  await browser.close();
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})();
