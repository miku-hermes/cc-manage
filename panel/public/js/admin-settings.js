/* 系统设置页（#/settings）：把原先只能改 config.json 的 6 项做成可读可写界面。
   - 读取：GET /api/admin/settings → 只回白名单字段的**当前生效值**；
   - 保存：PATCH /api/admin/settings（局部更新，后端严格校验类型/范围/未知字段）；
   - 保存成功 → 提示已保存并把「当前值」刷新为响应里的值；
   - 保存失败 → 显示后端返回的原因，且控件回滚到保存前（上次成功）的值。
   白名单只有 6 项，界面上不出现任何其它可编辑项；所有进 DOM 的文本走 textContent。 */

const SETTINGS_KEYS = [
  'requestLogEnabled', 'requestLogRetentionDays', 'requestLogMaxMb',
  'publicDashboard', 'quotaPollIntervalMs', 'quotaActivePollIntervalMs',
];

/** 最近一次「已保存 / 已加载」的值 —— 保存失败时的回滚基准。 */
const settingsBaseline = { values: null };

function settingsControl(key) {
  return document.querySelector('[data-setting="' + key + '"]');
}

/** 控件的期望形态只看 HTML 属性：垫片里没有 el.type 属性，不能用它判类型。 */
function settingsIsCheckbox(el) {
  return !!el && el.getAttribute('type') === 'checkbox';
}

/** 布尔项在「当前值」列写开/关，数值项写数字（读不到显示 —）。 */
function settingsCurrentText(key, value) {
  if (value === undefined || value === null) return '—';
  if (SETTINGS_KEYS.indexOf(key) >= 0 && typeof value === 'boolean') return value ? '开' : '关';
  return String(value);
}

function fillSettings(values) {
  const src = values || {};
  for (const key of SETTINGS_KEYS) {
    const el = settingsControl(key);
    if (el) {
      if (settingsIsCheckbox(el)) el.checked = src[key] === true;
      else el.value = src[key] === undefined || src[key] === null ? '' : String(src[key]);
    }
    const cur = document.querySelector('[data-current="' + key + '"]');
    if (cur) cur.textContent = settingsCurrentText(key, src[key]);
  }
}

/** 从控件读回一份局部更新：布尔走 checked，数值走 Number(value)。 */
function settingsPayload() {
  const patch = {};
  for (const key of SETTINGS_KEYS) {
    const el = settingsControl(key);
    if (!el) continue;
    patch[key] = settingsIsCheckbox(el) ? !!el.checked : Number(el.value);
  }
  return patch;
}

function settingsError(message) {
  const el = $('settings-err');
  if (!el) return;
  el.textContent = message || '';
  el.className = 'banner alert alert-error text-sm' + (message ? '' : ' hidden');
}

function settingsStatus(message) {
  const el = $('settings-status');
  if (el) el.textContent = message || '';
}

/** 拉白名单当前值并填进控件（登录态之外不请求，避免把 401 当成会话失效）。 */
async function loadSettings() {
  if (!(state.auth && state.auth.authenticated)) return;
  const data = await apiJSON('/api/admin/settings');
  settingsBaseline.values = (data && data.settings) || {};
  fillSettings(settingsBaseline.values);
  settingsError('');
}

/** 保存：先发 PATCH，成功用响应值刷新；失败回滚到 settingsBaseline 并把后端原因显示出来。 */
async function saveSettings() {
  if (!(state.auth && state.auth.authenticated)) return;
  const btn = $('settings-save');
  const baseline = settingsBaseline.values;
  if (btn) btn.disabled = true;
  settingsStatus('');
  try {
    const data = await apiJSON('/api/admin/settings', { method: 'PATCH', body: settingsPayload() });
    settingsBaseline.values = (data && data.settings) || settingsPayload();
    fillSettings(settingsBaseline.values);
    settingsError('');
    settingsStatus('已保存');
    toast('设置已保存');
  } catch (e) {
    // 后端明确拒绝了这次改动：控件必须回到保存前的值，不能停在用户改过的中间态。
    fillSettings(baseline);
    const reason = (e && e.message) || '未知错误';
    settingsError('保存失败：' + reason);
    settingsStatus('');
    toast('保存失败：' + reason, true);
  } finally {
    if (btn) btn.disabled = state.writable === false;
  }
}

(function bindSettingsEvents() {
  const btn = $('settings-save');
  if (btn) btn.addEventListener('click', () => { saveSettings().catch(() => {}); });
})();
