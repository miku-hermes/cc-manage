// 批次 16 审计回归：H3(store) / H2(scheduler) / H1(scheduler) / M1(config)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createScheduler, quotaWindows, QUOTA_RECHECK_FAIL_OPEN_AT, FAIL_OPEN_GRACE_MS,
} from '../src/scheduler.mjs';
import { createStore, normalizeAccounts } from '../src/store.mjs';
import { keyIdOf } from '../src/log.mjs';
import { loadConfig, configWarnings, DEFAULTS } from '../src/config.mjs';

const A_KEY = 'user_audit_b16_aaaaaa';

function makeState() {
  return { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };
}
function makeAccounts(list) {
  return normalizeAccounts(list);
}
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manage-b16-'));
}
function seedState(dir, obj) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify(obj, null, 2));
}
function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
}
function captureLog() {
  const lines = [];
  return { lines, log: { warn: (m) => lines.push(`WARN ${m}`), info: (m) => lines.push(`INFO ${m}`) } };
}

// ───────────────────────── H3：损坏重建不得写 pool: [] ─────────────────────────
test('H3①：state.json 损坏重建后读回文件，pool 不是空数组（null / 缺失）', () => {
  const dir = makeTmpDir();
  try {
    const store = createStore({ rootDir: dir });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(store.stateFile, '{"accounts": {"kid-A": {"paused');
    store.loadState([{ keyId: keyIdOf(A_KEY), name: 'A' }]);
    const onDisk = readState(dir);
    assert.equal(Array.isArray(onDisk.pool), false, `pool 不得是数组，实际 ${JSON.stringify(onDisk.pool)}`);
    assert.ok(onDisk.pool === null || onDisk.pool === undefined, 'pool 应为 null 或缺失');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3②：pool 未知（null）+ 三标记齐全 → loadState 后 authInvalid/pausedUntil/creditsExhausted 全部保留', () => {
  const dir = makeTmpDir();
  try {
    const id = keyIdOf(A_KEY);
    const pausedUntil = Date.now() + 3600_000;
    seedState(dir, {
      accounts: { [id]: { pausedUntil, authInvalid: true, authInvalidReason: '旧 401', creditsExhausted: { at: 1, remaining: 0, message: '余额不足' } } },
      stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} },
      pool: null,
    });
    const store = createStore({ rootDir: dir });
    store.loadState([{ keyId: id, name: 'A' }]);
    const rt = store.state.accounts[id] ?? {};
    assert.equal(rt.pausedUntil, pausedUntil, 'pool 未知时不得清 pausedUntil');
    assert.equal(rt.authInvalid, true, 'pool 未知时不得清 authInvalid');
    assert.ok(rt.creditsExhausted, 'pool 未知时不得清 creditsExhausted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H3③对照：pool 明确含该 keyId → 标记保留；明确不含 → 标记清除（B4 原语义不变）', () => {
  const dirIn = makeTmpDir();
  const dirOut = makeTmpDir();
  try {
    const id = keyIdOf(A_KEY);
    const other = keyIdOf('user_audit_b16_other');
    const base = { accounts: { [id]: { authInvalid: true, pausedUntil: Date.now() + 3600_000 } }, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };

    seedState(dirIn, { ...base, pool: [id] });
    const sIn = createStore({ rootDir: dirIn });
    sIn.loadState([{ keyId: id, name: 'A' }]);
    assert.equal(sIn.state.accounts[id].authInvalid, true, 'pool 明确含该 keyId → 必须保留');

    seedState(dirOut, { ...base, pool: [other] });
    const sOut = createStore({ rootDir: dirOut });
    sOut.loadState([{ keyId: id, name: 'A' }]);
    assert.equal(sOut.state.accounts[id], undefined, 'pool 明确不含 → 视为新账号，必须清除');
  } finally {
    fs.rmSync(dirIn, { recursive: true, force: true });
    fs.rmSync(dirOut, { recursive: true, force: true });
  }
});

// ───────────────────────── H2：上游点名未知窗口名也必须判不可用 ─────────────────────────
test('H2①：exceededWindow 为 daily / 5小时额度 / usage / 未知串 → isAvailable 必须为 false', () => {
  for (const name of ['daily', '5小时额度', 'usage', 'totally-unknown-window']) {
    const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
    const s = createScheduler({ accounts, state: makeState() });
    s.recordQuota(accounts[0], { ok: true, weekly: { used: 0, cap: 100 }, remaining: 0.5, exceededWindow: name });
    assert.equal(s.isAvailable(accounts[0]), false, `点名 "${name}" 必须判不可用（不能放回池子吃 429）`);
    assert.equal(s.select().account, null, `点名 "${name}" 不得被选中`);
  }
});

test('H2①补充：未知窗口名保留在占位窗口的 label 里，便于排障', () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], { ok: true, weekly: { used: 0, cap: 100 }, exceededWindow: 'daily' });
  const ws = quotaWindows(s.runtime(accounts[0]).lastQuota);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].exceeded, true);
  assert.equal(ws[0].label, 'daily', '必须保留上游原始窗口名');
});

