import { test, expect } from "bun:test";
import { remarkSoftBreaks } from "../../src/components/blocks/remark-soft-breaks";

// 思考过程改用 markdown 后，源码里的单换行必须保留（模型常一行一个短句），
// 但不能再靠容器的 white-space: pre-wrap——它会把 react-markdown 在块级元素之间
// 插入的换行文本也显示成空行，loose list 的圆点因此与正文分离、段间出现大段空白。
// 契约：文本节点内的 \n 转成 break 节点（→ <br>），代码块与行内代码原样不动。
function run(tree: any): any {
	remarkSoftBreaks()(tree);
	return tree;
}

test("文本节点内的换行拆成 break 节点", () => {
	const tree = {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [{ type: "text", value: "第一行\n第二行" }],
			},
		],
	};
	const out = run(tree);
	expect(out.children[0].children).toEqual([
		{ type: "text", value: "第一行" },
		{ type: "break" },
		{ type: "text", value: "第二行" },
	]);
});

test("连续换行产生多个 break（不吞行）", () => {
	const tree = {
		type: "root",
		children: [
			{ type: "paragraph", children: [{ type: "text", value: "a\n\nb" }] },
		],
	};
	expect(run(tree).children[0].children).toEqual([
		{ type: "text", value: "a" },
		{ type: "break" },
		{ type: "break" },
		{ type: "text", value: "b" },
	]);
});

test("嵌套结构（列表项 / 引用）里的文本同样处理", () => {
	const tree = {
		type: "root",
		children: [
			{
				type: "blockquote",
				children: [
					{
						type: "list",
						children: [
							{
								type: "listItem",
								children: [
									{ type: "paragraph", children: [{ type: "text", value: "x\ny" }] },
								],
							},
						],
					},
				],
			},
		],
	};
	const paragraph =
		run(tree).children[0].children[0].children[0].children[0];
	expect(paragraph.children).toEqual([
		{ type: "text", value: "x" },
		{ type: "break" },
		{ type: "text", value: "y" },
	]);
});

test("代码块与行内代码的换行不被改写（缩进/换行是语义）", () => {
	const tree = {
		type: "root",
		children: [
			{ type: "code", lang: "ts", value: "const a = 1;\nconst b = 2;" },
			{
				type: "paragraph",
				children: [{ type: "inlineCode", value: "a\nb" }],
			},
		],
	};
	const out = run(tree);
	expect(out.children[0]).toEqual({
		type: "code",
		lang: "ts",
		value: "const a = 1;\nconst b = 2;",
	});
	expect(out.children[1].children).toEqual([{ type: "inlineCode", value: "a\nb" }]);
});
