// 运行期状态加载：已删账号（不在 accounts.json 里的 keyId）的残留必须被清理并落盘
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { keyIdOf } from '../src/log.mjs';
import { makeTmpDir, writeAccountFiles } from './helpers.mjs';

const ALIVE = 'user_alive_account';
const DELETED = 'user_deleted_account';

function seedState(dir, { accountsStatus = {}, byAccount = {}, total = 0, errors = 0, totalTokens = 0 } = {}) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
    accounts: accountsStatus,
    stats: { total, errors, totalTokens, byAccount },
  }, null, 2));
}

test('loadState 清理不在 accounts.json 里的 state.accounts / stats.byAccount 残留并落盘', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const aliveId = keyIdOf(ALIVE);
    const deadId = keyIdOf(DELETED);

    seedState(dir, {
      accountsStatus: { [aliveId]: { concurrency: 0 }, [deadId]: { concurrency: 0 }, '9af49907': { concurrency: 0 } },
      byAccount: { [aliveId]: { requests: 3, errors: 1, tokens: 90 }, [deadId]: { requests: 2, errors: 0, tokens: 40 }, '9af49907': { requests: 2, errors: 0, tokens: 0 } },
      total: 7, errors: 1, totalTokens: 130,
    });

    const store = createStore({ rootDir: dir });
    const accounts = store.loadAccounts();
    store.loadState(accounts);

    // 存留：只有当前账号
    assert.deepEqual(Object.keys(store.state.accounts), [aliveId]);
    assert.deepEqual(Object.keys(store.state.stats.byAccount), [aliveId]);

    // 全局合计扣掉了已删账号的贡献，保持自洽
    assert.equal(store.state.stats.total, 3);
    assert.equal(store.state.stats.errors, 1);
    assert.equal(store.state.stats.totalTokens, 90);

    // 必须落盘（重启后不再复活）
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk.accounts), [aliveId]);
    assert.deepEqual(Object.keys(onDisk.stats.byAccount), [aliveId]);
    assert.equal(onDisk.stats.totalTokens, 90);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState：全部账号都在册时不改动 state，也不重复落盘', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const aliveId = keyIdOf(ALIVE);
    seedState(dir, {
      accountsStatus: { [aliveId]: { concurrency: 0 } },
      byAccount: { [aliveId]: { requests: 5, errors: 0, tokens: 11 } },
      total: 5, errors: 0, totalTokens: 11,
    });
    const before = fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8');

    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());

    assert.deepEqual(Object.keys(store.state.accounts), [aliveId]);
    assert.equal(store.state.stats.totalTokens, 11);
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState：不传账号列表（旧调用方式）时不做清理，兼容原行为', () => {
  const dir = makeTmpDir();
  try {
    seedState(dir, {
      accountsStatus: { ghost: { concurrency: 0 } },
      byAccount: { ghost: { requests: 1, errors: 0, tokens: 2 } },
      total: 1, errors: 0, totalTokens: 2,
    });
    const store = createStore({ rootDir: dir });
    store.loadState();
    assert.deepEqual(Object.keys(store.state.accounts), ['ghost']);
    assert.equal(store.state.stats.total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── F1：state.json 损坏不得阻塞启动（cache 丢弃 + warn + 重建）─────────
const CORRUPT_CASES = {
  '0 字节（掉电典型形态）': '',
  '截断的 JSON': '{"accounts":{"abc":',
  '垃圾字节（NUL）': '\u0000\u0000\u0000\u0000garbage',
};

for (const [label, content] of Object.entries(CORRUPT_CASES)) {
  test(`loadState：${label} → 不抛错、丢弃缓存、重建默认值并落盘`, () => {
    const dir = makeTmpDir();
    try {
      writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'state.json'), content);

      const warnings = [];
      const store = createStore({ rootDir: dir, log: { warn: (m) => warnings.push(m), info: () => {} } });
      const accounts = store.loadAccounts();

      // 绝不能抛错（抛错 = 网关 crash-loop，整个服务下线）
      assert.doesNotThrow(() => store.loadState(accounts));
      assert.deepEqual(Object.keys(store.state.accounts), [], '损坏缓存必须被丢弃');
      assert.deepEqual(store.state.stats, { total: 0, errors: 0, totalTokens: 0, byAccount: {} });
      assert.ok(warnings.some((w) => w.includes('已损坏')), `必须 warn，实际 ${JSON.stringify(warnings)}`);

      // 落盘默认值：下次启动读到的就是合法 JSON
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'));
      assert.deepEqual(onDisk.accounts, {});
      assert.equal(onDisk.stats.total, 0);
      assert.equal(store.persistedAfterLoad, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('F1：atomicWrite 写出的文件立即可读且无残留 tmp（fsync 路径可用）', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());
    store.state.stats.total = 7;
    store.saveState();

    const files = fs.readdirSync(path.join(dir, 'data'));
    assert.deepEqual(files, ['state.json'], `不得留下临时文件，实际 ${files.join(',')}`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8')).stats.total, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── F12：崩溃残留的 *.tmp-* 启动时清理 ──────────────────────────────
test('F12：启动时清理 data/ 下残留的 state.json.tmp-<pid>-<ts>', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    seedState(dir, { accountsStatus: { [keyIdOf(ALIVE)]: { concurrency: 0 } } });
    const stale = [
      'state.json.tmp-999-1700000000000',
      'state.json.tmp-1-1700000000001',
    ];
    for (const name of stale) fs.writeFileSync(path.join(dir, 'data', name), '{"partial":');
    fs.writeFileSync(path.join(dir, 'data', 'keep-me.json'), '{}');

    const warnings = [];
    const store = createStore({ rootDir: dir, log: { warn: (m) => warnings.push(m), info: () => {} } });
    store.loadState(store.loadAccounts());

    const left = fs.readdirSync(path.join(dir, 'data')).sort();
    assert.deepEqual(left, ['keep-me.json', 'state.json'], `残留 tmp 必须清掉，实际 ${left.join(',')}`);
    assert.ok(warnings.some((w) => w.includes('残留')), '清理残留要 warn 一次');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── F10：中止计数同样要参与残留清理，保证 byAccount 之和自洽 ──────────
test('F10：删账号时全局 aborted 一并扣减', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const aliveId = keyIdOf(ALIVE);
    const deadId = keyIdOf(DELETED);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
      accounts: { [aliveId]: {}, [deadId]: {} },
      stats: {
        total: 5, errors: 1, totalTokens: 10, aborted: 2,
        byAccount: {
          [aliveId]: { requests: 3, errors: 1, tokens: 10, aborted: 0 },
          [deadId]: { requests: 2, errors: 0, tokens: 0, aborted: 2 },
        },
      },
    }));

    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());
    assert.equal(store.state.stats.aborted, 0, '已删账号的中止数必须扣掉');
    assert.equal(store.state.stats.total, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── B5：透传固定桶不能被 pruneState 当成「已删账号」清掉 ──────────────────
test('B5：pruneState 保留 __passthrough__ 桶，total/errors 不被倒扣', () => {
  const dir = makeTmpDir();
  try {
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const aliveId = keyIdOf(ALIVE);
    seedState(dir, {
      accountsStatus: { [aliveId]: { concurrency: 0 } },
      byAccount: {
        [aliveId]: { requests: 2, errors: 0, tokens: 20 },
        // 透传伪账号的固定桶：不是池内账号，但也绝不能当已删账号清掉
        '__passthrough__': { requests: 3, errors: 1, tokens: 30 },
      },
      total: 5, errors: 1, totalTokens: 50,
    });

    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());

    assert.ok('__passthrough__' in store.state.stats.byAccount, '透传固定桶必须保留');
    assert.equal(store.state.stats.total, 5, '透传统计不得被倒扣（历史 10→7）');
    assert.equal(store.state.stats.errors, 1);
    assert.equal(store.state.stats.totalTokens, 50);
    assert.deepEqual(store.state.stats.byAccount['__passthrough__'], { requests: 3, errors: 1, tokens: 30 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── B4：删账号后新增「同 keyId」账号不得继承旧 runtime 标记 ──────────────
const REUSED = 'user_reused_same_key_aa';

test('B4：上次落盘时不在池中的 keyId 重新出现 → authInvalid/pausedUntil 必须清空', () => {
  const dir = makeTmpDir();
  try {
    const X = keyIdOf(REUSED);
    const other = keyIdOf('user_other_account_bb');
    writeAccountFiles(dir, { accounts: [{ name: '新账号', key: REUSED }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    // state.json：X 带着旧账号 A 的停调标记；但上次落盘时池里只有 other（X 是被删掉的 A）
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
      accounts: { [X]: { authInvalid: true, authInvalidReason: '旧账号的 401', pausedUntil: Date.now() + 3600_000 } },
      pool: [other],
      stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} },
    }, null, 2));

    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());

    assert.notEqual(store.state.accounts[X]?.authInvalid, true, '同 keyId 的新账号不得继承 authInvalid');
    assert.ok(!Number.isFinite(store.state.accounts[X]?.pausedUntil), '也不得继承 pausedUntil');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B4：仍在池中的 keyId 必须保留 runtime 标记（不误清）', () => {
  const dir = makeTmpDir();
  try {
    const X = keyIdOf(ALIVE);
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
      accounts: { [X]: { authInvalid: true, authInvalidReason: '仍然是它' } },
      pool: [X],
      stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} },
    }, null, 2));

    const store = createStore({ rootDir: dir });
    store.loadState(store.loadAccounts());
    assert.equal(store.state.accounts[X].authInvalid, true, '同一账号跨重启必须保留停调标记');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── M2b：legacy 只读单文件不得被 writable() 误报为可写 ────────────────────
// 注意：本用例依赖 chmod 目录权限位来模拟只读。root 会绕过 DAC 权限检查
// （fs.accessSync(dir, W_OK) 对 0o555 目录仍返回 true），chmod 无法模拟只读，
// 因此在 root 下必然失败——用 skip 守卫，该路径仅在非 root 环境可测。
test('M2b：legacy 凭据所在目录不可写（chmod 555）→ writable()=false 且写入报只读',
  { skip: typeof process.getuid === 'function' && process.getuid() === 0
      ? 'root 用户绕过文件权限位，chmod 无法模拟只读目录；该路径仅在非 root 环境可测'
      : false },
  () => {
  const dir = makeTmpDir();
  try {
    // config/ 目录存在且可写（旧代码只看它 → 误报 true），真正的凭据却回落到只读 legacy 文件
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    const legacy = path.join(dir, 'accounts.json');
    fs.writeFileSync(legacy, JSON.stringify({ accounts: [] }));
    fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ keys: [] }));
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [] }));
    fs.chmodSync(dir, 0o555);   // 无法建 tmp / rename → 凭据文件不可替换

    const store = createStore({ rootDir: dir });
    assert.equal(store.accountsFile, legacy, '前置：凭据路径确实回落到 legacy 单文件');
    assert.equal(store.writable(), false, '只读 legacy 文件必须判为不可写（否则写接口 500）');
    assert.throws(() => store.saveAccounts([{ name: 'x', key: ALIVE }]), /只读/, '写失败要是明确的只读语义');
  } finally {
    try { fs.chmodSync(dir, 0o755); } catch { /* 忽略 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2b：正常可写的 config/ 目录 → writable()=true', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    writeAccountFiles(dir, { accounts: [{ name: '在册', key: ALIVE }], keys: [{ name: 'c', key: 'sk-cg-local0001' }] });
    const store = createStore({ rootDir: dir });
    assert.equal(store.writable(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
