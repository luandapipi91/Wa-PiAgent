/**
 * 去掉 UTF-8 BOM。
 *
 * Windows PowerShell 5.1 重写 JSON 文件时会写入 UTF-8 BOM（`\uFEFF`），
 * 裸 JSON.parse 会直接抛 SyntaxError。pi 1.4.0 起引擎侧已兼容 BOM，
 * Wa-Pi 自己的 mcp.json / settings.json 解析链需保持同一口径，
 * 否则同一份配置会出现「引擎可读、界面报错」。
 */
export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
