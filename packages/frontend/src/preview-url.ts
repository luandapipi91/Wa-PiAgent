/** 是否为 html 文件（.html / .htm，忽略 query/hash，大小写不敏感） */
export function isHtmlPath(path: string): boolean {
	const clean = path.split("?")[0].split("#")[0].toLowerCase();
	return clean.endsWith(".html") || clean.endsWith(".htm");
}

/** 构造 /preview 同源预览 URL：/preview/<编码后的目录>/<编码后的文件名> */
export function buildPreviewUrl(absPath: string): string {
	const slash = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
	const dir = slash === -1 ? "" : absPath.slice(0, slash);
	const base = slash === -1 ? absPath : absPath.slice(slash + 1);
	return `/preview/${encodeURIComponent(dir)}/${encodeURIComponent(base)}`;
}

/**
 * 把地址栏输入转成外部 URL。
 * - http/https 输入：解析校验（空 host 视为非法）后原样返回
 * - 无协议输入：域名/IP/localhost 形态补协议（回环 host 补 http://，其余补 https://）；
 *   `.html`/`.htm` 结尾视为本地文件形态，返回 null（歧义由调用方处理）
 * - 其他（绝对路径、相对路径、乱文字、空）返回 null
 */
export function toExternalUrl(raw: string): string | null {
	const p = raw.trim();
	if (/^https?:\/\//i.test(p)) {
		try {
			const u = new URL(p);
			return u.host ? u.href : null;
		} catch {
			return null;
		}
	}
	// 无协议输入：`.html`/`.htm` 结尾大概率是本地文件，不做外部 URL
	if (/\.html?$/i.test(p.split(/[/?#]/)[0])) return null;
	const hostish =
		/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#].*)?$/i.test(p) ||
		/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+(:\d+)?([/?#].*)?$/.test(
			p,
		);
	if (!hostish) return null;
	// 回环 host（localhost/IP）多为本地 http dev server，补 http；其余补 https
	const loopback = /^(localhost|127\.0\.0\.1|\[::1\])/i.test(p);
	return (loopback ? "http://" : "https://") + p;
}
