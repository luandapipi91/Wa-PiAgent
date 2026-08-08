// auto-respawn.cjs — kernel sidecar 崩溃自动重启的决策逻辑（纯函数，便于测试）
//
// 背景：kernel 是 desktop spawn 的子进程。历史 bug 中 kernel 被 Bun 因未捕获异常
// 杀死（exit code=null），但 kernel-sidecar.cjs 的 child.on("exit") 只 log 不重启，
// 前端永远卡在"连接已断开，正在重连"。本模块封装"是否该重启"的决策，供 sidecar 组装。
// 策略：无限重启 + 固定间隔（attempts 仅用于日志计数，不再拦截）。
// 注意：Windows 上 taskkill /F 强杀进程实测产生 exit code=1（signal=null），
// 因此仅 code=0（优雅退出）不重启，其余崩溃/强杀（code=null 或 code>0）一律无限重启。

/** 重启延迟（毫秒）——固定间隔，无限重启 */
const RESPAWN_DELAY_MS = 2000;

/** 重启状态：sidecar 持有，随生命周期更新 */
// @ts-check
/**
 * @typedef {Object} RespawnState
 * @property {boolean} stopped - 用户主动 stop() 后置 true，禁止重启
 * @property {number} attempts - 已重启次数（仅用于日志）
 */

/**
 * 判断 kernel 子进程退出后是否应自动重启（无限重启策略）。
 * 仅正常退出 code=0 不重启；其余崩溃/强杀（code=null 信号杀、code>0 Windows 强杀实测 code=1 / Bun 异常退出）都无限重启。
 *
 * @param {number|null} code - 子进程 exit code（null = 被信号杀/崩溃；>0 = Windows 强杀或异常退出）
 * @param {RespawnState} state - 重启状态
 * @returns {boolean} 是否应重启
 */
function shouldRespawn(code, state) {
  // 用户主动退出（stop()）→ 绝不重启
  if (state.stopped) return false;
  // 正常退出（code=0，kernel 优雅退出 SIGTERM→exit(0)）→ 不重启
  if (code === 0) return false;
  // 崩溃/强杀（code=null 信号杀；code>0 Windows 强杀实测 code=1，或 Bun 异常退出）→ 无限重启
  return true;
}

module.exports = { shouldRespawn, RESPAWN_DELAY_MS };
