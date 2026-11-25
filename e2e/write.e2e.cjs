// Phase 3 flows against the demo server: create/edit/delete channels, transcode, multistream, YAML export.
const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
const SHOTS = process.env.NODO_SHOTS || '/tmp';
const log = [];
const check = (n, ok, x = '') => log.push(`${ok ? 'PASS' : 'FAIL'} ${n} ${x}`);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const list = async () => (await page.locator('table tbody tr td:first-child').allInnerTexts()).map((t) => t.split('\n')[0]);
  const dialog = () => page.getByRole('dialog');

  await page.goto(URL);
  await page.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await page.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await page.waitForSelector('text=canal63_720');

  // ---- create: validation ----
  await page.getByRole('button', { name: 'Nuevo canal', exact: true }).first().click();
  await dialog().waitFor();
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Escribe un nombre.');
  await dialog().getByLabel('Nombre').fill('mi canal');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=El nombre no es válido.');
  await dialog().getByLabel('Nombre').fill('canal63');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Ya existe un canal con ese nombre.');
  check('name validation (empty, invalid, duplicate)', true);

  // source URL + SRT passphrase + recording validation
  await dialog().getByLabel('Nombre').fill('camara_nueva');
  await dialog().getByRole('button', { name: /Alguien publica/ }).click();
  await page.getByRole('option', { name: /Extraer de una dirección/ }).click();
  await dialog().getByLabel('Dirección', { exact: true }).fill('ftp://nope');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=/La dirección no es válida/');
  await dialog().getByLabel('Dirección', { exact: true }).fill('srt://192.168.1.60:9000?streamid=read:cam');
  await dialog().getByLabel('Passphrase del origen SRT').fill('short');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Debe tener entre 10 y 79 caracteres.');
  check('source URL and SRT passphrase (min 10) validation', true);
  await dialog().getByRole('button', { name: 'Generar' }).first().click();
  const generated = await dialog().getByLabel('Passphrase del origen SRT').inputValue();
  check('generate passphrase', generated.length === 24 && !/[0O1lI]/.test(generated), generated.length + ' chars');

  // recording
  await dialog().getByText('Grabar el canal').click();
  await dialog().getByLabel('Duración de cada archivo').fill('soon');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Usa un número y una unidad: 30m, 1h, 7d.');
  await dialog().getByLabel('Duración de cada archivo').fill('30m');
  check('recording duration validation', true);

  // YAML view: masked, then revealed
  await dialog().getByRole('button', { name: 'Vista YAML' }).click();
  const yaml = await dialog().locator('pre').innerText();
  check('YAML view shows the channel with secrets masked', /camara_nueva:/.test(yaml) && /recordSegmentDuration: 30m/.test(yaml) && !yaml.includes(generated) && /••••/.test(yaml), yaml.replace(/\n/g, ' | ').slice(0, 160));
  await page.screenshot({ path: SHOTS + '/p3-editor-yaml-desktop.png' });
  await dialog().getByRole('button', { name: 'Mostrar claves' }).click();
  check('YAML reveals secrets on request', (await dialog().locator('pre').innerText()).includes(encodeURIComponent(generated)));

  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Canal creado');
  await page.waitForSelector('text=camara_nueva', { timeout: 8000 });
  check('created channel appears in the list', (await list()).includes('camara_nueva'), (await list()).join(','));

  // unsaved banner
  await page.waitForSelector('text=no están en mediamtx.yml');
  check('unsaved-changes banner appears', true);
  await page.screenshot({ path: SHOTS + '/p3-banner-desktop.png' });

  // ---- edit ----
  await page.locator('table tbody tr', { hasText: 'canal63' }).first().click();
  await page.waitForSelector('h1:has-text("canal63")');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await dialog().getByLabel('Nombre').waitFor();
  check('edit: name locked', await dialog().getByLabel('Nombre').isDisabled());
  const hookValue = await dialog().getByLabel('Comando al iniciar el canal').inputValue();
  check('edit: hook command loaded from server (runOnOnline)', /scale=-2:720/.test(hookValue));
  check('edit: SRT passphrase split out of the source URL', (await dialog().getByLabel('Dirección', { exact: true }).inputValue()) === 'srt://127.0.0.1:3333');
  await dialog().getByLabel('Passphrase para leer').fill('lectura-1234567');
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Canal guardado');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  check('edit: saved value persisted', (await dialog().getByLabel('Passphrase para leer').inputValue()) === 'lectura-1234567');
  await dialog().getByRole('button', { name: 'Cancelar' }).click();

  // ---- multistream ----
  await page.getByRole('button', { name: 'Agregar destino' }).click();
  await dialog().getByRole('button', { name: 'Agregar', exact: true }).click();
  await page.waitForSelector('text=Escribe la clave de transmisión.');
  await dialog().getByLabel('Clave de transmisión').fill('abcd-efgh-1234');
  await dialog().getByRole('button', { name: 'Agregar', exact: true }).click();
  await page.waitForSelector('text=Destino agregado');
  const fwd = (await page.locator('main').innerText());
  check('multistream: destination listed with the key masked', /rtmps:\/\/a\.rtmps\.youtube\.com:443\/live2#••••/.test(fwd) && !fwd.includes('abcd-efgh'), '');
  await page.waitForSelector('text=Enviando');
  check('multistream: shows forwarding state', true);
  await page.screenshot({ path: SHOTS + '/p3-detail-desktop.png' });
  await page.getByRole('button', { name: 'Quitar', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Quitar destino' }).getByRole('button', { name: 'Quitar' }).click();
  await page.waitForSelector('text=Este canal no se envía a ningún destino.');
  check('multistream: remove asks for confirmation and removes', true);

  // ---- transcode wizard from the detail of the new channel ----
  await page.goto(URL + '#/channels/camara_nueva');
  await page.waitForSelector('h1:has-text("camara_nueva")');
  await page.getByRole('button', { name: 'Transcodificar' }).click();
  await dialog().getByRole('button', { name: /Resolución/ }).click();
  await page.getByRole('option', { name: /480p/ }).click();
  const cmd = await dialog().locator('pre').innerText();
  check('wizard: command preview follows the resolution', /scale=-2:480/.test(cmd) && /-i rtsp:\/\/127\.0\.0\.1:8554\/camara_nueva /.test(cmd) && /camara_nueva_480$/.test(cmd.trim()), cmd.slice(0, 80));
  await page.screenshot({ path: SHOTS + '/p3-wizard-desktop.png' });
  await dialog().getByRole('button', { name: 'Crear salida 480p' }).click();
  await page.waitForSelector('text=Salida camara_nueva_480 creada');
  await page.goto(URL + '#/');
  await page.waitForSelector('text=camara_nueva_480', { timeout: 10000 });
  check('wizard: destination channel created and live', (await list()).includes('camara_nueva_480'));

  // ---- dynamic channel: edit creates its configuration ----
  await page.goto(URL + '#/channels/canal65');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.waitForSelector('text=Este canal lo creó MediaMTX');
  check('dynamic channel: editor warns and creates configuration', true);
  await dialog().getByRole('button', { name: 'Guardar' }).click();
  await dialog().waitFor({ state: 'hidden', timeout: 10000 });
  check('dynamic channel: saving is not rejected as a duplicate', true);
  await page.waitForFunction(() => !document.body.innerText.includes('Dinámico'), null, { timeout: 10000 });
  check('dynamic channel becomes configured after saving', true);

  // ---- delete ----
  await page.goto(URL + '#/channels/prueba_hls');
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  const del = page.getByRole('alertdialog', { name: 'Eliminar canal' });
  await del.waitFor();
  check('delete asks for confirmation', (await del.innerText()).includes('prueba_hls'));
  await del.getByRole('button', { name: 'Eliminar' }).click();
  await page.waitForSelector('text=Canal eliminado');
  await page.waitForSelector('h1:has-text("Canales")');
  await page.waitForTimeout(600);
  check('deleted channel is gone from the list', !(await list()).includes('prueba_hls'));

  // ---- export YAML ----
  await page.getByRole('button', { name: 'Exportar YAML' }).click();
  await dialog().locator('pre').waitFor();
  const exported = await dialog().locator('pre').innerText();
  check('export: paths section, header and changed channels', /^# Exportado por Nodo/.test(exported) && /paths:/.test(exported) && /camara_nueva_480:/.test(exported) && /canal63:/.test(exported) && !/prueba_hls/.test(exported));
  check('export: secrets masked on screen', !exported.includes('demo-passphrase-1') && /••••/.test(exported));
  await page.screenshot({ path: SHOTS + '/p3-export-desktop.png' });
  await dialog().getByRole('button', { name: 'Copiar', exact: true }).click();
  await page.waitForSelector('text=YAML copiado');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('export: copied YAML has the real values', clip.includes('demo-passphrase-1') && clip.includes('lectura-1234567'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ya lo guardé' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('no están en mediamtx.yml'));
  check('banner can be dismissed', true);
  check('no page errors (desktop)', errors.length === 0, errors.join('|'));

  // ---- mobile ----
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await m.addInitScript(() => localStorage.setItem('nodo:auth-skipped', '1'));
  const merr = []; m.on('pageerror', (e) => merr.push(String(e)));
  await m.goto(URL);
  await m.getByRole('button', { name: 'Probar con datos de ejemplo' }).click();
  await m.waitForSelector('text=/3 de 5 en vivo/', { timeout: 10000 });
  await m.getByRole('button', { name: 'Nuevo canal', exact: true }).last().click();
  await m.getByRole('dialog').waitFor();
  await m.waitForTimeout(600);
  await m.screenshot({ path: SHOTS + '/p3-editor-mobile.png' });
  check('mobile: editor opens as a bottom drawer without page overflow', !(await m.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
  check('no page errors (mobile)', merr.length === 0, merr.join('|'));

  console.log(log.join('\n'));
  await browser.close();
})().catch((e) => { console.error(log.join('\n')); console.error('E2E ERROR', e.message.split('\n').slice(0, 8).join('\n')); process.exit(1); });
