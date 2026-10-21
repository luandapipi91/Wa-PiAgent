// health-check.cjs — kernel sidecar 端口探活状态机（纯逻辑，便于测试）
//
// 背景：kernel 崩溃处理器捕获异常后不退出进程（crash-logger 只写日志），
// 存在「进程存活但 9778 端口已不可用」的情况，仅靠 child.on("exit") 永远发现不了。
// 本模块封装「端口是否健康」的判定与连续失败计数，供 sidecar 定期探活：
// 连续失败达到阈值 → 判定挂了 → 主动强杀走统一重启路径。
const { isPortInUse } = require("./port.cjs");

/** 探活间隔（毫秒） */
const HEALTH_CHECK_INTERVAL_MS = 5000;
/** 连续失败多少次判定「挂了」（5s × 3 ≈ 15s 无响应，规避瞬时抖动） */
const HEALTH_FAIL_THRESHOLD = 3;
/** 单次探测超时（毫秒），防 isPortInUse 挂起 */
const HEALTH_CHECK_TIMEOUT_MS = 2000;

/**
 * 探测端口是否被监听（健康）。复用 port.cjs 的 isPortInUse：
 * 端口被占用（kernel 在监听）→ true；空闲 → false；超时 → false（不健康）。
 *
 * @param {number} port
 * @param {number} [timeoutMs=HEALTH_CHECK_TIMEOUT_MS]
 * @returns {Promise<boolean>}
 */
function checkPort(port, timeoutMs = HEALTH_CHECK_TIMEOUT_MS) {
  return Promise.race([
    isPortInUse(port),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

/**
 * 探活状态更新（纯函数）。
 *
 * @param {{ failures: number, failThreshold: number, stopped: boolean }} state
 * @param {boolean} healthy - 本轮探测是否健康
 * @returns {{ shouldRestart: boolean, failures: number }}
 */
function updateHealthState(state, healthy) {
  if (state.stopped) return { shouldRestart: false, failures: state.failures };
  if (healthy) return { shouldRestart: false, failures: 0 };
  const failures = state.failures + 1;
  if (failures >= state.failThreshold) {
    return { shouldRestart: true, failures: 0 };
  }
  return { shouldRestart: false, failures };
}

module.exports = {
  checkPort,
  updateHealthState,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_FAIL_THRESHOLD,
  HEALTH_CHECK_TIMEOUT_MS,
};
