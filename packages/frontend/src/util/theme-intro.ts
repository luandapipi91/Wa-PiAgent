/**
 * 主题引导是否应弹出：老用户（已有模型供应商）且从未记录过本次主题改版的引导。
 * 新装用户由新手引导承载（第 1 步即主题选择），这里返回 false 避免重复打扰。
 */
export function shouldShowThemeIntro(input: {
	appVersion: string;
	seenVersion: string | undefined;
	hasProvider: boolean;
	/** 新手引导是否正开着（新用户在向导第 1 步已选过主题，不该再叠一层） */
	onboardingOpen?: boolean;
}): boolean {
	const { appVersion, seenVersion, hasProvider, onboardingOpen } = input;
	// 版本号兜底值（浏览器 dev 未注入）无法判定是否升级，不弹
	if (!appVersion || appVersion === "—") return false;
	// 新装用户走完整新手引导（向导开着时也不叠层：用户刚在第 1 步选过主题）
	if (!hasProvider || onboardingOpen) return false;
	// 记录过即不再弹；后续版本升级也不重复打扰
	return !seenVersion;
}
