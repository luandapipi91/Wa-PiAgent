// kernel-error-code.ts —— KernelError code 断言辅助。
//
// 背景：store/service 层的面向用户错误从「中文文案 Error」迁移为 KernelError
// （message=code，人话文案由前端 kernelMsg 字典按 code 渲染），既有测试断言从
// toThrow("中文文案") 改为断言 e.code。捕获 rejection 并返回 code；未抛错或
// 无 code 时返回空串，断言即失败——避免在每个测试文件重复 try/catch 样板。
export async function errorCodeOf(p: Promise<unknown>): Promise<string> {
	const e = await p.then(
		() => null as { code?: string } | null,
		(e: { code?: string }) => e,
	);
	return e?.code ?? "";
}
