/* B24：运行日志 —— 行结构在 admin.astro 的 <template id="tpl-event">，只克隆 + 填值。 */
function badgeOf(tone) { return tone === 'bad' ? 'badge-error' : tone === 'warn' ? 'badge-warning' : tone === 'ok' ? 'badge-success' : 'badge-ghost'; }

function eventRow(e) {
  const node = cloneTemplate('tpl-event');
  if (!node) return '';
  const lvl = String(e.level || 'info');
  const lvCls = lvl === 'error' ? 'lv-bad' : lvl === 'warn' ? 'lv-warn' : lvl === 'debug' ? '' : 'lv-ok';
  const tone = lvl === 'error' ? 'bad' : lvl === 'warn' ? 'warn' : lvl === 'debug' ? '' : 'ok';
  const time = field(node, 'time');
  if (time) {
    time.textContent = shortTime(e.at);
    time.setAttribute('title', timeText(e.at));   // 完整时间进 title，窄屏不挤爆正文
  }
  const level = field(node, 'level');
  if (level) level.className = 'event-level shrink-0 ' + lvCls;
  const badge = field(node, 'badge');
  if (badge) { badge.className = 'tag badge badge-sm ' + badgeOf(tone) + ' ' + tone; badge.textContent = lvl; }
  fillText(node, 'msg', e.message);
  return outerRow(node);
}

function renderEvents() {
  const list = state.events;
  $('event-count').textContent = list.length + ' 条';
  if (!list.length) {
    $('events').innerHTML = emptyLine('暂无事件');
    return;
  }
  // 窄屏：日志正文另起一行（max-[820px]:basis-full，见模板），时间/级别留在首行。
  $('events').innerHTML = list.map(eventRow).join('');
}

let eventsGeneration = 0;
async function loadEvents() {
  const generation = ++eventsGeneration;
  const q = state.level ? '?level=' + encodeURIComponent(state.level) : '';
  try {
    const data = await apiJSON('/api/admin/events' + q);
    if (generation !== eventsGeneration) return;   // 过期响应直接丢弃，不写 state、不渲染
    state.events = data.events || [];
    renderEvents();
  } catch (e) {
    if (generation !== eventsGeneration) return;   // 过期请求的错误也不冒泡到 toast
    throw e;
  }
}
