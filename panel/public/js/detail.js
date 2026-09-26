const DETAIL_CHART_SRC = 'vendor/echarts.min.js?v=6.1.0-b66b25ae';
let detailChartLoader = null;
let detailChart = null;
let detailHistory = [];

function detailText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function detailMoney(value) { return Number.isFinite(Number(value)) ? '$' + Number(value).toFixed(2) : '无数据'; }
function detailWindow(label, window, now) {
  const box = document.createElement('div'); box.className = 'rounded-box border border-base-300 p-3 text-sm';
  const title = document.createElement('h4'); title.className = 'font-semibold'; title.textContent = label; box.appendChild(title);
  if (!window || !Number.isFinite(Number(window.cap)) || Number(window.cap) <= 0 || !Number.isFinite(Number(window.used))) {
    const empty = document.createElement('p'); empty.className = 'aux-text mt-2'; empty.textContent = '无数据'; box.appendChild(empty); return box;
  }
  const used = Math.max(0, Number(window.used));
  const cap = Number(window.cap);
  const percent = window.percent == null ? NaN : Number(window.percent);
  const pct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : used / cap * 100));
  const line = document.createElement('p'); line.className = 'mt-2 tabular-nums'; line.textContent = `已用 ${detailMoney(used)} / 上限 ${detailMoney(cap)}（${pct.toFixed(1)}%）`; box.appendChild(line);
  const reset = Number(window.resetAt);
  const resetLine = document.createElement('p'); resetLine.className = 'aux-text mt-1 text-xs'; resetLine.textContent = reset > 0 ? '重置 ' + new Date(reset * 1000).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }) : '重置时间无数据'; box.appendChild(resetLine);
  return box;
}
function detailChartLoad() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (detailChartLoader) return detailChartLoader;
  detailChartLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = DETAIL_CHART_SRC; script.onload = () => resolve(window.echarts); script.onerror = reject; document.head.appendChild(script);
  }); return detailChartLoader;
}
async function paintDetailChart() {
  const host = document.getElementById('m-detail-chart'); const empty = document.getElementById('m-detail-chart-empty');
  if (detailHistory.length < 2) { if (host) host.replaceChildren(); if (empty) empty.textContent = '数据不足'; return; }
  if (empty) empty.textContent = '';
  try {
    const echarts = await detailChartLoad(); if (!echarts || !host) throw new Error('chart unavailable');
    if (detailChart) detailChart.dispose(); detailChart = echarts.init(host);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--chart-series-balance').trim();
    detailChart.setOption({ animation:false, grid:{left:8,right:8,top:8,bottom:8}, xAxis:{type:'time',show:false}, yAxis:{type:'value',show:false}, series:[{type:'line',smooth:true,symbol:'none',data:detailHistory.map(x=>[Number(x.t),Number(x.remaining)]),lineStyle:{color:color||undefined,width:2},areaStyle:{color:getComputedStyle(document.documentElement).getPropertyValue('--chart-area-balance').trim()||undefined}}] });
  } catch { if (empty) empty.textContent = '图表暂不可用'; }
}
function fillAccountDetailBase(account) {
  detailText('m-detail-title', account.name || account.keyPrefix || '账号详情');
  const display = document.getElementById('m-detail-display');
  if (display) display.textContent = account.displayName || '无';
  const error = document.getElementById('m-detail-error');
  if (error) error.textContent = account.lastError || '无';
  const errorAt = document.getElementById('m-detail-error-at');
  if (errorAt) errorAt.textContent = account.lastErrorAt || '无';
}
function openAccountDetail(account, trigger) {
  fillAccountDetailBase(account);
  const status = document.getElementById('m-detail-status');
  const st = accountStatus(account); status.className = 'acct-status badge shrink-0 whitespace-nowrap ' + toneBadge(st.tone); status.replaceChildren(Object.assign(document.createElement('span'), {className:'dot'}), document.createTextNode(st.t));
  detailText('m-detail-plan', account.lastQuota?.plan ? planLabel(account.lastQuota.plan.planId) || '' : '套餐无数据');
  const quota = account.lastQuota || {};
  const parts = [['月度',quota.credits?.monthlyCredits],['购买',quota.credits?.purchasedCredits],['赠送',quota.credits?.freeCredits]].filter(x=>Number.isFinite(Number(x[1]))&&Number(x[1])>0);
  const credits = document.getElementById('m-detail-credits'); credits.replaceChildren(); credits.setAttribute('aria-label', parts.map(x=>x[0]+' '+detailMoney(Number(x[1]))).join(' · '));
  const total = parts.reduce((sum,x)=>sum+Number(x[1]),0);
  for (const [label,value] of parts) { const kind={月度:'month',购买:'buy',赠送:'gift'}[label]; const seg=document.createElement('i');seg.className='seg-'+kind+' bg-'+({month:'primary',buy:'secondary',gift:'accent'}[kind]);seg.style.width=(Number(value)/total*100)+'%';seg.title=label+' '+detailMoney(Number(value));credits.appendChild(seg); }
  detailText('m-detail-credit-label', parts.length ? parts.map(x=>x[0]+' '+detailMoney(Number(x[1]))).join(' · ') : '额度构成无数据');
  const windows=document.getElementById('m-detail-windows'); windows.replaceChildren(detailWindow('5 小时',quota.fiveHour,Date.now()),detailWindow('本周',quota.weekly,Date.now()),detailWindow('本月',quota.monthly,Date.now()));
  detailHistory=[]; detailText('m-detail-chart-empty','数据不足'); detailText('m-detail-burn','数据不足'); detailText('m-detail-updated', '额度更新于 ' + (Number.isFinite(Number(quota.fetchedAt)) ? Math.max(0,Math.floor((Date.now()-Number(quota.fetchedAt))/1000))+' 秒前' : '时间无数据'));
  if (trigger && trigger.focus) trigger.focus();
  openModal('m-detail');
  const key=String(account.keyId||'');
  apiFetch('/api/history/accounts').then(r=>r.json()).then(body=>{
    const item=body?.accounts?.find(x=>String(x.keyId)===key); if(!item){detailHistory=[];paintDetailChart();return;}
    detailHistory=Array.isArray(item.samples)?item.samples.filter(x=>Number.isFinite(Number(x.t))&&Number.isFinite(Number(x.remaining))):[];
    if(item.burnPerHour!=null&&item.etaHours!=null&&Number.isFinite(Number(item.burnPerHour))&&Number.isFinite(Number(item.etaHours))) detailText('m-detail-burn',`最近平均消耗 ${detailMoney(Number(item.burnPerHour))}/小时 · 按此速度预计可用约 ${Number(item.etaHours).toFixed(1)} 小时（估算）`);
    else detailText('m-detail-burn','数据不足');
    paintDetailChart();
  }).catch(()=>{detailHistory=[];paintDetailChart();});
  const modal=document.getElementById('m-detail'); modal.__detailTrigger=trigger;
}
document.addEventListener('click', e => {
  const button=e.target?.closest?.('.detail-trigger'); if(!button)return;
  e.preventDefault(); e.stopPropagation();
  const card=button.closest('[data-key-id]'); const key=card?.getAttribute('data-key-id');
  const account=state.data?.accounts?.find(a=>String(a.keyId)===String(key)); if(account)openAccountDetail(account,button);
});