test('H2②：5小时额度 / 5 小时 / 5h 都能匹配到 5 小时窗口（不产生未知占位重复）', () => {
  for (const name of ['5小时额度', '5 小时', '5h', 'fiveHour']) {
    const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
    const s = createScheduler({ accounts, state: makeState() });
    s.recordQuota(accounts[0], {
      ok: true,
      fiveHour: { used: 5, cap: 10, usedRatio: 0.5 },
      exceededWindow: name,
    });
    const ws = quotaWindows(s.runtime(accounts[0]).lastQuota);
    assert.equal(ws.length, 1, `点名 "${name}" 时窗口集合不得重复：${JSON.stringify(ws)}`);
    assert.equal(ws[0].exceeded, true);
    assert.equal(ws[0].used, 5, `点名 "${name}" 应命中 5 小时窗口`);
    assert.equal(s.isAvailable(accounts[0]), false);
  }
});

test('H2③：点名 fiveHour 时窗口集合无重复条目', () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], {
    ok: true,
    fiveHour: { used: 1, cap: 2, usedRatio: 0.5 },
    exceededWindow: 'fiveHour',
  });
  const ws = quotaWindows(s.runtime(accounts[0]).lastQuota);
  const usedCap = ws.map((w) => `${w.used}/${w.cap}`);
  assert.equal(ws.length, 1, `不得出现同一 used/cap 两次：${JSON.stringify(usedCap)}`);
});

test('H2④：已知窗口的正常判定不回归', () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }, { name: 'B', key: 'user_audit_b16_bbbbbb' }]);
  const s = createScheduler({ accounts, state: makeState() });
  // 上游点名 weekly + weekly.exceeded（权威标记）
  s.recordQuota(accounts[0], { ok: true, fiveHour: { used: 0, cap: 3, usedRatio: 0 }, weekly: { used: 5.5, cap: 6, usedRatio: 0.917, exceeded: true }, exceededWindow: 'weekly' });
  assert.equal(s.isAvailable(accounts[0]), false);
  // 健康账号仍可用
  s.recordQuota(accounts[1], { ok: true, fiveHour: { used: 0, cap: 100, usedRatio: 0 }, weekly: { used: 0, cap: 100, usedRatio: 0 } });
  assert.equal(s.isAvailable(accounts[1]), true);
  assert.equal(s.select().account.name, 'B');
});

// ───────────────────────── H1：fail-open 必须真正放行 ─────────────────────────
async function driveFailOpen(s, account, now0) {
  let now = now0;
  let recovered = [];
  for (let i = 0; i < QUOTA_RECHECK_FAIL_OPEN_AT; i++) {
    recovered = await s.recheckPaused({ fetchQuota: async () => { throw new Error('upstream down'); }, now });
    now = (s.runtime(account).pausedUntil ?? now) + 1;
  }
  return { recovered, now };
}

test('H1①：场景 C（旧快照耗尽 + creditsExhausted）fail-open 后 isAvailable=true 且 select 能选中', async () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], { ok: true, fiveHour: { used: 100, cap: 100, usedRatio: 1 }, weekly: { used: 0, cap: 100, usedRatio: 0 } });
  s.markCreditsExhausted(accounts[0], '额度已用完');
  const now0 = Date.now();
  s.runtime(accounts[0]).pausedUntil = now0 - 1;

  const { recovered, now } = await driveFailOpen(s, accounts[0], now0);

  assert.deepEqual(recovered, [keyIdOf(A_KEY)], '真正回到池子的账号要进 recovered');
  assert.equal(s.runtime(accounts[0]).pausedUntil, null);
  assert.equal(s.isAvailable(accounts[0], now), true, 'fail-open 必须真正放行，而不是死代码');
  assert.equal(s.select({ now }).account?.keyId, keyIdOf(A_KEY), 'select 必须能选中它');
  assert.equal(s.remainingRatio(accounts[0], now), 0.5, '宽限期内按中性比例参与调度');
});

test('H1②：场景 A（旧快照健康）行为不回归', async () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], { ok: true, fiveHour: { used: 1, cap: 100, usedRatio: 0.01 }, weekly: { used: 0, cap: 100, usedRatio: 0 } });
  const now0 = Date.now();
  s.runtime(accounts[0]).pausedUntil = now0 - 1;

  const { recovered, now } = await driveFailOpen(s, accounts[0], now0);
  assert.deepEqual(recovered, [keyIdOf(A_KEY)]);
  assert.equal(s.runtime(accounts[0]).pausedUntil, null);
  assert.equal(s.runtime(accounts[0]).quotaRecheckFails, 0);
  assert.equal(s.isAvailable(accounts[0], now), true);
});

test('H1③：宽限期过后恢复按旧快照判定（耗尽 → false）', async () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], { ok: true, fiveHour: { used: 100, cap: 100, usedRatio: 1 }, weekly: { used: 0, cap: 100, usedRatio: 0 } });
  const now0 = Date.now();
  s.runtime(accounts[0]).pausedUntil = now0 - 1;

  const { now } = await driveFailOpen(s, accounts[0], now0);
  assert.equal(s.isAvailable(accounts[0], now), true);
  const graceEnd = s.runtime(accounts[0]).failOpenUntil;
  assert.ok(Number.isFinite(graceEnd), `failOpenUntil 应为有限数，实际 ${graceEnd}`);
  assert.ok(graceEnd > now, '宽限期应在未来');
  assert.equal(s.isAvailable(accounts[0], graceEnd + 1), false, '宽限过后必须恢复原判');
});

