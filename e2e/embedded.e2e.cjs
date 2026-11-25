// Runs against a nodo-agent binary built with scripts/build-agent.sh: the panel and the API share one origin.
// NODO_URL=http://127.0.0.1:9980/ NODO_AGENT_TOKEN=... node e2e/embedded.e2e.cjs
const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:9980/';
const TOKEN = process.env.NODO_AGENT_TOKEN || 'tok123';
const log = [];
const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('requestfailed', (r) => { if (!r.url().includes(':9997')) errors.push('REQFAIL ' + r.url()); }); // :9997 is a MediaMTX that does not run in this test
  await page.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  await page.goto(URL + '#/servers');
  await page.getByRole('button', { name: 'Agregar servidor', exact: true }).last().click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await dialog.getByLabel('Nombre').fill('Este equipo');
  await dialog.getByLabel('LAN').fill('127.0.0.1:9997');
  await dialog.getByLabel('Dirección del agente').fill(new globalThis.URL(URL).host);

  await dialog.getByLabel('Token del agente').fill('wrong');
  await dialog.getByRole('button', { name: 'Probar agente' }).click();
  await page.waitForSelector('text=Token incorrecto');
  check('wrong token is reported', true);

  await dialog.getByLabel('Token del agente').fill(TOKEN);
  await dialog.getByRole('button', { name: 'Probar agente' }).click();
  await page.waitForSelector('text=/Agente .* conectado/');
  check('same-origin agent answers with the right token', true);
  await dialog.getByRole('button', { name: 'Guardar' }).click();

  await page.goto(URL + '#/services');
  await page.waitForSelector('text=Todavía no hay servicios', { timeout: 10000 });
  check('services screen reads the embedded agent', true);

  await page.getByRole('button', { name: 'Nuevo servicio' }).click();
  await dialog.waitFor();
  await dialog.getByLabel('Nombre').fill('Prueba');
  await dialog.getByLabel('Dirección 1').first().fill('udp://239.9.9.9:5000');
  await dialog.getByLabel('Dirección 1').last().fill('udp://239.8.8.8:5000');
  await dialog.getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Servicio guardado');
  await page.getByTestId('service-prueba').waitFor();
  check('service created through the real agent', true);
  await page.getByTestId('service-prueba').getByRole('button', { name: 'Eliminar' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
  await page.waitForSelector('text=Servicio eliminado');
  check('service deleted', true);

  check('no page errors or failed requests', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error(e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
