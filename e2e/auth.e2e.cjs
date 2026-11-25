const { chromium } = require('playwright');
const URL = process.env.NODO_URL || 'http://127.0.0.1:4173/';
const log = [];
(async () => {
  const browser = await chromium.launch();
  const check = (n, ok, x='') => log.push(`${ok?'PASS':'FAIL'} ${n} ${x}`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.clock.install();
  await page.goto(URL);

  // ---- first run ----
  await page.waitForSelector('text=Crea tu acceso');
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-setup-desktop.png' });
  await page.getByRole('button', { name: 'Crear y entrar' }).click();
  await page.waitForSelector('text=Escribe un usuario.');
  await page.waitForSelector('text=Usa al menos 8 caracteres.');
  check('setup validates empty form', true);
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=new-password]', 'correct horse battery');
  await page.fill('input[name=repeat-password]', 'different');
  await page.getByRole('button', { name: 'Crear y entrar' }).click();
  await page.waitForSelector('text=Las contraseñas no coinciden.');
  check('setup detects mismatch', true);
  await page.fill('input[name=repeat-password]', 'correct horse battery');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Crear y entrar' }).click();
  await page.waitForSelector('text=Agrega tu primer servidor', { timeout: 20000 });
  check('account created, panel opens', true, `${Date.now()-t0} ms`);

  // ---- save a server with a secret ----
  await page.goto(URL + '#/servers');
  await page.getByRole('button', { name: 'Agregar servidor', exact: true }).first().click();
  await page.fill('input[name=name]', 'Casa');
  await page.fill('input[name=endpoint-lan]', '192.168.1.20:9997');
  await page.fill('input[name=username]', 'panel');
  await page.fill('input[name=password]', 'S3CRET-VALUE');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await page.waitForSelector('text=Casa');
  let raw = await page.evaluate(() => localStorage.getItem('nodo:servers'));
  check('stored servers are encrypted', raw.startsWith('enc:v1:') && !raw.includes('S3CRET') && !raw.includes('Casa'), raw.slice(0, 24));
  const meta = await page.evaluate(() => JSON.parse(localStorage.getItem('nodo:auth')));
  check('account record has no password', meta.username === 'admin' && !JSON.stringify(meta).includes('correct horse') && meta.kdf === 'argon2id');

  // ---- reload -> locked ----
  await page.reload();
  await page.waitForSelector('text=Panel bloqueado');
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-lock-desktop.png' });
  check('reload locks the panel', true);
  check('username prefilled', (await page.inputValue('input[name=username]')) === 'admin');
  const visible = await page.locator('body').innerText();
  check('no server data while locked', !visible.includes('Casa') && !visible.includes('Canales'));

  // wrong password
  await page.fill('input[name=password]', 'nope nope nope');
  await page.getByRole('button', { name: 'Desbloquear' }).click();
  await page.waitForSelector('text=Usuario o contraseña incorrectos.');
  await page.waitForSelector('text=/Puedes reintentar en \\d+ s/');
  check('wrong password shows error and wait', true);
  const disabled = await page.getByRole('button', { name: 'Desbloquear' }).isDisabled();
  check('unlock disabled during back-off', disabled);
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-lock-error-desktop.png' });
  const rawAfterFail = await page.evaluate(() => localStorage.getItem('nodo:servers'));
  check('failed attempt leaves data untouched', rawAfterFail === raw);

  // back-off survives a reload
  await page.reload();
  await page.waitForSelector('text=Panel bloqueado');
  await page.fill('input[name=password]', 'correct horse battery');
  check('back-off persisted across reload', await page.getByRole('button', { name: 'Desbloquear' }).isDisabled());
  await page.clock.fastForward(5000);
  await page.waitForFunction(() => !document.querySelector('button[type=submit]').disabled, null, { timeout: 5000 });
  await page.getByRole('button', { name: 'Desbloquear' }).click();
  await page.waitForSelector('text=Casa', { timeout: 20000 }).catch(() => {});
  await page.goto(URL + '#/servers');
  await page.waitForSelector('text=Casa');
  check('correct password restores servers', true);

  // ---- lock now, auto lock ----
  await page.goto(URL + '#/settings');
  await page.waitForSelector('text=Seguridad');
  await page.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-settings-security-desktop.png' });
  await page.getByRole('button', { name: 'Bloquear ahora' }).click();
  await page.waitForSelector('text=Panel bloqueado');
  const rawLocked = await page.evaluate(() => localStorage.getItem('nodo:servers'));
  check('lock now keeps encrypted data intact', rawLocked === raw);
  await page.clock.fastForward(4000);
  await page.fill('input[name=password]', 'correct horse battery');
  await page.getByRole('button', { name: 'Desbloquear' }).click();
  await page.waitForSelector('text=Seguridad', { timeout: 20000 });
  check('unlock again', true);

  // auto-lock after 15 min of inactivity
  await page.clock.fastForward(16 * 60 * 1000);
  await page.waitForSelector('text=Panel bloqueado', { timeout: 5000 });
  check('auto-lock after 15 min idle', true);

  // ---- forgot password ----
  await page.getByRole('button', { name: 'Olvidé mi contraseña' }).click();
  await page.waitForSelector('text=Borrar el acceso y los servidores');
  await page.getByRole('button', { name: 'Borrar todo' }).click();
  await page.waitForSelector('text=Crea tu acceso');
  const wiped = await page.evaluate(() => [localStorage.getItem('nodo:servers'), localStorage.getItem('nodo:auth')]);
  check('forgot password wipes servers and account', wiped[1] === null && (wiped[0] === null || !wiped[0].includes('enc:v1:')), JSON.stringify(wiped).slice(0, 80));
  check('no page errors', errors.length === 0, errors.join('|'));

  // ---- skip, then enable / change / disable from settings ----
  await page.getByRole('button', { name: 'Ahora no' }).click();
  await page.goto(URL + '#/settings');
  await page.waitForSelector('text=Sin protección');
  await page.getByRole('button', { name: 'Activar protección' }).click();
  await page.fill('input[name=username]', 'root');
  await page.fill('input[name=new-password]', 'first password 1');
  await page.fill('input[name=repeat-password]', 'first password 1');
  await page.getByRole('button', { name: 'Crear y entrar' }).click();
  await page.waitForSelector('text=Protegido', { timeout: 20000 });
  check('enable from settings', true);
  await page.getByRole('button', { name: 'Cambiar usuario o contraseña' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.locator('input[type=password]').first().fill('wrong current');
  await dlg.locator('input[name=new-password]').fill('second password 2');
  await dlg.locator('input[name=repeat-password]').fill('second password 2');
  await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
  await page.waitForSelector('text=La contraseña actual no es correcta.', { timeout: 20000 });
  check('change rejects wrong current password', true);
  await dlg.locator('input[type=password]').first().fill('first password 1');
  await dlg.getByRole('button', { name: 'Guardar cambios' }).click();
  await page.waitForSelector('text=Acceso actualizado', { timeout: 20000 });
  check('change credentials', true);
  await page.getByRole('button', { name: 'Desactivar protección' }).click();
  await page.getByRole('dialog').locator('input[type=password]').fill('second password 2');
  await page.getByRole('dialog').getByRole('button', { name: 'Desactivar' }).click();
  await page.waitForSelector('text=Sin protección', { timeout: 20000 });
  check('disable protection', (await page.evaluate(() => localStorage.getItem('nodo:auth'))) === null);

  // ---- mobile ----
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await m.goto(URL);
  await m.waitForSelector('text=Crea tu acceso');
  await m.screenshot({ path: (process.env.NODO_SHOTS || '/tmp') + '/p2-setup-mobile.png', fullPage: true });
  check('mobile setup: no overflow', !(await m.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)));
  console.log(log.join('\n'));
  await browser.close();
})().catch(e => { console.error(log.join('\n')); console.error('E2E ERROR', e.message.split('\n').slice(0,8).join('\n')); process.exit(1); });
