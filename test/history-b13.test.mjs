// 批次 13：历史趋势（环形缓冲 + /api/history 只读端点 + 落盘/恢复）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  blankHistory, normalizeHistory, createHistory,
  HISTORY_BUCKET_MS, HISTORY_MAX_SAMPLES, HISTORY_TICK_MS,
} from '../src/history.mjs';
import { createStore } from '../src/store.mjs';
import { keyIdOf } from '../src/log.mjs';
import { makeTmpDir, writeAccountFiles, startTestGateway, request } from './helpers.mjs';

const ALIVE = 'user_alive_account';

function seedState(dir, obj) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify(obj, null, 2));
}

// ── 1：首次 record 只建基线 ──────────────────────────────────────────
test('B13-1：首次 record() 只建基线，增量记 0（不把启动前的累计值算成爆发）', () => {
  let t = 0;
  const h = createHistory({ state: {}, now: () => t });
  const r = h.record({ requests: 999, errors: 29, tokens: 123456, available: 3, remaining: 12.5 });
  assert.equal(r.rolled, false, '首次调用不落定样本');
  assert.equal(h.samples().length, 0);
  // 同桶内即便 counters 不变，也不该冒出样本
  t += HISTORY_TICK_MS;
  h.record({ requests: 999, errors: 29, tokens: 123456, available: 3, remaining: 12.5 });
  assert.equal(h.samples().length, 0);
  // 跨桶：第一个桶定稿，桶内增量必须是 0（基线之后没有新增）
  t += HISTORY_BUCKET_MS;
  const r2 = h.record({ requests: 999, errors: 29, tokens: 123456, available: 3, remaining: 12.5 });
  assert.equal(r2.rolled, true);
  const [s] = h.samples();
  assert.equal(s.r, 0);
  assert.equal(s.e, 0);
  assert.equal(s.k, 0);
});

// ── 2：同桶增量累加 ──────────────────────────────────────────────────
test('B13-2：同一桶内多次 record() 的增量累加到同一个样本', () => {
  let t = 0;
  const h = createHistory({ state: {}, now: () => t });
  h.record({ requests: 0, errors: 0, tokens: 0, available: 1, remaining: 1 });
  t += HISTORY_TICK_MS;
  h.record({ requests: 10, errors: 2, tokens: 100, available: 1, remaining: 2 });
  t += HISTORY_TICK_MS;
  h.record({ requests: 25, errors: 3, tokens: 250, available: 0, remaining: 1.5 });
  t += HISTORY_BUCKET_MS;
  h.record({ requests: 25, errors: 3, tokens: 250, available: 0, remaining: 1.5 });

  const s = h.samples();
  assert.equal(s.length, 1);
  assert.equal(s[0].r, 25, '请求增量累加');
  assert.equal(s[0].e, 3, '错误增量累加');
  assert.equal(s[0].k, 250, 'token 增量累加');
  assert.equal(s[0].a, 0, 'available 取当次快照（非增量）');
  assert.equal(s[0].m, 1.5, 'remaining 取当次快照（非增量）');
});

// ── 3：跨桶产生新样本，旧样本不变 ────────────────────────────────────
test('B13-3：跨桶后旧样本定稿且数值不变，新样本另起', () => {
  let t = 0;
  const h = createHistory({ state: {}, now: () => t });
  h.record({ requests: 0 });
  t += HISTORY_TICK_MS;
  h.record({ requests: 10 });
  t = HISTORY_BUCKET_MS;
  h.record({ requests: 10 });   // 跨桶：计数器未变，上一个桶定稿
  const first = h.samples()[0];
  assert.deepEqual(first, { t: 0, r: 10, e: 0, k: 0, a: 0, m: 0 });
  const snapshot = JSON.stringify(first);

  t += HISTORY_TICK_MS;
  h.record({ requests: 30 });
  t += HISTORY_BUCKET_MS;
  h.record({ requests: 30 });   // 跨桶：第二个桶定稿

  const s = h.samples();
  assert.equal(s.length, 2);
  assert.equal(JSON.stringify(s[0]), snapshot, '已定稿样本不得被后续写入改动');
  assert.equal(s[1].r, 20);
  assert.notEqual(s[0].t, s[1].t);
});

