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

/**
 * 自愈失败后静默自动换端口 relaunch：先找可用端口，找到才换，找不到返回 false。
 * 依赖全部注入（findAvailablePort/writeSwitchPort/relaunch/exit/argv/env/log），
 * 便于单元测试——绝不真 relaunch、绝不真 exit。
 * @param {number} basePort - 被占用的固定端口
 * @param {Object} deps
 * @param {(startPort: number) => Promise<number|null>} deps.findAvailablePort
 * @param {(port: number) => void} deps.writeSwitchPort - 写 .switch-port 临时文件（relaunch 后新进程读取）
 * @param {(opts: {args: string[], env: Record<string,string>}) => void} deps.relaunch
 * @param {(code: number) => void} deps.exit
 * @param {string[]} [deps.argv] - process.argv（过滤旧 --wa-pi-port）
 * @param {Record<string,string>} [deps.env] - process.env（追加 WA_PI_WS_PORT）
 * @param {(m: string) => void} [deps.log]
 * @returns {Promise<boolean>} 已找到可用端口并 relaunch 为 true；找不到可用端口为 false
 */
async function switchPortAndRelaunch(
	basePort,
	{
		findAvailablePort,
		writeSwitchPort,
		relaunch,
		exit,
		argv = [],
		env = {},
		log = () => {},
	},
) {
	const newPort = await pickSwitchPort(basePort, { findAvailablePort });
	if (!newPort) {
		log(`未找到可用端口（从 ${basePort + 1} 起）`);
		return false;
	}
	log(`端口 ${basePort} 被占用，自动换端口启动 → ${newPort}`);
	writeSwitchPort(newPort);
	const cleanArgs = argv.filter((a) => !a.startsWith("--wa-pi-port="));
	relaunch({
		args: [...cleanArgs, `--wa-pi-port=${newPort}`],
		env: { ...env, WA_PI_WS_PORT: String(newPort) },
	});
	exit(0);
	return true;
}

module.exports = { pickSwitchPort, switchPortAndRelaunch };
