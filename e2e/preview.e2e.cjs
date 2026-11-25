// Channel preview against the demo server (a test pattern goes through the same <video> path).
const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
const SHOTS = process.env.NODO_SHOTS || '/tmp';
const log = [];
const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await page.goto(URL + '#/channels/canal63');
  const video = page.getByTestId('preview-video');
  await video.waitFor();

  check('nothing plays until asked', await video.evaluate((v) => v.srcObject === null));
  await page.getByRole('button', { name: 'Ver vista previa' }).click();
  await page.waitForSelector('text=Reproduciendo por WebRTC');
  await page.waitForFunction(() => { const v = document.querySelector('[data-testid="preview-video"]'); return v && v.srcObject && v.videoWidth > 0; });
  check('WebRTC preview plays', true);
  check('says it is muted and a demo image', /Sin sonido/.test(await page.innerText('main')) && /Imagen de prueba/.test(await page.innerText('main')));
  await page.screenshot({ path: `${SHOTS}/preview.png` });

  // switching mode is blocked while playing; stop first
  check('mode buttons are locked while playing', await page.getByRole('button', { name: 'HLS', exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Detener' }).click();
  await page.waitForSelector('text=Ver vista previa');
  check('stop releases the video', await video.evaluate((v) => v.srcObject === null));
  await page.getByRole('button', { name: 'HLS', exact: true }).click();
  check('mode switch selected', (await page.getByRole('button', { name: 'HLS', exact: true }).getAttribute('aria-pressed')) === 'true');
  await page.getByRole('button', { name: 'Ver vista previa' }).click();
  await page.waitForSelector('text=Reproduciendo por HLS');
  check('HLS preview plays', true);

  // leaving the page stops it (no leaked stream)
  await page.goto(URL + '#/channels/canal65');
  await page.getByTestId('preview-video').waitFor();
  check('a new channel starts idle', await page.getByTestId('preview-video').evaluate((v) => v.srcObject === null));

  // an offline channel cannot be previewed
  await page.goto(URL + '#/channels/camara_patio');
  await page.getByTestId('preview-video').waitFor();
  check('offline channel: preview disabled and explained', (await page.getByRole('button', { name: 'Ver vista previa' }).isDisabled()) && /no está en vivo/.test(await page.innerText('main')));

  // mobile
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(URL + '#/channels/canal63');
  await page.getByRole('button', { name: 'Ver vista previa' }).click();
  await page.waitForSelector('text=Reproduciendo por');
  check('mobile: no horizontal scroll while playing', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${SHOTS}/preview-mobile.png` });

  check('no page errors', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error('E2E ERROR', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
