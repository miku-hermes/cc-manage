function renderEvents() {
  const list = state.events;
  $('event-count').textContent = list.length + ' 条';
  if (!list.length) {
    $('events').innerHTML = '<div class="empty">暂无事件</div>';
    return;
  }
  $('events').innerHTML = list.map((e) => {
    const lvl = String(e.level || 'info');
    const dot = lvl === 'error' ? 'lv-bad' : lvl === 'warn' ? 'lv-warn' : lvl === 'debug' ? '' : 'lv-ok';
    const text = lvl === 'error' ? 'bad' : lvl === 'warn' ? 'warn' : lvl === 'debug' ? '' : 'ok';
    return '<div class="event">'
      + '<span class="event-time" title="' + esc(timeText(e.at)) + '">' + esc(shortTime(e.at)) + '</span>'
      + '<span class="event-level ' + dot + '"><span class="tag ' + text + '">' + esc(lvl) + '</span></span>'
      + '<span class="event-msg">' + esc(e.message) + '</span>'
      + '</div>';
  }).join('');
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
