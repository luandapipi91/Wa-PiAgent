// GPU 状态摘要（纯函数）：把 Electron 的 GPU 状态压成一行可读日志。
//
// 为什么需要：原启动日志用 `log.info("GPU 信息:", JSON.stringify(...))`，但 log.cjs 的
// info 只接受一个参数（`info: (m) => write("INFO", m)`），第二个参数被静默丢弃 →
// 日志里「GPU 信息:」后面永远是空的。而「有没有走硬件加速」恰恰是排查「启动出帧慢」的
// 第一现场事实（实测：四个强制开关会把 GPU 整个关掉 → gpu_compositing=disabled_software
// → 软件渲染 → 出帧掉到个位数 → 启动页空白/进度条不动）。故改成单字符串摘要 + ⚠️ 标记。

/** 合成器没跑在 GPU 上（disabled_software / disabled_off 等）即视为退化。 */
function isSoftwareFallback(featureStatus) {
	const v = featureStatus && featureStatus.gpu_compositing;
	return !v || v !== "enabled";
}

function pick(featureStatus, key) {
	const v = featureStatus ? featureStatus[key] : undefined;
	return v === undefined ? "?" : String(v);
}

/**
 * 生成一行 GPU 状态摘要。
 * @param {Record<string,string>|undefined} featureStatus app.getGPUFeatureStatus()
 * @param {Array<{active?:boolean,deviceString?:string}>|undefined} gpuDevice getGPUInfo 的 gpuDevice
 */
function summarizeGpuStatus(featureStatus, gpuDevice) {
	const dev = Array.isArray(gpuDevice)
		? gpuDevice.find((d) => d && d.active) ?? gpuDevice[0]
		: undefined;
	let deviceText;
	if (!featureStatus && !dev) deviceText = "未知";
	else if (!dev) deviceText = "未知";
	else if (dev.active === false) deviceText = "未激活";
	else deviceText = String(dev.deviceString || "未知");

	const head = isSoftwareFallback(featureStatus)
		? "⚠️ 软件渲染（GPU 合成未启用）"
		: "硬件加速";
	return [
		head,
		`合成=${pick(featureStatus, "gpu_compositing")}`,
		`光栅=${pick(featureStatus, "rasterization")}`,
		`2D=${pick(featureStatus, "2d_canvas")}`,
		`WebGL=${pick(featureStatus, "webgl")}`,
		`GPU=${deviceText}`,
	].join(" ");
}

module.exports = { summarizeGpuStatus, isSoftwareFallback };
