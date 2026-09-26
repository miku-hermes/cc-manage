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

function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth -= 1;
    else if (value[index] === ',' && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function assertElevation(selector, token, expectedComponents) {
  const rule = declaration(selector);
  const value = rule.match(/box-shadow:([^;}]+)/)?.[1];
  assert.equal(value, `var(${token})`, `${selector} uses ${token}`);
  assert.notEqual(value, 'none');
  assert.doesNotMatch(value, /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)/i, 'shadow is not transparent');
  assert.equal(splitTopLevel(value).length, expectedComponents, 'complete shadow component count');
}

test('产物 CSS：所有卡片层级使用项目阴影令牌', () => {
  assertElevation('.card,.kpis,#trend-stats', '--shadow-card', 1);
  assertElevation('.card:hover,.kpis:hover,#trend-stats:hover', '--shadow-md', 1);
  for (const theme of [':root', ':root[data-theme=\"dark\"]']) {
    const selector = theme.replaceAll('\"', '');
    const token = declaration(selector).match(/--shadow-card:([^;}]+)/)?.[1];
    assert.ok(token, `${theme} defines --shadow-card`);
    const components = splitTopLevel(token);
    assert.equal(components.length, 2, `${theme} --shadow-card has exactly two components`);
    assert.match(components[0], /^0 2px 8px (?:#2d1b3d0d|rgba\(\s*45\s*,\s*27\s*,\s*61\s*,\s*\.05\s*\)|#0003|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*\.2\s*\))$/i, 'first shadow has expected offset, blur, and color');
    assert.match(components[1], /^0 1px 2px (?:#2d1b3d0a|rgba\(\s*45\s*,\s*27\s*,\s*61\s*,\s*\.04\s*\)|#0002|#0000001f|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*\.12\s*\))$/i, 'second shadow has expected offset, blur, and color');
    assert.doesNotMatch(token, /transparent|rgba?\([^)]*,\s*0(?:\.0+)?\s*\)/i);
  }
});
