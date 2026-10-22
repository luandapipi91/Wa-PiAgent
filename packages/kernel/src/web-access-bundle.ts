// web-access-bundle.ts —— 把 web-access 扩展源码与其依赖打成单文件 bundle。
// 为什么打包：扩展经 -e 加载，依赖必须自含（2026-10-19 起引入链接库后，
// 「复制源文件」的部署方式会让裸 import 落空；bundle 化保证产出永远自含）。
// dev：web-access-deploy 现场构建；packaged：compile-binary 预构建并 --asset 嵌入。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 打包扩展源码与依赖为单文件（不 minify：保留可读栈；产物约 1MB 级） */
export async function buildWebAccessBundle(outfile: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [join(__dirname, "web-access.extension.ts")],
		target: "bun",
	});
	if (!result.success) {
		throw new Error(`web-access bundle 失败：${result.logs.map(String).join("\n")}`);
	}
	await Bun.write(outfile, await result.outputs[0].text());
}
