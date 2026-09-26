import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'panel/dist/index.html'), 'utf8');
const CSS_PATH = INDEX.match(/href="([^"]+\.css)"/)?.[1];
assert.ok(CSS_PATH, 'built index references a CSS artifact');
const CSS = fs.readFileSync(path.join(ROOT, 'panel/dist', CSS_PATH.replace(/^\//, '')), 'utf8');

function declaration(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\{([^{}]*)\\}`));
  assert.ok(match, `built CSS contains ${selector}`);
  return match[1];
}

function assertElevation(selector, token, expectedComponents) {
  const rule = declaration(selector);
  const value = rule.match(/box-shadow:([^;}]+)/)?.[1];
  assert.equal(value, `var(${token})`, `${selector} uses ${token}`);
  assert.notEqual(value, 'none');
  assert.doesNotMatch(value, /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)/i, 'shadow is not transparent');
  assert.equal(value.split(',').length, expectedComponents, 'complete shadow component count');
}

test('产物 CSS：所有卡片层级使用项目阴影令牌', () => {
  assertElevation('.card,.kpis,#trend-stats', '--shadow-card', 1);
  assertElevation('.card:hover,.kpis:hover,#trend-stats:hover', '--shadow-md', 1);
  const token = CSS.match(/--shadow-card:([^;}]+)/)?.[1];
  assert.ok(token, 'built CSS defines --shadow-card');
  assert.match(token, /#2d1b3d0d/);
  assert.match(token, /0\.05|#2d1b3d0d/);
  assert.doesNotMatch(token, /transparent|rgba?\([^)]*,\s*0(?:\.0+)?\s*\)/i);
});
