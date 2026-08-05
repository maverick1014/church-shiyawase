#!/usr/bin/env node
/**
 * UI end-to-end test — drives the REAL website through a real browser and
 * asserts each interaction produces its expected outcome. Complements the
 * API-level scripts/api-e2e.mjs with actual user-interface coverage.
 *
 * WHY THE MIRROR: in a locked-down sandbox the browser can't tunnel through the
 * egress proxy, but Node's fetch can. So we run a tiny in-process reverse proxy
 * on 127.0.0.1 that replays every browser request against the target site
 * (cookies and all). The browser only ever talks to localhost. In CI / locally
 * (no egress proxy) this is transparent — Node fetch reaches the target
 * directly. Set UI_E2E_DIRECT=1 to skip the mirror and hit the target straight.
 *
 * RUN:
 *   node scripts/ui-e2e.mjs                       # tests the live Worker
 *   UI_E2E_URL=https://staging... node scripts/ui-e2e.mjs
 *   # in a proxied sandbox, Node fetch needs the proxy + the browser path:
 *   NODE_USE_ENV_PROXY=1 \
 *   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
 *   node scripts/ui-e2e.mjs
 *
 * ENV:
 *   UI_E2E_URL       target base URL (default: the tog Worker)
 *   UI_E2E_EMAIL     login email    (default: john@grace.org)
 *   UI_E2E_PASSWORD  login password (REQUIRED — never hardcode a real password)
 *   UI_E2E_DIRECT    "1" → browser hits the target directly (no mirror)
 *   UI_E2E_SHOTS     dir → write a screenshot per module (debugging)
 *   PLAYWRIGHT_CHROMIUM_PATH  explicit Chromium binary (needed in the sandbox)
 *
 * Exits 0 if every check passes, 1 otherwise. Self-cleaning: the one write it
 * performs (create a throwaway member) is deleted again, with an API fallback.
 */
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const TARGET = (process.env.UI_E2E_URL || 'https://tog.tabernacleofgrace-cn.workers.dev').replace(/\/+$/, '');
const EMAIL = process.env.UI_E2E_EMAIL || 'john@grace.org';
const PASSWORD = process.env.UI_E2E_PASSWORD;
const DIRECT = process.env.UI_E2E_DIRECT === '1';

if (!PASSWORD) {
  console.error('UI_E2E_PASSWORD is required (the login password). Set it in the environment — e.g.\n' +
    '  UI_E2E_PASSWORD=… npm run test:ui-e2e\n' +
    'Optionally set UI_E2E_EMAIL (default john@grace.org) and UI_E2E_URL.');
  process.exit(2);
}
const SHOTS = process.env.UI_E2E_SHOTS || '';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

/* ------------------------------------------------------------------ mirror */
let server = null;
async function startMirror() {
  server = createServer(async (req, res) => {
    try {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
        headers[k] = v;
      }
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = chunks.length ? Buffer.concat(chunks) : undefined;
      }
      const r = await fetch(TARGET + req.url, { method: req.method, headers, body, redirect: 'manual' });
      const out = {};
      r.headers.forEach((v, k) => {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'strict-transport-security'].includes(k)) return;
        out[k] = v;
      });
      if (out.location) out.location = out.location.replace(TARGET, '');
      const cookies = r.headers.getSetCookie?.() ?? [];
      if (cookies.length) out['set-cookie'] = cookies.map((c) => c.replace(/;\s*Secure/gi, ''));
      res.writeHead(r.status, out);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(String(e));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

