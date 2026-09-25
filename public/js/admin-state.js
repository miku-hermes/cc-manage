const state = {
  auth: null, writable: true, accounts: [], keys: [], users: [], events: [],
  level: '', readonlyReason: '', mode: 'login', dashboardPublic: null,
};
let renameTarget = null;
let passTarget = null;
const testResults = new Map();   // keyId → 最近一次连通性测试结果
