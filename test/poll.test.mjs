// 自适应额度轮询：间隔选择 / 活动追踪 / 跳轮 / 关闭语义（见 docs/ADAPTIVE-REFRESH.md）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdaptivePoller } from '../src/poll.mjs';

/** 假计时器：手动推进时间，setTimeout 只入队不真等；用 flush() 把微任务跑穿。 */
function makeFakeClock() {
  let time = 1_000_000;
  let seq = 0;
  const queue = new Map();
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => time,
    flush,
    setTimer(fn, ms) {
      const id = ++seq;
      queue.set(id, { at: time + ms, delay: ms, fn });
      return id;
    },
    clearTimer(id) { queue.delete(id); },
    /** 已排队定时器的延迟（随时只有一拍，正好用来断言间隔）。 */
    pending() { return [...queue.values()].map((t) => t.delay); },
    /** 推进时间并按到期顺序触发定时器（含触发期间新排的）。 */
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        queue.delete(id);
        time = t.at;
        t.fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

function makePoller(clock, run, opts = {}) {
  return createAdaptivePoller({
    idleIntervalMs: 300000,
    activeIntervalMs: 60000,
    activeWindowMs: 300000,
    run,
    now: clock.now,
    // B7：活跃判定改用单调时钟，测试里让假钟同时充当墙钟与单调钟（单调整调，语义不变）。
    monoNow: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts,
  });
}

test('空闲态：没有活动时用 300 秒（quotaPollIntervalMs）', async () => {
  const clock = makeFakeClock();
  let runs = 0;
  const p = makePoller(clock, async () => { runs++; });
  p.start();
  assert.deepEqual(clock.pending(), [300000], '首次排的就该是空闲间隔');
  await clock.advance(300000);
  assert.equal(runs, 1);
  assert.deepEqual(clock.pending(), [300000], '仍无活动 → 继续 300 秒');
  p.stop();
});

test('活跃态：最近 5 分钟内有活动时用 60 秒', async () => {
  const clock = makeFakeClock();
  let runs = 0;
  const p = makePoller(clock, async () => { runs++; });
  p.start();
  p.touch();
  assert.equal(p.isActive(), true);
  // 已排的空闲间隔应被提前改成活跃间隔
  assert.deepEqual(clock.pending(), [60000], '活动后立刻改排 60 秒');
  await clock.advance(60000);
  assert.equal(runs, 1);
  assert.deepEqual(clock.pending(), [60000], '仍在活跃窗内 → 继续 60 秒');
  p.stop();
});

test('活跃窗过期后退回 300 秒', async () => {
  const clock = makeFakeClock();
  const p = makePoller(clock, async () => {});
  p.start();
  p.touch();
  await clock.advance(60000);
  // 再走 4 分钟无活动，加上刚过的 1 分钟 = 超过 5 分钟 → 已出窗
  await clock.advance(240001);
  assert.equal(p.isActive(), false, '距最后活动超过 5 分钟 → 出活跃窗');
  assert.equal(p.nextDelayMs(), 300000, '出窗后下一拍该用 300 秒');
  await clock.advance(60001);
  assert.deepEqual(clock.pending(), [300000], '空闲后改回 300 秒');
  p.stop();
});

test('持续活动时定时器不会被无限往后推（仍是 60 秒一拍）', async () => {
  const clock = makeFakeClock();
  let runs = 0;
  const p = makePoller(clock, async () => { runs++; });
  p.start();
  for (let i = 0; i < 5; i++) {
    p.touch();                       // 每次抽点，模拟连续流量
    assert.deepEqual(clock.pending(), [60000], '活跃期每拍都必须是 60 秒');
    await clock.advance(60000);
  }
  assert.equal(runs, 5, '5 分钟连续活动 → 5 次刷新（60s 一拍）');
  p.stop();
});

test('上一轮还没跑完时跳过本轮，不叠加执行', async () => {
  const clock = makeFakeClock();
  let started = 0;
  let release = null;
  const p = makePoller(clock, async () => {
    started++;
    await new Promise((r) => { release = r; });
  });
  p.start();
  await clock.advance(300000);
  assert.equal(started, 1);
  assert.equal(p.running, true, '第一轮应仍在跑');
  // 两拍过去，第一轮都没结束 → 都应被跳过
  await clock.advance(600000);
  assert.equal(started, 1, '未跑完时不得叠加新的一轮');
  assert.ok(p.stats.skips >= 2, `应记录跳过次数，实际 ${p.stats.skips}`);
  assert.equal(clock.pending().length, 1, '跳过后仍要排下一拍');
  release();
  await clock.flush();
  assert.equal(p.running, false, '第一轮已结束');
  await clock.advance(300000);
  assert.equal(started, 2, '上一轮结束后恢复调度');
  release();
  await clock.flush();
  p.stop();
});

test('外部正在刷新（isBusy）时同样跳过本轮', async () => {
  const clock = makeFakeClock();
  let runs = 0;
  let busy = false;
  const p = makePoller(clock, async () => { runs++; }, { isBusy: () => busy });
  p.start();
  busy = true;                                   // 模拟手动点「刷新额度」占着
  await clock.advance(300000);
  assert.equal(runs, 0, '外部刷新进行中 → 不叠一轮');
  assert.ok(p.stats.skips >= 1);
  busy = false;
  await clock.advance(300000);
  assert.equal(runs, 1, '外部刷新结束后恢复');
  p.stop();
});

test('quotaPollIntervalMs: 0 → 完全关闭轮询（不排任何定时器）', async () => {
  const clock = makeFakeClock();
  let runs = 0;
  const p = makePoller(clock, async () => { runs++; }, { idleIntervalMs: 0 });
  p.start();
  assert.equal(p.enabled, false);
  assert.deepEqual(clock.pending(), [], '不该排定时器');
  p.touch();                          // 有活动也不能把它唤醒
  assert.deepEqual(clock.pending(), []);
  await clock.advance(3600000);
  assert.equal(runs, 0, '关闭后一次都不跑');
  p.stop();
});

test('quotaActivePollIntervalMs: 0 → 退化为纯空闲间隔', async () => {
  const clock = makeFakeClock();
  const p = makePoller(clock, async () => {}, { activeIntervalMs: 0 });
  p.start();
  p.touch();
  assert.equal(p.isActive(), false, '活跃间隔为 0 时不判定活跃');
  assert.deepEqual(clock.pending(), [300000], '恒定空闲间隔');
  p.stop();
});

test('stop() 后不再触发，也不再排新的一拍', async () => {
  const clock = makeFakeClock();
  let runs = 0;
  const p = makePoller(clock, async () => { runs++; });
  p.start();
  p.stop();
  assert.deepEqual(clock.pending(), []);
  await clock.advance(600000);
  assert.equal(runs, 0);
});

test('run 抛错不会中断调度（继续排下一拍）', async () => {
  const clock = makeFakeClock();
  const errors = [];
  let calls = 0;
  const p = makePoller(clock, async () => { calls++; throw new Error('boom'); }, { onError: (e) => errors.push(e) });
  p.start();
  await clock.advance(300000);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(p.stats.errors, 1);
  assert.deepEqual(clock.pending(), [300000], '出错也要继续排下一拍');
  p.stop();
});
