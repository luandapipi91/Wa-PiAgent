// mammoth 无类型声明（@types/mammoth 在 npmmirror 404），只声明本仓用到的 API 面。
declare module "mammoth" {
	export function extractRawText(input: { buffer: Buffer }): Promise<{
		value: string;
		messages: Array<{ type: string; message: string }>;
	}>;
}
