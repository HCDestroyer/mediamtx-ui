// Additional MediaMTX configuration screen against the demo server and its simulated agent.
const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
const SHOTS = process.env.NODO_SHOTS || '/tmp';
const log = [];
const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await page.getByRole('link', { name: 'Configuración' }).first().click();
  const editor = page.getByLabel('Configuración adicional (YAML)');
  await editor.waitFor();
  check('shows base and output files', (await page.innerText('main')).includes('/etc/mediamtx/mediamtx.yml'));
  const apply = page.getByRole('button', { name: 'Aplicar', exact: true });
  check('apply is disabled until something changes', await apply.isDisabled());

  // invalid: nothing is applied and the reason is shown
  await editor.fill('badParam: 1\n');
  await page.getByRole('button', { name: 'Validar' }).click();
  await page.waitForSelector('text=No es válida');
  check('validation error shown', (await page.innerText('main')).includes('badParam'));
  await apply.click();
  await page.waitForSelector('text=No es válida');
  check('an invalid configuration is not applied', (await page.innerText('main')).includes('Cambios sin aplicar'));
  await page.screenshot({ path: `${SHOTS}/config-invalid.png` });

  // valid: preview, apply, undo
  await editor.fill('paths:\n  canal_nuevo:\n    source: publisher\n');
  await page.getByRole('button', { name: 'Validar' }).click();
  await page.waitForSelector('text=Es válida');
  await apply.click();
  await page.waitForSelector('text=Configuración aplicada');
  await page.waitForSelector('text=Aplicada');
  check('valid configuration applied', true);

  await editor.fill('logLevel: debug\n');
  await apply.click();
  await page.waitForSelector('text=Aplicada');
  await page.getByRole('button', { name: 'Deshacer el último cambio' }).click();
  await page.waitForSelector('text=Se volvió a la configuración anterior');
  check('undo restores the previous text', (await editor.inputValue()).includes('canal_nuevo'));

  // reachable from Settings on mobile
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(URL + '#/settings');
  await page.getByRole('link', { name: 'Abrir' }).click();
  await editor.waitFor();
  check('mobile: reachable from Settings, no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${SHOTS}/config-mobile.png` });

  check('no page errors', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error(e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