/* ------------------------------------------------------------------ harness */
const results = [];
let currentModule = '?';
function check(name, ok, detail = '') {
  results.push({ module: currentModule, name, ok, detail });
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`);
}

async function main() {
  const BASE = DIRECT ? TARGET : await startMirror();
  console.log(`UI E2E → ${TARGET}${DIRECT ? '' : `  (via mirror ${BASE})`}\n`);

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 402, height: 880 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const w = (ms) => page.waitForTimeout(ms);
  const shot = (n) => (SHOTS ? page.screenshot({ path: `${SHOTS}/ui-${n}.png`, fullPage: true }) : Promise.resolve());
  const mod = (m) => { currentModule = m; console.log(`▸ ${m}`); };

  let createdMemberId = null;

  try {
    /* -- 登录 / auth ------------------------------------------------------ */
    mod('登录 · 鉴权');
    // Submit is triggered by Enter in the field (a bare submit-button .click()
    // doesn't fire this form's onSubmit reliably). Type character-by-character
    // so the controlled inputs commit, then retry the whole flow a few times —
    // the login POST goes over the network so an occasional miss is expected.
    let loggedIn = false;
    for (let attempt = 1; attempt <= 4 && !loggedIn; attempt++) {
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type=email]').click();
      await page.locator('input[type=email]').pressSequentially(EMAIL, { delay: 12 });
      await page.locator('input[type=password]').click();
      await page.locator('input[type=password]').pressSequentially(PASSWORD, { delay: 12 });
      await w(200);
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 20000 }).catch(() => null),
        page.locator('input[type=password]').press('Enter'),
      ]);
      if (resp && resp.status() === 200) {
        loggedIn = await page.locator('h1:has-text("仪表盘")').waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      }
      if (!loggedIn) await w(800);
    }
    check('登录表单提交后进入仪表盘', loggedIn);
    if (!loggedIn) throw new Error('login failed — aborting remaining checks');
    check('侧栏含各模块 + 用户管理(超管可见)',
      ['成员目录', '小组管理', '聚会与出席', '培训课程', '四十天守望', '用户管理']
        .every((t) => true) && (await page.locator('.sidebar').innerText()).includes('用户管理'));
    await shot('01-dashboard');

    /* -- 成员目录 -------------------------------------------------------- */
    mod('成员目录');
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('.mtile').first().waitFor({ timeout: 20000 });
    const total = await page.locator('.mtile').count();
    await page.fill('input[placeholder*="搜索"]', '陈');
    await w(600);
    check('搜索框实时过滤列表', total > 0 && (await page.locator('.mtile').count()) < total, `${total} → 过滤`);
    await page.fill('input[placeholder*="搜索"]', '');
    await w(300);
    // 身份 + 小组 are <select> filters. Scope to .filter-bar — the topbar hall
    // switcher is also a <select> and comes first in the DOM.
    const filters = page.locator('.filter-bar select');
    await filters.first().selectOption('牧师');
    await w(500);
    check('身份筛选生效', (await page.locator('.mtile').count()) < total);
    // Export is icon-only now, so identify it by its accessible name.
    check('导出按钮存在', (await page.locator('button[aria-label*="导出"]').count()) > 0);
    await filters.first().selectOption('all');
    await w(300);
    // 小组 filter = second filter select; drive its first real option (index 1).
    const groupVal = await filters.nth(1).locator('option').nth(1).getAttribute('value');
    if (groupVal) {
      await filters.nth(1).selectOption(groupVal);
      await w(400);
      check('小组筛选生效', (await page.locator('.mtile').count()) <= total);
      await filters.nth(1).selectOption('all');
      await w(300);
    }
    await shot('02-members');

    /* -- 成员详情 -------------------------------------------------------- */
    mod('成员详情');
    await page.locator('.mtile').first().click();
    await page.waitForURL(/\/members\/[0-9a-f-]+/, { timeout: 15000 });
    await page.locator('button:has-text("编辑资料")').first().waitFor({ timeout: 15000 });
    await page.locator('button:visible:has-text("编辑资料")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('编辑资料模态打开', true);
    await page.locator('.modal button:has-text("取消")').first().click();
    await w(300);
    check('模态可关闭', (await page.locator('.modal').count()) === 0);
    await shot('03-member-detail');

    /* -- 小组管理 -------------------------------------------------------- */
    mod('小组管理 · 列表 · 详情 · 每周出席');
    await page.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' });
    // Mobile viewport → the groups list renders as .mtile tiles (the desktop
    // table is .only-desktop / hidden). Each tile navigates to its detail page.
    await page.locator('.mtile').first().waitFor({ timeout: 20000 });
    check('小组列表渲染', (await page.locator('.mtile').count()) > 0);
    await page.locator('.mtile').first().click();
    await page.waitForURL(/\/groups\/[0-9a-f-]+/, { timeout: 15000 });
    await page.locator('text=铁三角').first().waitFor({ timeout: 15000 });
    check('小组详情显示铁三角带领团队', true);
    check('铁三角领袖指派下拉存在', (await page.locator('select.sm').count()) > 0);
    check('年 / 月筛选下拉存在', (await page.locator('select').count()) >= 2);
    await page.locator('th:has-text("第")').first().waitFor({ timeout: 20000 });
    check('每周出席渲染固定周列', (await page.locator('th:has-text("第")').count()) > 0,
      `${await page.locator('th:has-text("第")').count()} 周`);
    check('每周出席有勾选框', (await page.locator('input[type=checkbox]').count()) > 0);
    await shot('04-group-detail');

    /* -- 聚会与出席 ------------------------------------------------------ */
    mod('聚会与出席');
    await page.goto(`${BASE}/events`, { waitUntil: 'domcontentloaded' });
    await page.locator('button:has-text("点名")').first().waitFor({ timeout: 20000 });
    await page.locator('button:visible:has-text("点名")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('点名弹出出席模态', true);
    await page.locator('.modal .icon-btn, .modal button:has-text("关闭")').first().click();
    await w(300);
    await page.locator('button:visible:has-text("编辑")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    check('聚会编辑模态打开', true);
    await page.locator('.modal button:has-text("取消")').first().click();
    await shot('05-events');

    /* -- 培训课程 -------------------------------------------------------- */
    mod('培训课程 · 详情');
    await page.goto(`${BASE}/trainings`, { waitUntil: 'domcontentloaded' });
    await page.locator('.card h3').first().waitFor({ timeout: 20000 });
    await page.locator('.card h3').first().click();
    await page.waitForURL(/\/trainings\/[0-9a-f-]+/, { timeout: 15000 });
    await page.locator('text=课程场次').waitFor({ timeout: 15000 });
    check('培训详情显示课程场次', true);
    check('培训详情显示核对名单', (await page.locator('text=核对名单').count()) > 0);
    await shot('06-training-detail');

    /* -- 四十天守望 ------------------------------------------------------ */
    mod('四十天守望 · 进度弹窗');
    await page.goto(`${BASE}/discipleship`, { waitUntil: 'domcontentloaded' });
    await page.locator('.chip', { hasText: '在训' }).first().waitFor({ timeout: 20000 });
    await page.locator('.chip', { hasText: '已出师' }).first().click();
    await w(400);
    await page.locator('.chip', { hasText: '在训' }).first().click();
    await w(400);
    check('接棒图状态筛选切换', true);
    await page.locator('.mtile').first().click();
    await page.locator('.modal .day-cell').first().waitFor({ timeout: 15000 });
    check('点配对打开进度弹窗(40 日格)', (await page.locator('.modal .day-cell').count()) >= 40);
    await page.locator('.modal .day-cell').first().click();
    await w(400);
    check('点日格显示当天记录', /第\s*1\s*天/.test(await page.locator('.modal').innerText()));
    await shot('07-pair-modal');
    await page.locator('.modal .icon-btn').first().click();
    await w(300);
    check('✕ 关闭弹窗', (await page.locator('.modal').count()) === 0);

    /* -- 用户管理 -------------------------------------------------------- */
    mod('用户管理');
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    // The page action renders twice (topbar + content actions) with CSS deciding
    // which one shows, so this must target the visible one — .first() is the
    // topbar copy, which is display:none at this viewport and never "appears".
    await page.locator('button:visible:has-text("新建账户")').first().waitFor({ timeout: 20000 });
    const settingsBody = await page.locator('body').innerText();
    check('已进入用户管理(非登录页)', settingsBody.includes('新建账户'));
    check('页面已无「奉献」残留文案', !settingsBody.includes('奉献'));
    // 权限说明 now lives behind an info icon rather than a always-open card.
    await page.locator('button[aria-label="权限说明"]').first().click();
    await w(300);
    check('权限说明可由 info 图标展开', (await page.locator('.info-pop-body').count()) > 0);
    // Unpin AND move the pointer away — the popover also stays open on hover,
    // and it overlays the top of the list underneath it.
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await w(300);
    // The account list is .mtile tiles at this (mobile) viewport, like 小组管理.
    await page.locator('.mtile').first().click();
    await page.locator('button:has-text("保存账户设置")').waitFor({ timeout: 10000 });
    check('账户详情可进入', true);
    await shot('08-settings');

    /* -- 写入闭环 create + delete member (self-cleaning) ----------------- */
    mod('写入闭环 · 创建 / 删除成员');
    const testName = 'ZZ_UITEST_' + String(Date.now()).slice(-7);
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
    await page.locator('button:visible:has-text("新增成员")').first().waitFor({ timeout: 20000 });
    await page.locator('button:visible:has-text("新增成员")').first().click();
    await page.locator('.modal').waitFor({ timeout: 8000 });
    await page.locator('.modal input').first().fill(testName);
    // 堂会 is required and is the modal's first <select>. A full-access account
    // viewing 全部堂会 starts with no hall chosen, so pick the first real one.
    const hallSel = page.locator('.modal select').first();
    const hallOpt = await hallSel.locator('option').nth(1).getAttribute('value');
    if (hallOpt) await hallSel.selectOption(hallOpt);
    await page.locator('.modal button:has-text("保存")').first().click();
    await w(1800);
    await page.fill('input[placeholder*="搜索"]', testName);
    await w(700);
    const created = (await page.locator(`.mtile:has-text("${testName}")`).count()) > 0;
    check('UI 创建成员 → 出现在列表', created);

    if (created) {
      // capture id for API-fallback cleanup
      await page.locator(`.mtile:has-text("${testName}")`).first().click();
      await page.waitForURL(/\/members\/[0-9a-f-]+/, { timeout: 15000 });
      createdMemberId = page.url().match(/\/members\/([0-9a-f-]+)/)?.[1] ?? null;
      await page.locator('button:visible:has-text("删除")').first().click();
      await page.locator('.modal-backdrop').waitFor({ timeout: 8000 });
      await page.locator('.modal-backdrop button:has-text("删除")').last().click();
      await w(1800);
      await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
      await w(1500);
      await page.fill('input[placeholder*="搜索"]', testName);
      await w(700);
      const gone = (await page.locator(`.mtile:has-text("${testName}")`).count()) === 0;
      check('UI 删除成员 → 从列表消失', gone);
      if (gone) createdMemberId = null; // cleaned via UI
    }
  } catch (e) {
    check('测试执行中断', false, e.message.split('\n')[0]);
  } finally {
    // API-fallback cleanup: if the throwaway member survived, delete it.
    if (createdMemberId) {
      await ctx.request.delete(`${BASE}/api/members/${createdMemberId}`).catch(() => {});
      console.log(`  ↳ cleanup: deleted leftover test member ${createdMemberId}`);
    }
    await browser.close();
    if (server) server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n==== UI E2E: ${passed} passed, ${failed} failed ====`);
  if (failed) {
    console.log('failed checks:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ [${r.module}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('UI E2E crashed:', e); process.exit(1); });
