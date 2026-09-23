const state = {
  auth: null, writable: true, accounts: [], keys: [], users: [], events: [], tests: [],
  level: '', readonlyReason: '', mode: 'login',
};
let renameTarget = null;
let passTarget = null;
const testResults = new Map();   // keyId → 最近一次连通性测试结果
