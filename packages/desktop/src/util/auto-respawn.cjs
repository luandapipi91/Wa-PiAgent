// auto-respawn.cjs — kernel sidecar 崩溃自动重启的决策逻辑（纯函数，便于测试）
//
// 背景：kernel 是 desktop spawn 的子进程。历史 bug 中 kernel 被 Bun 因未捕获异常
// 杀死（exit code=null），但 kernel-sidecar.cjs 的 child.on("exit") 只 log 不重启，
// 前端永远卡在"连接已断开，正在重连"。本模块封装"是否该重启"的决策，供 sidecar 组装。

/** 最大重启次数（防止无限崩溃循环） */
const MAX_RESPAWN = 3;
/** 重启退避延迟（毫秒） */
const RESPAWN_DELAY_MS = 2000;

/** 重启状态：sidecar 持有，随生命周期更新 */
// @ts-check
/**
 * @typedef {Object} RespawnState
 * @property {boolean} stopped - 用户主动 stop() 后置 true，禁止重启
 * @property {number} attempts - 已重启次数
 */

/**
 * 判断 kernel 子进程退出后是否应自动重启。
 *
 * @param {number|null} code - 子进程 exit code（null = 被信号杀/崩溃）
 * @param {RespawnState} state - 重启状态
 * @returns {boolean} 是否应重启
 */
function shouldRespawn(code, state) {
  // 用户主动退出（stop()）→ 绝不重启
  if (state.stopped) return false;
  // 仅崩溃（被信号杀）才重启；正常退出（code=0）或显式错误退出（code>0）不重启
  if (code !== null) return false;
  // 超过最大重启次数 → 放弃，避免崩溃循环
  if (state.attempts >= MAX_RESPAWN) return false;
  return true;
}

module.exports = { shouldRespawn, MAX_RESPAWN, RESPAWN_DELAY_MS };
