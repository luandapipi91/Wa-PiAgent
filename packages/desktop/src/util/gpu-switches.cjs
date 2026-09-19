// GPU 命令行开关（按平台门控）。纯函数，便于单测——main.cjs 直接调用。
//
// 为什么门控（2026-09-18 实测修复）：
// 这四个开关最初是为 Windows 双显卡笔记本（NVIDIA dGPU + Intel iGPU）加的——那里
// Electron 43 默认没启用硬件加速、全进程 GPU 占用为 0，需要强制打开。
// 但 `use-angle=d3d11` 是 **Windows 专属** 的 ANGLE 后端，在 macOS/Linux 上不存在：
// 强制指定后 Chromium 的合成路径进入降级状态，实测同一台 macOS、同一启动页 HTML，
// rAF 出帧率从 60fps 掉到 6~16fps（单变量隔离：只加 d3d11 即复现 9/7/1fps，
// 另外三个单独开均为 57~62fps）。出帧被拖垮 → 新窗口首次绘制严重延迟：
// 启动页长时间空白、进度条卡住不推进、主窗口迟迟不出内容。
// macOS/Linux 的 Chromium 默认已启用 GPU 加速，不需要任何开关。
//
// 返回 [switchName, value?] 列表；main.cjs 逐个 appendSwitch。
function gpuSwitchesFor(platform) {
	// 仅 Windows：d3d11 是 Win 上最稳的 ANGLE 后端（对齐独立 Chrome 的合成路径）
	if (platform !== "win32") return [];
	return [
		["enable-gpu-rasterization"],
		["enable-zero-copy"],
		["use-angle", "d3d11"],
		["ignore-gpu-blocklist"],
	];
}

module.exports = { gpuSwitchesFor };
