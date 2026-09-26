// 批次 25 D：后台 /admin 的 <progress> 可访问性。
//   缺陷：value 直接写原始浮点（64.98198366666666…），且没有可访问名 —— 读屏既念不出
//   是哪个账号的哪个窗口，也念不准百分比。改法：value 取到 1 位小数；补 aria-label
//   （账号 · 窗口 · 额度使用）与 aria-valuetext（pctText 格式化后的「65.0%」，与可视文本同串）。
// 本文件用既有 DOM 垫片跑 admin 内联脚本，对产物 HTML 直接断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript } from './helpers.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('../panel/src/pages/admin.astro', import.meta.url), 'utf8');
const RENDER_SRC = fs.readFileSync(new URL('../panel/public/js/render-accounts-table.js', import.meta.url), 'utf8');

const WINDOWS = [['bar-5h', '5 小时窗口'], ['bar-week', '本周窗口'], ['bar-month', '本月周期']];

function quota(pcts) {
  const w = (percent, cap) => ({ used: 1, cap, percent, usedRatio: percent / 100, resetAt: 0 });
  return {
    ok: true, displayName: '显示名', plan: null, remaining: 9.9, credits: {}, usage: {}, percent: {},
    fetchedAt: 0,
    fiveHour: w(pcts[0], 3), weekly: w(pcts[1], 6), monthly: w(pcts[2], 10),
  };
}
function account(name, pcts) {
  return {
    keyId: name + '-id', keyPrefix: 'user_test', name, enabled: true, available: true,
    creditsExhausted: false, exhausted: null, paused: false, pausedUntil: null,
    rateLimited: false, authInvalid: false, lastError: null, lastQuota: quota(pcts),
  };
}
function parseAttrs(text) {
  const out = {};
  for (const m of String(text).matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// 三个账号，百分比刻意带长尾小数（复现实测里的裸浮点）。
const ACCOUNTS = [
  account('主号', [64.98198366666666, 0.6637924, 51.609574646666665]),
  account('副号1', [12.3456789, 99.999999, 0]),
  account('副号2', [70.5, 33.333333333, 100]),
];

async function renderAdmin() {
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext(`state.accounts = ${JSON.stringify(ACCOUNTS)}; renderAccounts();`, page);
  return shim.el('accounts').innerHTML;
}

test('B25-D：/admin 每个 <progress> 都有可访问名 + aria-valuetext，且值 = 可视文本、不再是裸浮点', async () => {
  const out = await renderAdmin();

  // ① 不再出现 6 位以上小数的裸浮点（旧实现把 raw percent 写进 value）。
  assert.doesNotMatch(out, /\d+\.\d{6,}/, '产物里不得再有 64.98198366666666 这类裸浮点');
  assert.match(out, /\d+\.\d%/, '百分比仍以 1 位小数呈现');

  // ② 每个 <progress> 都有 value（≤1 位小数）、aria-label、aria-valuetext。
  const tags = [...out.matchAll(/<progress\b([^>]*)>/g)].map((m) => parseAttrs(m[1]));
  assert.equal(tags.length, ACCOUNTS.length * 3, '3 账号 × 3 窗口 = 9 个进度条');
  for (const a of tags) {
    assert.ok(a['aria-label'] && a['aria-label'].length > 0, '每个进度条都要有可访问名');
    assert.ok(a['aria-valuetext'], '每个进度条都要有 aria-valuetext');
    assert.match(a['aria-valuetext'], /^\d+\.\d%$/, 'aria-valuetext 必须是格式化后的百分比：' + a['aria-valuetext']);
    assert.match(a.value, /^\d+(\.\d)?$/, 'value 最多 1 位小数：' + a.value);
  }

  // ③ 逐行逐窗口：aria-label 指向「哪个账号的哪个窗口」；aria-valuetext 与可视 .qbar-pct 逐字符一致。
  // 垫片序列化会丢掉 data-f，所以按结构定位：每行 = <tr>，行内每个 .qbar 块含一个 progress + 一个 .qbar-pct。
  const rows = out.split(/<tr\b/).slice(1);
  assert.equal(rows.length, ACCOUNTS.length, '每个账号一行');
  let checked = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const name = ACCOUNTS[i].name;
    const bars = row.split('class="qbar ').slice(1);
    assert.equal(bars.length, 3, name + ' 应有 3 个额度条');
    for (let k = 0; k < bars.length; k += 1) {
      const [slot, label] = WINDOWS[k];
      const pm = /<progress([^>]*)><\/progress>/.exec(bars[k]);
      const tm = /class="qbar-pct[^"]*">([^<]*)</.exec(bars[k]);
      assert.ok(pm && tm, name + ' 的 ' + slot + ' 应渲染出进度条与百分比');
      const attrs = parseAttrs(pm[1]);
      const visible = tm[1];
      assert.match(visible, /^\d+\.\d%$/, '可视百分比是 1 位小数：' + visible);
      assert.equal(attrs['aria-valuetext'], visible, 'aria-valuetext 必须与可视文本一致（' + name + ' ' + slot + '）');
      assert.equal(Number(attrs.value), Number.parseFloat(visible), 'value 数值 = 可视百分比（' + name + ' ' + slot + '）');
      assert.ok(attrs['aria-label'].includes(name), '可访问名要含账号名 ' + name + '：' + attrs['aria-label']);
      assert.ok(attrs['aria-label'].includes(label), '可访问名要含窗口 ' + label + '：' + attrs['aria-label']);
      checked += 1;
    }
  }
  assert.equal(checked, ACCOUNTS.length * 3, '9 条进度条全部核对');
});

test('B25-D-变异鉴别力：可访问名与 aria-valuetext 缺一不可，value 不得回到裸浮点', async () => {
  // 源码层面确认三处写入都在（去掉任一处 → 上面的断言必红）。
  assert.match(RENDER_SRC, /setAttribute\('aria-label',/, 'fillQuotaBar 必须写 aria-label');
  assert.match(RENDER_SRC, /setAttribute\('aria-valuetext',\s*pctText\(pct\)\)/, 'aria-valuetext 必须用 pctText');
  assert.match(RENDER_SRC, /Math\.round\(clamped \* 10\) \/ 10/, 'value 必须取到 1 位小数');
  // 旧行为（raw percent → value）已不存在。
  assert.doesNotMatch(RENDER_SRC, /setAttribute\('value', String\(Math\.max\(0, Math\.min\(100, pct === null \? 0 : pct\)\)\)\)/,
    '不得回退成把原始浮点写进 value');
});
