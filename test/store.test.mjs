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