test('H1④：宽限期也救不回来的账号不得被 recovered / 日志谎报为已恢复', async () => {
  const accounts = makeAccounts([{ name: 'A', key: A_KEY }]);
  const { lines, log } = captureLog();
  const s = createScheduler({ accounts, state: makeState(), log });
  s.recordQuota(accounts[0], { ok: true, fiveHour: { used: 100, cap: 100, usedRatio: 1 }, weekly: { used: 0, cap: 100, usedRatio: 0 } });
  s.markAuthInvalid(accounts[0], '上游 401');
  const now0 = Date.now();
  s.runtime(accounts[0]).pausedUntil = now0 - 1;

  const { recovered, now } = await driveFailOpen(s, accounts[0], now0);

  assert.deepEqual(recovered, [], 'authInvalid 的账号没有真正回到池子，不得进 recovered');
  assert.equal(s.isAvailable(accounts[0], now), false);
  assert.equal(lines.some((l) => l.includes('强制放行')), false, '不得声称已恢复调度');
  assert.equal(lines.some((l) => l.includes('未恢复调度')), true, '日志必须如实说明未恢复');
});

// ───────────────────────── M1：config.json 类型校验 ─────────────────────────
function writeConfig(dir, obj) {
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}
const dashboardPublic = (cfg) => cfg.publicDashboard !== false && cfg.protectAdminApi !== true;

test('M1①：config.json "publicDashboard": "false"（字符串）→ 最终为布尔 false，dashboardPublic()=false', () => {
  const dir = makeTmpDir();
  try {
    const f = writeConfig(dir, { publicDashboard: 'false', protectAdminApi: 'true' });
    const cfg = loadConfig(f, {});
    assert.equal(cfg.publicDashboard, false, '字符串 "false" 必须解析成布尔 false');
    assert.equal(cfg.protectAdminApi, true, '字符串 "true" 必须解析成布尔 true');
    assert.equal(dashboardPublic(cfg), false, '面板不得仍然公开');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M1②：config.json 布尔 false → false（不回归）', () => {
  const dir = makeTmpDir();
  try {
    const f = writeConfig(dir, { publicDashboard: false });
    const cfg = loadConfig(f, {});
    assert.equal(cfg.publicDashboard, false);
    assert.equal(dashboardPublic(cfg), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M1③：未知配置键产生 warn，且不得静默并进 cfg', () => {
  const dir = makeTmpDir();
  try {
    const f = writeConfig(dir, { quoatPollIntervalMs: 1, publicDashboard: true });
    const cfg = loadConfig(f, {});
    assert.equal('quoatPollIntervalMs' in cfg, false, '拼错的键不得进 cfg');
    const warns = configWarnings(cfg);
    assert.equal(warns.some((w) => w.includes('quoatPollIntervalMs')), true, `应产生未知键告警，实际 ${JSON.stringify(warns)}`);
    // 即时打印路径
    const printed = [];
    loadConfig(f, {}, { log: { warn: (m) => printed.push(m) } });
    assert.equal(printed.some((w) => w.includes('quoatPollIntervalMs')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M1④：安全开关在 config.json 里给数字 / 对象 → 直接拒绝启动', () => {
  const dir = makeTmpDir();
  try {
    for (const [key, bad] of [['publicDashboard', 0], ['protectAdminApi', {}], ['allowPassthrough', ['true']], ['creditsProbeEnabled', 1]]) {
      const f = writeConfig(dir, { [key]: bad });
      assert.throws(() => loadConfig(f, {}), (e) => {
        assert.ok(e.message.includes(key), `错误信息应指出键名 ${key}：${e.message}`);
        assert.ok(e.message.includes('boolean'), `错误信息应说明期望类型：${e.message}`);
        return true;
      }, `${key} 给 ${JSON.stringify(bad)} 必须拒绝启动`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M1⑤：env 路径行为不回归；upstreamTimeoutMs 进入 DEFAULTS / ENV_MAP', () => {
  const cfg = loadConfig('/nonexistent/config.json', { PUBLIC_DASHBOARD: '0', ALLOW_PASSTHROUGH: '1', UPSTREAM_TIMEOUT_MS: '4321' });
  assert.equal(cfg.publicDashboard, false);
  assert.equal(cfg.allowPassthrough, true);
  assert.equal(cfg.upstreamTimeoutMs, 4321);
  assert.equal(DEFAULTS.upstreamTimeoutMs, 300000);
  assert.equal(loadConfig('/nonexistent/config.json', {}).upstreamTimeoutMs, 300000);
  // config.json 也能设
  const dir = makeTmpDir();
  try {
    const f = writeConfig(dir, { upstreamTimeoutMs: 1234 });
    assert.equal(loadConfig(f, {}).upstreamTimeoutMs, 1234);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
