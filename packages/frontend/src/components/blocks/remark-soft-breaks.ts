/** mdast 节点（只声明本插件用到的字段，避免引入新的类型依赖） */
interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
}

/**
 * remark 插件：把文本节点里的换行转成 `break`（渲染为 `<br>`），代替容器的
 * `white-space: pre-wrap`。
 *
 * 为什么需要：思考内容常「一行一个短句」，用 markdown 渲染时若靠容器 pre-wrap 保留换行，
 * 源码里的换行会连 react-markdown 在块级元素之间插入的换行一起显示成空行——loose list 的
 * `<li>\n<p>…</p>\n</li>` 因此把列表圆点和正文拆成两行，段与项之间出现大段空白。
 * 交给 remark 把 `\n` 变成真正的 `<br>` 后，换行保留、空白由 CSS 精确控制。
 *
 * 只处理 `text` 节点：`code`（代码块）与 `inlineCode`（行内代码）的换行是语义，
 * 原样不动。
 */
export function remarkSoftBreaks() {
	return (tree: MdNode) => rewrite(tree);
}

function rewrite(node: MdNode): void {
	if (!node.children) return;
	const next: MdNode[] = [];
	for (const child of node.children) {
		if (
			child.type === "text" &&
			typeof child.value === "string" &&
			child.value.includes("\n")
		) {
			const lines = child.value.split("\n");
			lines.forEach((line, i) => {
				if (i > 0) next.push({ type: "break" });
				if (line) next.push({ type: "text", value: line });
			});
			continue;
		}
		rewrite(child);
		next.push(child);
	}
	node.children = next;
}
