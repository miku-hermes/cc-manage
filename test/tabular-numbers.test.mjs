import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const hero = read('../panel/src/components/HeroCard.astro');
const kpi = read('../panel/src/components/KpiCard.astro');
const account = read('../panel/src/components/AccountCard.astro');
const admin = read('../panel/src/pages/admin.astro');
const trend = read('../panel/public/js/render-trend.js');

function assertClass(source, selector, className, description) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:id|data-f)="${escaped}"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*(?:id|data-f)="${escaped}"`).exec(source);
  assert.ok(match, `${description}: 找到节点 ${selector}`);
  assert.ok((match[1] || match[2]).split(/\s+/).includes(className), `${description}: ${selector} 必须带 ${className}`);
}

test('动态数值读数节点逐项启用 tabular-nums', () => {
  for (const [id, label] of [['balance', 'Hero 余额'], ['usage-gauge', 'Hero 环形百分比'], ['updated', 'Hero 更新时间'], ['bal-breakdown', 'Hero 额度构成摘要'], ['tokens', '累计 token']]) {
    assertClass(hero, id, 'tabular-nums', label);
  }
  assertClass(kpi, 'kpi-value', 'tabular-nums', 'KPI 数值模板');
  for (const [field, label] of [['usable-balance', '账号余额'], ['card-fresh', '账号新鲜度时间'], ['bar-5h-pct', '5h 百分比'], ['bar-week-pct', '周百分比'], ['bar-month-pct', '月百分比'], ['bar-5h-reset', '5h 重置时间'], ['bar-week-reset', '周重置时间'], ['bar-month-reset', '月重置时间'], ['credits-legend', '额度构成金额'], ['card-usage', '账号额度摘要']]) {
    assertClass(account, field, 'tabular-nums', label);
  }
  for (const [field, label] of [['bar-5h-pct', '后台 5h 百分比'], ['bar-week-pct', '后台周百分比'], ['bar-month-pct', '后台月百分比'], ['bar-5h-reset', '后台 5h 重置时间'], ['bar-week-reset', '后台周重置时间'], ['bar-month-reset', '后台月重置时间'], ['usable-balance', '后台余额'], ['credits', '后台额度金额'], ['status-reset', '后台状态重置时间']]) {
    assertClass(admin, field, 'tabular-nums', label);
  }
  assert.match(trend, /class="trend-stat-value[^"]*tabular-nums/, '趋势摘要数值使用等宽数字');
  assert.match(trend, /class="stat-value[^"]*tabular-nums/, '趋势统计卡数值使用等宽数字');
  assert.match(trend, /class="trend-summary tabular-nums/, '趋势摘要文字中的时间数字使用等宽数字');
  assert.match(trend, /class="stat-desc[^"]*tabular-nums/, '趋势卡描述中的估算读数使用等宽数字');
  assert.match(trend, /font-variant-numeric:tabular-nums/, 'ECharts HTML tooltip 使用等宽数字');
});
