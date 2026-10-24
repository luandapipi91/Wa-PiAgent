import { test, expect, describe } from "bun:test";
import {
	parseEditDiff,
	buildEditPreview,
	intraLineDiff,
	diffSummary,
} from "../src/components/blocks/EditDiffView";

// pi edit 工具的 details.diff 行格式：
//   "+<新行号> 内容" / "-<旧行号> 内容" / " <旧行号> 内容" / "  ..."（省略）
// 参考 pi-coding-agent dist/core/tools/edit-diff.js generateDiffString

describe("parseEditDiff 解析 pi 的 diff 字符串", () => {
	test("上下文行推导双列行号：newNo = oldNo + 净增行数", () => {
		const lines = parseEditDiff(
			[
				" 40 type mallOrderMsg struct {",
				"+41 \tLastUpdateUser json.RawMessage",
				" 41 \tMallOrder *struct {",
			].join("\n"),
		);

		expect(lines).toEqual([
			{ kind: "ctx", oldNo: 40, newNo: 40, text: "type mallOrderMsg struct {" },
			{ kind: "add", oldNo: null, newNo: 41, text: "\tLastUpdateUser json.RawMessage" },
			{ kind: "ctx", oldNo: 41, newNo: 42, text: "\tMallOrder *struct {" },
		]);
	});

	test("删除行只占旧行号，并让后续上下文行号前移", () => {
		const lines = parseEditDiff(
			["-67 \tCreateUser: rawString(a),", "+68 \tCreateUser: rawString(b),", " 68 })"].join(
				"\n",
			),
		);

		expect(lines[0]).toEqual({
			kind: "del",
			oldNo: 67,
			newNo: null,
			text: "\tCreateUser: rawString(a),",
		});
		expect(lines[1]).toEqual({
			kind: "add",
			oldNo: null,
			newNo: 68,
			text: "\tCreateUser: rawString(b),",
		});
		// 净增 0（1 删 1 增）→ ctx 双列相同
		expect(lines[2]).toEqual({ kind: "ctx", oldNo: 68, newNo: 68, text: "})" });
	});

	test("省略行解析为 gap，并用前后上下文行号算出跳过行数", () => {
		const lines = parseEditDiff(
			[" 40 a", "  ...", " 60 b"].join("\n"),
		);

		expect(lines[1]).toEqual({ kind: "gap", skipped: 19 });
	});

	test("省略行后跟删除行时，也能用旧行号算出跳过行数", () => {
		const lines = parseEditDiff([" 40 a", "  ...", "-60 b"].join("\n"));
		expect(lines[1]).toEqual({ kind: "gap", skipped: 19 });
	});

	test("开头/结尾的省略行无法算行数时 skipped 为 null", () => {
		expect(parseEditDiff("  ...\n 40 a")[0]).toEqual({
			kind: "gap",
			skipped: null,
		});
		expect(parseEditDiff(" 40 a\n  ...")[1]).toEqual({
			kind: "gap",
			skipped: null,
		});
	});

	test("跳过 +++/--- 文件头，忽略无法识别的行", () => {
		const lines = parseEditDiff(
			["--- a/x.go", "+++ b/x.go", " 1 package x", "garbage"].join("\n"),
		);
		expect(lines).toEqual([
			{ kind: "ctx", oldNo: 1, newNo: 1, text: "package x" },
		]);
	});

	test("空字符串 / 畸形输入返回空数组", () => {
		expect(parseEditDiff("")).toEqual([]);
		expect(parseEditDiff("   ")).toEqual([]);
	});
});

describe("buildEditPreview 执行中的块级预览", () => {
	test("多块 edits：每块先删除行后新增行，块之间插 gap，行号不伪造", () => {
		const lines = buildEditPreview({
			path: "a.go",
			edits: [
				{ oldText: "a\nb", newText: "a\nb\nc" },
				{ oldText: "x", newText: "y" },
			],
		});

		expect(lines).toEqual([
			{ kind: "del", oldNo: null, newNo: null, text: "a" },
			{ kind: "del", oldNo: null, newNo: null, text: "b" },
			{ kind: "add", oldNo: null, newNo: null, text: "a" },
			{ kind: "add", oldNo: null, newNo: null, text: "b" },
			{ kind: "add", oldNo: null, newNo: null, text: "c" },
			{ kind: "gap", skipped: null },
			{ kind: "del", oldNo: null, newNo: null, text: "x" },
			{ kind: "add", oldNo: null, newNo: null, text: "y" },
		]);
	});

	test("兼容平铺 oldText/newText 参数", () => {
		expect(buildEditPreview({ path: "a", oldText: "x", newText: "y" })).toEqual([
			{ kind: "del", oldNo: null, newNo: null, text: "x" },
			{ kind: "add", oldNo: null, newNo: null, text: "y" },
		]);
	});

	test("畸形参数（null / 非字符串 / 混合）不崩溃，整体返回空数组", () => {
		expect(buildEditPreview({ path: "a", edits: [null] })).toEqual([]);
		expect(buildEditPreview({ path: "a", edits: [{ oldText: {}, newText: 1 }] })).toEqual(
			[],
		);
		// 混合：一个合法 + 一个畸形 → 整体降级，不渲染残缺预览
		expect(
			buildEditPreview({
				path: "a",
				edits: [{ oldText: "x", newText: "y" }, { oldText: { bad: true } }],
			}),
		).toEqual([]);
	});
});

describe("intraLineDiff 词级高亮切分", () => {
	test("单行替换：提取公共前后缀，中间段高亮", () => {
		const r = intraLineDiff(
			"\tCreateUser: rawString(msg.MallOrder.LastUpdateUser),",
			"\tCreateUser: rawString(pickRaw(msg.LastUpdateUser, msg.MallOrder.LastUpdateUser)),",
		);
		expect(r.oldChanged).toBe("msg.MallOrder.LastUpdateUser");
		expect(r.newChanged).toBe(
			"pickRaw(msg.LastUpdateUser, msg.MallOrder.LastUpdateUser)",
		);
	});

	test("完全不同 → 整行都算变更", () => {
		const r = intraLineDiff("abc", "xyz");
		expect(r).toEqual({ prefix: "", oldChanged: "abc", newChanged: "xyz", suffix: "" });
	});

	test("纯插入（旧行是新行前缀）→ 旧行无高亮段", () => {
		const r = intraLineDiff("abc", "abcdef");
		expect(r.oldChanged).toBe("");
		expect(r.newChanged).toBe("def");
	});
});

describe("diffSummary 变更块摘要", () => {
	test("按连续变更分组，统计每块首行与增删数", () => {
		const lines = parseEditDiff(
			[
				" 40 a",
				"+41 b",
				" 41 c",
				"  ...",
				"-67 d",
				"+68 e",
			].join("\n"),
		);
		expect(diffSummary(lines)).toEqual([
			{ line: 41, added: 1, removed: 0 },
			{ line: 67, added: 1, removed: 1 },
		]);
	});

	test("无变更行 → 空数组", () => {
		expect(diffSummary(parseEditDiff(" 1 a"))).toEqual([]);
	});
});
