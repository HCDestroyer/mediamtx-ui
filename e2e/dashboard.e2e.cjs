const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
(async () => {
  const browser = await chromium.launch();
  const log = []; const check = (n, ok, x='') => log.push(`${ok?'PASS':'FAIL'} ${n} ${x}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read','clipboard-write'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await ctx.addInitScript(() => localStorage.setItem('nodo:auth-skipped','1'));
  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  check('demo server loads channels', true);
  await page.waitForTimeout(4500);
  const kpis = await page.locator('main').innerText();
  check('KPI shows 3 / 5 live', /3\s*\/ 5/.test(kpis));
  check('readers KPI = 7', /Lectores\s*7/.test(kpis.replace(/\n/g,' ')), kpis.replace(/\n/g,' ').slice(0,200));
  check('Mbps computed (not dash)', !/Entrada\s*—/.test(kpis.replace(/\n/g,' ')));
  const names = await page.locator('table tbody tr td:first-child').allInnerTexts();
  check('table order live first', names.map(n=>n.split('\n')[0]).join(',') === 'canal63,canal63_720,canal65,camara_patio,prueba_hls', JSON.stringify(names.map(n=>n.split('\n')[0])));
  check('dynamic chip on canal65', /canal65\s*Dinámico/.test(names.join('|').replace(/\n/g,' ')));
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-dashboard-desktop.png' });

  // filter + search
  await page.getByRole('tab', { name: /Sin señal/ }).click();
  let rows = await page.locator('table tbody tr').count();
  check('filter offline -> 2 rows', rows === 2, String(rows));
  await page.getByRole('tab', { name: /Todos/ }).click();
  await page.fill('input[placeholder="Buscar canal"]', '63');
  await page.waitForTimeout(300);
  rows = await page.locator('table tbody tr').count();
  check('search "63" -> 2 rows', rows === 2, String(rows));
  await page.fill('input[placeholder="Buscar canal"]', 'zzz');
  await page.waitForSelector('text=Ningún canal coincide');
  check('no-results state', true);
  await page.fill('input[placeholder="Buscar canal"]', '');

  // copy URL from row
  await page.locator('table tbody tr').first().getByRole('button', { name: 'Copiar URL' }).click();
  await page.getByRole('menuitem', { name: /SRT/ }).click();
  await page.waitForSelector('text=URL copiada');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('clipboard has SRT url', clip === 'srt://demo.nodo.invalid:8890?streamid=read:canal63', clip);

  // detail
  await page.locator('table tbody tr', { hasText: 'canal63_720' }).click();
  await page.waitForSelector('h1:has-text("canal63_720")');
  const detail = (await page.locator('main').innerText()).replace(/\n/g,' ');
  check('detail shows tracks', /H264/.test(detail) && /1280×720/.test(detail) && /48 kHz/.test(detail));
  check('detail shows readers', /RTSP/.test(detail) && /WebRTC/.test(detail));
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-detail-desktop.png' });
  await page.getByRole('button', { name: 'Copiar URL' }).click();
  await page.waitForSelector('role=menuitem');
  const items = await page.getByRole('menuitem').allInnerTexts();
  check('5 protocols in menu', items.length === 5, items.join('|').replace(/\n/g,' '));
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-copymenu-desktop.png' });
  await page.keyboard.press('Escape');

  // dynamic channel detail + offline channel detail + unknown
  await page.goto(URL + '#/channels/canal65');
  await page.waitForSelector('text=Lo creó MediaMTX');
  check('dynamic note on canal65', true);
  await page.goto(URL + '#/channels/camara_patio');
  await page.waitForSelector('text=Sin origen conectado');
  check('offline configured channel detail', true);
  await page.goto(URL + '#/channels/nope');
  await page.waitForSelector('text=Canal no encontrado');
  check('unknown channel -> not found', true);

  // servers page shows demo
  await page.goto(URL + '#/servers');
  await page.waitForSelector('text=Datos simulados');
  check('servers page: demo card', true);
  check('no page errors (desktop)', errors.length === 0, errors.join('|'));

  // mobile
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  const merr = []; m.on('pageerror', e => merr.push(String(e)));
  await m.addInitScript(() => { localStorage.setItem('nodo:auth-skipped','1'); });
  await m.goto(URL);
  await m.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await m.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await m.waitForTimeout(3500);
  await m.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-dashboard-mobile.png' });
  check('mobile: card list, no table', (await m.locator('table').count()) === 0);
  check('mobile: no horizontal overflow', !(await m.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
  await m.getByRole('link', { name: /canal63$/ }).first().click();
  await m.waitForSelector('h1:has-text("canal63")');
  await m.waitForTimeout(500);
  await m.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-detail-mobile.png', fullPage: true });
  check('mobile detail: no overflow', !(await m.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
  check('no page errors (mobile)', merr.length === 0, merr.join('|'));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error('E2E ERROR', e.message.split('\n').slice(0,6).join('\n')); process.exit(1); });
