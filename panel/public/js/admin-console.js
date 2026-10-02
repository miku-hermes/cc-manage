/* 后台控制台外壳：hash 路由 + 侧边栏（当前页高亮 / 内网上游状态）。
   路由： #/overview（默认） #/accounts #/keys #/users #/audit #/events #/logs #/usage #/settings
   - 未知 / 空 hash 回落默认页（概览）；刷新后按 hash 恢复当前页（纯客户端，服务端只发同一张 HTML）。
   - <1024px 侧边栏收成抽屉：#admin-drawer 复选框由 #admin-head 的汉堡 label 打开，
     点某个菜单项后自动收起（js-route 在下面处理）。
   - 切页只改 .admin-page 的显示，不销毁任何区块，弹窗/表单状态原样保留。 */

const ADMIN_ROUTES = ['overview', 'accounts', 'keys', 'users', 'audit', 'events', 'logs', 'usage', 'settings'];
const ADMIN_DEFAULT_ROUTE = 'overview';

/** '#/logs' → 'logs'；未知或空 hash → 默认页。 */
function adminRouteOf(hash) {
  const raw = String(hash ?? '').replace(/^#\/?/, '').split(/[?#]/)[0].split('/')[0];
  return ADMIN_ROUTES.includes(raw) ? raw : ADMIN_DEFAULT_ROUTE;
}

/** 当前页是否在请求日志页（app-admin.js 的轮询按它决定是否刷日志）。 */
function adminPageVisible(route) { return adminRouteOf(window.location.hash) === route; }

/* 切页回调：app-admin.js 用它决定「进请求日志 / 用量统计页时才取数」。
   没有回调时切页只做显隐，不影响首屏请求预算。 */
let adminPageChangeHandler = null;
function onAdminPageChange(fn) { adminPageChangeHandler = typeof fn === 'function' ? fn : null; }

/** 切到指定页：容器显隐 + 菜单 aria-current + 收起抽屉。 */
function setAdminPage(route) {
  const page = ADMIN_ROUTES.includes(route) ? route : ADMIN_DEFAULT_ROUTE;
  for (const name of ADMIN_ROUTES) {
    const section = document.getElementById('page-' + name);
    if (section) {
      section.style.display = name === page ? '' : 'none';
      section.setAttribute('aria-hidden', name === page ? 'false' : 'true');
    }
  }
  for (const link of document.querySelectorAll('#admin-nav [data-nav]')) {
    const active = link.getAttribute('data-nav') === page;
    if (active) {
      link.setAttribute('aria-current', 'page');
      link.classList.add('menu-active');
    } else {
      link.removeAttribute('aria-current');
      link.classList.remove('menu-active');
    }
  }
  const drawer = document.getElementById('admin-drawer');
  if (drawer) drawer.checked = false;      // 窄屏：选完页面收起抽屉
  if (adminPageChangeHandler) adminPageChangeHandler(page);
  return page;
}

/** 按 location.hash 应用页面（hashchange 与首屏都用它，未知 hash 回落默认页）。 */
function applyAdminHash() { return setAdminPage(adminRouteOf(window.location.hash)); }

/* 上游就绪状态：侧边栏底部「内网上游状态」。只读探测，失败按 down 呈现。 */
const UPSTREAM_OK_TEXT = '内网上游：正常';
const UPSTREAM_BAD_TEXT = '内网上游：不可达';
async function loadUpstreamStatus() {
  const el = document.querySelector('#upstream [data-f="upstream"]');
  try {
    const data = await apiJSON('/ready');
    const up = data && (data.upstream === 'up' || data.ok === true);
    if (!el) return;
    el.textContent = up ? UPSTREAM_OK_TEXT : UPSTREAM_BAD_TEXT;
    el.className = 'upstream-text ' + (up ? 'text-success' : 'text-error');
  } catch {
    if (!el) return;
    el.textContent = UPSTREAM_BAD_TEXT;
    el.className = 'upstream-text text-error';
  }
}

window.addEventListener('hashchange', () => { applyAdminHash(); });
