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
