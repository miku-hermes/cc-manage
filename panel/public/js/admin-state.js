const state = {
  auth: null, writable: true, accounts: [], keys: [], users: [], events: [],
  // 请求日志页（GET /api/admin/logs）：logs=当前已加载条目，logsHasMore=还有下一页，
  // logsEnabled=false 表示 REQUEST_LOG_ENABLED=0，logsStats 里 dropped>0 必须在页面顶部示警。
  logs: [], logsHasMore: false, logsEnabled: true, logsStats: { written: 0, dropped: 0, degraded: false },
  level: '', readonlyReason: '', mode: 'login', dashboardPublic: null,
};
let renameTarget = null;
let passTarget = null;
const testResults = new Map();   // keyId → 最近一次连通性测试结果
