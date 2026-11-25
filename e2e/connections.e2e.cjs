// Connections screen against the demo server: list, filter, kick.
const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
const SHOTS = process.env.NODO_SHOTS || '/tmp';
const log = [];
const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await page.getByRole('link', { name: 'Conexiones' }).first().click();
  await page.getByTestId('conn-rtmp:f6').waitFor();
  const rows = () => page.locator('[data-testid^="conn-"]').count();
  check('lists every protocol of the live channels', (await rows()) === 9, String(await rows()));
  check('publisher is told apart from readers', /Publica/.test(await page.getByTestId('conn-rtmp:f6').innerText()) && /Mira/.test(await page.getByTestId('conn-hls:g7').innerText()));
  const srt = await page.getByTestId('conn-srt:h8').innerText();
  check('SRT shows RTT and loss', /RTT \d+ ms · pérdida [\d.]+ %/.test(srt), srt.replace(/\n/g, ' '));
  check('RTSP shows its transport', /\b(tcp|udp)\b/.test(await page.getByTestId('conn-rtsp:b2').innerText()));
  await page.screenshot({ path: `${SHOTS}/connections.png` });

  // rates appear after the second poll
  await page.waitForFunction(() => /\d+,\d/.test(document.querySelector('[data-testid="conn-hls:g7"]')?.textContent || ''), null, { timeout: 8000 });
  check('rates appear after the second poll', true);

  // filter by protocol and search
  await page.getByRole('button', { name: 'Protocolo' }).click();
  await page.getByRole('option', { name: 'SRT' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="conn-"]').length === 1);
  check('protocol filter', (await rows()) === 1);
  await page.getByRole('button', { name: 'Protocolo' }).click();
  await page.getByRole('option', { name: 'Todos' }).click();
  await page.getByPlaceholder('Buscar por canal, dirección o usuario').fill('canal65');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="conn-"]').length === 3);
  check('search by channel', (await rows()) === 3);
  await page.getByPlaceholder('Buscar por canal, dirección o usuario').fill('zzz');
  await page.waitForSelector('text=Ninguna conexión coincide');
  await page.getByPlaceholder('Buscar por canal, dirección o usuario').fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="conn-"]').length === 9);

  // kick a reader: confirmation, then it is gone
  await page.getByTestId('conn-rtsp:d4').getByRole('button', { name: 'Expulsar' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'Expulsar conexión' });
  check('confirmation names the protocol and client', /RTSP/.test(await dlg.innerText()) && /192\.168\.1\./.test(await dlg.innerText()));
  check('no publisher warning for a reader', !/se caerá/.test(await dlg.innerText()));
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  check('cancel keeps the connection', (await rows()) === 9);
  await page.getByTestId('conn-rtsp:d4').getByRole('button', { name: 'Expulsar' }).click();
  await dlg.getByRole('button', { name: 'Expulsar', exact: true }).click();
  await page.waitForSelector('text=Conexión expulsada');
  await page.getByTestId('conn-rtsp:d4').waitFor({ state: 'detached' });
  check('kicked reader disappears', (await rows()) === 8);

  // kick the publisher of a dynamic channel: warns, and the channel goes away
  await page.getByTestId('conn-rtmp:f6').getByRole('button', { name: 'Expulsar' }).click();
  check('publisher kick warns that the channel will drop', /canal65: el canal se caerá/.test(await dlg.innerText()));
  await dlg.getByRole('button', { name: 'Expulsar', exact: true }).click();
  await page.waitForSelector('text=Conexión expulsada');
  await page.waitForFunction(() => !document.querySelector('[data-testid="conn-rtmp:f6"]') && !document.querySelector('[data-testid="conn-hls:g7"]'), null, { timeout: 8000 });
  check('channel without publisher loses its readers from the list', true);

  // mobile: stacked cards, no horizontal scroll
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  check('mobile: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('mobile: kick still reachable', await page.getByTestId('conn-rtsp:b2').getByRole('button', { name: 'Expulsar' }).isVisible());
  await page.screenshot({ path: `${SHOTS}/connections-mobile.png` });

  check('no page errors', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error('E2E ERROR', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
