// Phase 4b flows against the demo server and its simulated agent.
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
  const dialog = () => page.getByRole('dialog');

  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await page.getByRole('link', { name: 'Servicios' }).first().click();
  const card = page.getByTestId('service-deportes-hd');
  await card.waitFor();
  check('service card renders running', (await card.innerText()).includes('En marcha'));
  const text = await card.innerText();
  check('mapping shows output PIDs', ['256', '257', '258'].every((p) => text.includes(p)));
  await page.screenshot({ path: `${SHOTS}/services-list.png` });

  // manual switch keeps output PIDs and changes the input PIDs
  await card.getByRole('button', { name: 'Usar esta' }).click();
  await page.waitForSelector('text=Entrada cambiada');
  await page.waitForFunction(() => document.querySelector('[data-testid="service-deportes-hd"]')?.textContent?.includes('2000'));
  check('switch changes the input side of the map', true);

  // create: validation then success
  await page.getByRole('button', { name: 'Nuevo servicio' }).click();
  await dialog().waitFor();
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Escribe un nombre.');
  await dialog().getByLabel('Nombre').fill('Cámara Patio');
  await dialog().getByLabel('Dirección 1').first().fill('ftp://nope');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Ese tipo no se admite como entrada.');
  await dialog().getByLabel('Dirección 1').first().fill('udp://239.1.1.9:1234');
  await dialog().getByLabel('Dirección 1').last().fill('udp://239.2.2.2:1234');
  await page.screenshot({ path: `${SHOTS}/services-editor.png` });
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Servicio guardado');
  await page.getByTestId('service-camara-patio').waitFor();
  check('service created', true);

  // stop and start
  const patio = page.getByTestId('service-camara-patio');
  await patio.getByRole('button', { name: 'Detener' }).click();
  await patio.getByText('Detenido', { exact: true }).waitFor();
  await patio.getByRole('button', { name: 'Iniciar' }).click();
  await patio.getByText('En marcha', { exact: true }).waitFor();
  check('stop and start', true);

  // delete with confirmation
  await patio.getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
  await page.waitForSelector('text=Servicio eliminado');
  await patio.waitFor({ state: 'detached' });
  check('delete', true);

  // mobile layout: five tabs, no horizontal scroll
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  check('mobile no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${SHOTS}/services-mobile.png` });

  check('no page errors', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error(e); process.exit(1); });
