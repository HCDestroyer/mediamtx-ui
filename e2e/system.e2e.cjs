// System screen against the demo server and its simulated agent.
const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
const SHOTS = process.env.NODO_SHOTS || '/tmp';
const log = [];
const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  await ctx.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await page.getByRole('link', { name: 'Sistema' }).first().click();
  const recs = page.getByTestId('recommendations');
  await recs.waitFor();

  const udp = await page.getByTestId('finding-net-rmem-low').innerText();
  check('warning shows what, why and what to do', /Se están perdiendo paquetes UDP: 12/.test(udp) && /Por qué importa/.test(udp) && /continuidad/.test(udp) && /sysctl -w net\.core\.rmem_max/.test(udp));
  const dvb = await page.getByTestId('finding-dvb-driver-missing').innerText();
  check('DVB card without driver explains why the driver is needed', /TBS detectada sin controlador/.test(dvb) && /no se puede sintonizar/.test(dvb));
  const order = (await recs.locator('[data-testid^="finding-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))));
  check('warnings come before suggestions', order.indexOf('finding-gpu-none') > order.indexOf('finding-dvb-driver-missing') && order.indexOf('finding-cpu-governor') > order.indexOf('finding-net-rmem-low'), order.join(','));
  check('placeholders are filled', !(await recs.innerText()).includes('{'));

  const eth0 = await page.getByTestId('iface-eth0').innerText();
  check('physical interface shows state, speed and live rates', /Activa/.test(eth0) && /1 Gbps/.test(eth0) && /\d+(\.\d)?/.test(eth0));
  check('virtual interfaces are tucked away', (await page.getByTestId('iface-docker0').count()) === 1 && !(await page.getByTestId('iface-docker0').isVisible()));
  check('resources show CPU and memory meters', (await page.getByRole('meter').count()) === 2);
  check('hardware lists the TBS card', /TBS/.test(await page.innerText('main')));
  await page.screenshot({ path: `${SHOTS}/system.png`, fullPage: true });

  // rates change between polls
  const first = await page.getByTestId('iface-eth0').innerText();
  await page.waitForTimeout(2600);
  check('rates refresh by themselves', (await page.getByTestId('iface-eth0').innerText()) !== first);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(URL + '#/settings');
  await page.getByRole('link', { name: 'Abrir' }).nth(2).click();
  await recs.waitFor();
  check('mobile: reachable from Settings, no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${SHOTS}/system-mobile.png` });

  check('no page errors', errors.length === 0, errors.join('|'));
  console.log(log.join('\n'));
  await browser.close();
  process.exit(log.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(log.join('\n')); console.error('E2E ERROR', e.message.split('\n').slice(0, 6).join('\n')); process.exit(1); });