// ── 4：计数器回退 → 增量为 0，不出现负数 ─────────────────────────────
test('B13-4：计数器回退（重启归零）时增量为 0，绝不出现负数', () => {
  let t = 0;
  const h = createHistory({ state: {}, now: () => t });
  h.record({ requests: 500, errors: 50, tokens: 9000 });   // 基线
  t += HISTORY_TICK_MS;
  h.record({ requests: 520, errors: 55, tokens: 9500 });   // 正常增量
  t = HISTORY_BUCKET_MS;
  h.record({ requests: 3, errors: 0, tokens: 5 });         // stats 归零 → 定稿正常桶
  t = 2 * HISTORY_BUCKET_MS;
  h.record({ requests: 3, errors: 0, tokens: 5 });         // 定稿回退后的桶

  const s = h.samples();
  assert.equal(s.length, 2);
  assert.equal(s[0].r, 20);   // 回退前：50 → 520 的增量
  assert.equal(s[1].r, 0);    // 回退：500 → 3，按 0 处理
  assert.equal(s[1].e, 0);
  assert.equal(s[1].k, 0);
  for (const sample of h.samples()) {
    for (const f of ['r', 'e', 'k', 'a', 'm']) {
      assert.ok(sample[f] >= 0, `${f} 不得为负: ${sample[f]}`);
    }
  }
});

// ── 5：环形上限 ──────────────────────────────────────────────────────
test('B13-5：超过 HISTORY_MAX_SAMPLES 丢最旧的，长度恒等于上限', () => {
  let t = 0;
  const h = createHistory({ state: {}, now: () => t });
  h.record({ requests: 0 });
  const rounds = HISTORY_MAX_SAMPLES + 25;
  for (let i = 0; i < rounds; i += 1) {
    t += HISTORY_BUCKET_MS;
    h.record({ requests: i + 1 });
  }
  const s = h.samples();
  assert.equal(s.length, HISTORY_MAX_SAMPLES);
  // 丢的是最旧的：剩下的时间戳严格递增且比第一个桶靠后
  assert.ok(s[0].t > 0, '最旧的样本已被丢弃');
  for (let i = 1; i < s.length; i += 1) assert.ok(s[i].t > s[i - 1].t);
});

// ── 6：samples() 返回拷贝 ────────────────────────────────────────────
test('B13-6：samples() 返回拷贝，改动返回值不影响内部状态', () => {
  let t = 0;
  const h = createHistory({ state: {}, now: () => t });
  h.record({ requests: 0 });
  t += HISTORY_TICK_MS;
  h.record({ requests: 7, errors: 2, tokens: 70, available: 4, remaining: 3.25 });
  t = HISTORY_BUCKET_MS;
  h.record({ requests: 7, errors: 2, tokens: 70, available: 4, remaining: 3.25 });

  const a = h.samples();
  a.push({ t: 999, r: 999, e: 999, k: 999, a: 999, m: 999 });
  a[0].r = 999;
  const b = h.samples();
  assert.equal(b.length, 1, '外部 push 不得改变内部长度');
  assert.equal(b[0].r, 7, '外部改元素不得改变内部值');
});

// ── 7：坏形状一律退化成空历史，不抛 ──────────────────────────────────
test('B13-7：normalizeHistory(坏形状) 一律退化成空历史且不抛', () => {
  const bad = [
    null, undefined, 42, 'x', [], true,
    { samples: 'nope' }, { samples: null }, { samples: {} },
    { samples: [null, 1, 'x'] },
    { samples: [{ t: 1 }] },                                  // 缺字段
    { samples: [{ t: 1, r: 1, e: 1, k: 1, a: 1 }] },          // 缺 m
    { samples: [{ t: NaN, r: 1, e: 1, k: 1, a: 1, m: 1 }] },  // t 非有限
    { samples: [{ t: 1, r: 'x', e: 1, k: 1, a: 1, m: 1 }] },  // 字段非数字
  ];
  for (const raw of bad) {
    let out;
    assert.doesNotThrow(() => { out = normalizeHistory(raw); }, `normalizeHistory 不得抛: ${JSON.stringify(raw)}`);
    assert.deepEqual(out, blankHistory(), `坏形状必须退化成空历史: ${JSON.stringify(raw)}`);
  }
  // 合法样本保留
  const ok = normalizeHistory({ samples: [{ t: 0, r: 1, e: 2, k: 3, a: 4, m: 5.5 }] });
  assert.deepEqual(ok.samples, [{ t: 0, r: 1, e: 2, k: 3, a: 4, m: 5.5 }]);
});

