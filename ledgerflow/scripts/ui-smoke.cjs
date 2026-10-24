const { chromium } = require('playwright');
// Manual browser smoke test (desktop + mobile). Requires Playwright and a FRESH server: DATABASE_FILE=/tmp/x.db PORT=3111 npm start
const SP = process.argv[2] || '.'; const base = 'http://127.0.0.1:3111'; require('fs').mkdirSync(SP + '/ui', { recursive: true });
(async () => {
  const browser = await chromium.launch(); const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); }); page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const step = async (n) => { console.log('✓', n); };
  await page.goto(base); await page.getByLabel('Your name').fill('Dana Owner'); await page.getByLabel('Email').fill('dana@example.test'); await page.getByLabel('Password').fill('a-long-password-123'); await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Legal business name').fill('Dana Creative Inc.'); await page.getByLabel('Trading name (shown on documents)').fill('Dana Creative'); await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor(); await step('onboarding');
  await page.screenshot({ path: SP + '/ui/01-dashboard-empty.png' });
  // tax + settings
  await page.getByRole('link', { name: 'Settings' }).click(); await page.getByRole('tab', { name: 'Taxes' }).click(); await page.getByRole('button', { name: /\+ GST/ }).click(); await page.getByLabel('GST default').click(); await page.waitForTimeout(500); await step('tax configured');
  // import rate card via paste
  await page.getByRole('link', { name: 'Rate Card' }).click(); await page.getByRole('tab', { name: 'Import' }).click();
  const csv = 'Service,Category,Rate,Unit\nReel edit,Video,$120,reel\nLong-form edit,Video,$450,video\nSocial media management,Social,$600,month\nEvent coordination,Events,Custom quote,';
  await page.setInputFiles('input[type=file]', { name: 'rates.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Preview rows' }).click(); await page.getByLabel('Type 4 to confirm').waitFor(); await page.screenshot({ path: SP + '/ui/02-import-review.png' });
  await page.getByLabel('Type 4 to confirm').fill('4'); await page.getByRole('button', { name: 'Import 4 records' }).click(); await page.getByRole('heading', { name: 'Import finished' }).waitFor(); await step('rate card imported');
  await page.getByRole('button', { name: 'View rate card' }).click(); await page.screenshot({ path: SP + '/ui/03-ratecard.png' });
  // client
  await page.getByRole('link', { name: 'Clients' }).click(); await page.getByRole('button', { name: 'Add client' }).click(); await page.getByLabel('Name', { exact: true }).fill('Maple Events'); await page.getByLabel('Email', { exact: true }).fill('ap@maple.test'); await page.getByRole('button', { name: 'Save client' }).click(); await page.getByRole('heading', { name: 'Maple Events' }).waitFor(); await step('client');
  // quote
  await page.getByRole('link', { name: 'New quote' }).first().click(); await page.getByLabel('Search your rate card').fill('reel'); await page.getByRole('option', { name: /Reel edit/ }).click();
  await page.getByLabel('Quantity').first().fill('4'); await page.getByLabel('Search your rate card').fill('social'); await page.getByRole('option', { name: /Social media/ }).click();
  await page.getByLabel('Search your rate card').fill('event'); await page.getByRole('option', { name: /Event coordination/ }).click();
  await page.getByRole('button', { name: 'Issue quote' }).isDisabled().then((d) => console.log('issue disabled while price unconfirmed:', d));
  await page.getByLabel('Unit price').nth(2).fill('2500'); console.log('issue disabled (after render):', await page.getByRole('button', { name: 'Issue quote' }).isDisabled()); await page.getByRole('checkbox', { name: /price confirmed/ }).click();
  await page.waitForTimeout(600); await page.screenshot({ path: SP + '/ui/04-quote-editor.png', fullPage: true });
  const total = await page.locator('.totals .big').innerText(); console.log('editor total:', total.replace(/\s+/g, ' '));
  await page.getByRole('button', { name: 'Issue quote' }).click(); await page.getByRole('heading', { name: /Quote EST-0001/ }).waitFor(); await step('quote issued');
  await page.getByRole('button', { name: 'Record acceptance' }).click(); await page.getByLabel('Accepted by').fill('Sam'); await page.getByRole('button', { name: 'Record acceptance' }).last().click(); await page.getByText('Accepted').first().waitFor();
  await page.getByRole('button', { name: 'Convert to invoice (full)' }).click(); await page.getByRole('button', { name: 'Issue invoice' }).click(); await page.getByRole('heading', { name: /Invoice INV-0001/ }).waitFor(); await step('converted + invoice issued');
  await page.screenshot({ path: SP + '/ui/05-invoice.png', fullPage: true });
  await page.getByRole('button', { name: 'Record payment' }).first().click(); await page.getByLabel('Amount').fill('1000'); await page.getByRole('button', { name: 'Record payment' }).last().click(); await page.getByText('partially paid', { exact: false }).first().waitFor(); await step('partial payment');
  const v = await page.locator('.stat .v').allInnerTexts(); console.log('invoice stats:', v.join(' | '));
  await page.getByRole('button', { name: 'View PDF' }).click(); await page.locator('iframe.pdfframe').waitFor(); await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Dashboard' }).click(); await page.waitForTimeout(500); await page.screenshot({ path: SP + '/ui/06-dashboard.png', fullPage: true });
  // mobile
  const m = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true }); const mp = await m.newPage(); mp.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await mp.goto(base); await mp.getByLabel('Email').fill('dana@example.test'); await mp.getByLabel('Password').fill('a-long-password-123'); await mp.getByRole('button', { name: 'Sign in' }).click(); await mp.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await mp.screenshot({ path: SP + '/ui/m1-dashboard.png' }); await mp.getByRole('button', { name: /Menu/ }).click(); await mp.waitForTimeout(400); await mp.screenshot({ path: SP + '/ui/m2-menu.png' }); await mp.getByRole('link', { name: 'Invoices' }).click(); await mp.getByRole('link', { name: 'INV-0001' }).click(); await mp.getByRole('heading', { name: /INV-0001/ }).waitFor(); await mp.screenshot({ path: SP + '/ui/m3-invoice.png', fullPage: true });
  await mp.goto(base + '/invoices/new'); await mp.locator('select').first().selectOption({ label: 'Maple Events' }); await mp.getByLabel('Search your rate card').fill('long'); await mp.getByRole('option', { name: /Long-form/ }).click(); await mp.waitForTimeout(500); await mp.screenshot({ path: SP + '/ui/m4-editor.png', fullPage: true });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); console.log('mobile horizontal page overflow:', overflow);
  console.log('JS errors:', errors.length ? errors : 'none'); await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
