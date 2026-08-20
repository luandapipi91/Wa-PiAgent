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
