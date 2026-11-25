// Binaries screen against the demo server and its simulated agent.
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
  await page.getByRole('link', { name: 'Binarios' }).first().click();
  await page.getByTestId('version-v1.21.4').waitFor();
  check('current version is marked in use', (await page.getByTestId('version-v1.21.4').innerText()).includes('En uso'));
  check('process shows running', (await page.getByTestId('process-card').innerText()).includes('En marcha'));
  const ffmpeg = await page.getByTestId('tool-ffmpeg').innerText();
  const tsduck = await page.getByTestId('tool-tsduck').innerText();
  check('tools: found one explains why, missing one explains why and how to install', ffmpeg.includes('Instalada') && /multistream/.test(ffmpeg) && tsduck.includes('No instalada') && /DVB/.test(tsduck) && /tsduck\.io/.test(tsduck));
  await page.screenshot({ path: `${SHOTS}/binaries.png`, fullPage: true });

  // newest release: check, install, switch (the process restarts on it)
  await page.getByRole('button', { name: 'Buscar la última' }).click();
  await page.waitForSelector('text=Última versión: v1.21.5');
  await page.getByRole('button', { name: 'Instalar v1.21.5' }).click();
  await page.getByTestId('version-v1.21.5').waitFor();
  check('latest version installed', true);
  await page.getByTestId('version-v1.21.5').getByRole('button', { name: 'Usar' }).click();
  await page.waitForSelector('text=Versión cambiada');
  await page.waitForFunction(() => document.querySelector('[data-testid="version-v1.21.5"]')?.textContent?.includes('En uso'));
  await page.getByText('Registro de MediaMTX').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="process-card"] pre')?.textContent?.includes('started v1.21.5'));
  check('switching versions restarts MediaMTX on the new one', true);

  // other version: validation, then failure message from the agent
  await page.getByLabel('Otra versión').fill('1.2');
  await page.getByRole('button', { name: 'Instalar', exact: true }).click();
  await page.waitForSelector('text=Escribe una versión como v1.21.4.');
  await page.getByLabel('Otra versión').fill('v9.9.9');
  await page.getByRole('button', { name: 'Instalar', exact: true }).click();
  await page.waitForSelector('text=download failed: status 404');
  check('agent error is shown', true);

  // delete an old version with confirmation; the one in use cannot be deleted from the UI
  check('no delete button for the version in use', (await page.getByTestId('version-v1.21.5').getByRole('button').count()) === 0);
  await page.getByRole('button', { name: 'Eliminar v1.20.2' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar', exact: true }).click();
  await page.waitForSelector('text=Versión eliminada');
  await page.getByTestId('version-v1.20.2').waitFor({ state: 'detached' });
  check('version removed', true);

  // stop and start
  await page.getByRole('button', { name: 'Detener' }).click();
  await page.getByTestId('process-card').getByText('Detenido', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Iniciar con Nodo' }).click();
  await page.getByTestId('process-card').getByText('En marcha', { exact: true }).waitFor();
  check('stop and start', true);

  // mobile: reachable from Settings, no horizontal scroll
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(URL + '#/settings');
  await page.getByRole('link', { name: 'Abrir' }).last().click();
  await page.getByTestId('process-card').waitFor();
  check('mobile: reachable from Settings, no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${SHOTS}/binaries-mobile.png` });

  check('no page errors', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error('E2E ERROR', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
