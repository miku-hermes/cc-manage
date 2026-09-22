// 批次 2：mock 上游 behavior 白名单（拼错 key 不再静默失效）。
// 校验发生在 server.listen 之前，因此本用例不依赖网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstream, assertBehaviorKeys } from '../mocks/mock-cc-upstream.mjs';

test('B2-22：未知 behavior key 必须抛错（实例：failNext500 应为 failNext5xx）', async () => {
  await assert.rejects(
    () => startMockUpstream({ behavior: { failNext500: 1 } }),
    /未知的 mock behavior 开关: failNext500/,
    '拼错的开关必须在启动前就报错，不能静默失效');
  assert.throws(() => assertBehaviorKeys({ nope: 1 }), /未知的 mock behavior 开关: nope/);
  assert.doesNotThrow(() => assertBehaviorKeys({ failNext5xx: 1, usageBody: {}, sseChunks: [] }));
  assert.doesNotThrow(() => assertBehaviorKeys(undefined));
});
