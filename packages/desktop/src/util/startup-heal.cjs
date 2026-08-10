// 启动端口占用静默自愈（D 任务）：Windows 升级后端口 9778 幽灵占用的治理收尾。
// 此前端口被占直接弹错误页等用户点「重启应用」，但 80% 情况其实自动清理就能好——
// 抽成纯函数 attemptSelfHeal：端口被占时最多 rounds 轮清理（killPortOccupants 杀占用进程
// + sweepRegistry 清登记簿残留），任一轮端口释放即返回 healed:true，轮尽仍占用才
// 由调用方（main.cjs）弹错误页。全程依赖注入，测试绝不真杀进程/真探端口/真等。

/**
 * 启动自愈：最多 rounds 轮（默认 3），每轮先查端口，被占则 killPortOccupants + sweepRegistry，
 * 等 waitMs 让 socket 句柄真正释放后复查；任一轮端口释放即返回 { healed: true }，
 * 轮尽仍占用返回 { healed: false }；端口从未被占 → 不调用清理直接 { healed: true }。
 * 每轮结果都记入 log，便于排查"清理了但没释放"的场景。
 *
 * @param {object} opts 全部依赖注入
 * @param {number} [opts.rounds=3] 最多自愈轮数
 * @param {() => Promise<boolean>} opts.isPortInUse 端口占用探测（调用方绑定固定端口）
 * @param {() => Promise<unknown>} opts.killPortOccupants 杀占用进程（调用方绑定固定端口+日志）
 * @param {() => unknown} opts.sweepRegistry 登记簿清扫（同步返回 {killed,deleted,skipped,errors}）
 * @param {number} [opts.waitMs=500] 每轮清理后等待 socket 句柄释放的毫秒数
 * @param {(msg: string) => void} [opts.log] 每轮结果日志回调
 * @returns {Promise<{ healed: boolean }>}
 */
async function attemptSelfHeal({
  rounds = 3,
  isPortInUse,
  killPortOccupants,
  sweepRegistry,
  waitMs = 500,
  log = () => {},
} = {}) {
  const roundLimit = Math.max(1, rounds);
  for (let round = 1; round <= roundLimit; round++) {
    // 每轮先查端口：未被占（首轮即从未被占，或前轮清理已生效）→ 直接成功
    if (!(await isPortInUse())) {
      log(`[startup-heal] 第 ${round}/${roundLimit} 轮：端口未被占用，无需清理`);
      return { healed: true };
    }
    // 被占 → 杀占用进程 + 登记簿清扫（兜底我方残留），等 waitMs 让句柄真正释放
    log(`[startup-heal] 第 ${round}/${roundLimit} 轮：端口被占用，正在清理…`);
    await killPortOccupants();
    sweepRegistry();
    await new Promise((r) => setTimeout(r, waitMs));
    if (!(await isPortInUse())) {
      log(`[startup-heal] 第 ${round}/${roundLimit} 轮：清理后端口已释放`);
      return { healed: true };
    }
    if (round < roundLimit) {
      log(`[startup-heal] 第 ${round}/${roundLimit} 轮：端口仍被占用，进入下一轮`);
    }
  }
  log(`[startup-heal] 自愈 ${roundLimit} 轮后端口仍被占用，放弃`);
  return { healed: false };
}

module.exports = { attemptSelfHeal };
