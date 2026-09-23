// ── 数据：公开只读，不鉴权（只有备注名 / 额度百分比，不含 key 的任何片段）──
/** 面板取数：同源公开接口，不需要任何凭证。 */
function apiFetch(path, opts = {}) {
  return fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
}
function setHint(text, bad) {
  const el = $('keyhint');
  el.textContent = text || '';
  el.className = bad ? 'hint bad' : 'hint';
}
let loadGeneration = 0;
async function load() {
  const generation = ++loadGeneration;
  try {
    const r = await apiFetch('/api/status');
    if (generation !== loadGeneration) return;   // 过期请求直接丢弃
    if (r.status === 401) { showPrivate(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (generation !== loadGeneration) return;   // 慢响应不得覆盖新响应
    setHint('', false);
    render(data);
  } catch (e) {
    if (generation !== loadGeneration) return;
    $('health').textContent = '加载失败：' + e.message;
    $('health').className = 'pill bad';
  }
}