// ── 8：toJSON ↔ normalizeHistory 往返等价 ────────────────────────────
test('B13-8：toJSON() → normalizeHistory() 往返等价', () => {
  let t = 0;
  const state = {};
  const h = createHistory({ state, now: () => t });
  assert.deepEqual(state.history, blankHistory(), 'history 挂在 state 上');
  h.record({ requests: 0 });
  t += HISTORY_TICK_MS;
  h.record({ requests: 5, errors: 1, tokens: 9, available: 2, remaining: 1.239 });
  t = HISTORY_BUCKET_MS;
  h.record({ requests: 5, errors: 1, tokens: 9, available: 2, remaining: 1.239 });
  t += HISTORY_TICK_MS;
  h.record({ requests: 8, errors: 1, tokens: 20, available: 1, remaining: 2 });
  t += HISTORY_BUCKET_MS;
  h.record({ requests: 8, errors: 1, tokens: 20, available: 1, remaining: 2 });

  const json = h.toJSON();
  assert.ok(Array.isArray(json.samples));
  const back = normalizeHistory(json);
  assert.deepEqual(back.samples, h.samples());
  assert.deepEqual(normalizeHistory(JSON.parse(JSON.stringify(json))).samples, h.samples());
  // m 保留 2 位小数
  assert.equal(h.samples()[0].m, 1.24);
});

// ── 9：/api/history 形状 + 匿名可读 ──────────────────────────────────
test('B13-9：/api/history 返回 200，形状含 ok / bucketMs / tickMs / samples，匿名可读', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  // 匿名（无 cookie）与 /api/status 同档：200
  const r = await request(`${ctx.baseUrl}/api/history`);
  assert.equal(r.status, 200, '匿名必须可读（默认公开面板）');
  const data = JSON.parse(r.body);
  assert.equal(data.ok, true);
  assert.equal(data.bucketMs, HISTORY_BUCKET_MS);
  assert.equal(data.tickMs, HISTORY_TICK_MS);
  assert.ok(Array.isArray(data.samples));

  // 造一个样本（跨桶才会定稿）：直接落一个进环形数组，验证端点确实透出样本
  ctx.gateway.store.state.history.samples.push({ t: 1000, r: 7, e: 2, k: 100, a: 2, m: 10.5 });
  const data2 = JSON.parse((await request(`${ctx.baseUrl}/api/history`)).body);
  assert.equal(data2.samples.length, 1);
  assert.deepEqual(data2.samples[0], { t: 1000, r: 7, e: 2, k: 100, a: 2, m: 10.5 });
});

// ── 10：隐私：/api/history 不含任何账号身份字段 ──────────────────────
test('B13-10：/api/history 响应体不含账号名 / keyId / displayName / lastError 等身份字段', async (t) => {
  const ctx = await startTestGateway({ plans: { user_test_alpha: { authInvalid: true } } });
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();   // 制造运行期错误原文，确保「有身份可漏」的前提下仍然不漏

  ctx.gateway.store.state.history.samples.push({ t: 1, r: 1, e: 1, k: 1, a: 2, m: 0 });
  const body = (await request(`${ctx.baseUrl}/api/history`)).body;
  for (const needle of ['name', 'keyId', 'displayName', 'lastError', 'lastErrorAt', '账号A', '账号B', 'user_test', ctx.localKey]) {
    assert.ok(!body.includes(needle), `响应体不得出现「${needle}」: ${body}`);
  }
});

// ── 11：落盘 / 恢复带 history ────────────────────────────────────────
test('B13-11：saveState() 后 state.json 含 history，重新 loadState() 读回同样的样本数', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());

    let t = 0;
    const h = createHistory({ state: store.state, now: () => t });
    h.record({ requests: 0 });
    t += HISTORY_BUCKET_MS;
    h.record({ requests: 5, errors: 1, tokens: 50, available: 1, remaining: 4.5 });
    t += HISTORY_BUCKET_MS;
    h.record({ requests: 9, errors: 2, tokens: 90, available: 1, remaining: 3 });
    store.saveState();

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
    assert.ok(onDisk.history, 'state.json 必须含 history');
    assert.equal(onDisk.history.samples.length, 2);

    const store2 = createStore({ rootDir: dir });
    store2.loadState(store2.loadAccounts());
    assert.equal(store2.state.history.samples.length, 2, '重新加载读回同样的样本数');
    assert.deepEqual(store2.state.history.samples, h.samples());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 12：不回归：账号全在册时 loadState 不改动 state.json ─────────────
test('B13-12：loadState 在账号全在册时仍不改动 state.json（逐字节）', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const id = keyIdOf(ALIVE);
    // 老 state.json 故意不带 history 字段
    seedState(dir, {
      accounts: { [id]: { concurrency: 0 } },
      stats: { total: 5, errors: 0, totalTokens: 11, byAccount: { [id]: { requests: 5, errors: 0, tokens: 11 } } },
      pool: [id],
    });
    const before = fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8');

    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());

    assert.equal(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'), before, '不得多写一次盘');
    assert.equal(store.persistedAfterLoad, false);
    // history 只在内存里规范化成空历史
    assert.deepEqual(store.state.history, blankHistory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
