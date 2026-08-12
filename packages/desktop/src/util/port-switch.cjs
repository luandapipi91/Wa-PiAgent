// 换端口启动的端口选择策略（纯函数，便于测试）。
// 从固定端口的下一个端口开始，找第一个可用端口。

/**
 * 选择换端口启动的目标端口。
 * @param {number} basePort - 被占用的固定端口
 * @param {Object} deps
 * @param {(startPort: number) => Promise<number|null>} deps.findAvailablePort - 从给定端口开始找可用端口
 * @returns {Promise<number|null>} 新端口，找不到返回 null
 */
async function pickSwitchPort(basePort, { findAvailablePort }) {
	return findAvailablePort(basePort + 1);
}

module.exports = { pickSwitchPort };
