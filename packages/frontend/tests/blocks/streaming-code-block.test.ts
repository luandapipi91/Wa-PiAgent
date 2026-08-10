// llm-ui 代码块适配层单测：matcher + parse 的纯函数组合。
import { test, expect } from "bun:test";
import { findCompleteCodeBlock, findPartialCodeBlock } from "@llm-ui/code";
import {
  parseStreamingCodeBlock,
  createStreamingCodeBlock,
} from "../../src/components/blocks/streaming-code-block";

test("完整代码块：解析出 language 与 code", () => {
  const match = findCompleteCodeBlock()("前文\n\n```ts\nconst a: number = 1;\n```\n\n后文");
  expect(match).toBeTruthy();
  const { language, code } = parseStreamingCodeBlock(match!.outputRaw, true);
  expect(language).toBe("ts");
  expect(code).toContain("const a: number = 1;");
});

test("未闭合代码块：partial 解析出已有 code", () => {
  const match = findPartialCodeBlock()("前文\n\n```python\nprint('hello')\n");
  expect(match).toBeTruthy();
  const { language, code } = parseStreamingCodeBlock(match!.outputRaw, false);
  expect(language).toBe("python");
  expect(code).toContain("print('hello')");
});

test("无语言标记的代码块：language 为空字符串", () => {
  const match = findCompleteCodeBlock()("```\nplain\n```\n");
  expect(match).toBeTruthy();
  expect(parseStreamingCodeBlock(match!.outputRaw, true).language).toBe("");
});

test("createStreamingCodeBlock 返回合法 LLMOutputBlock（四个字段齐全）", () => {
  const block = createStreamingCodeBlock();
  expect(typeof block.findCompleteMatch).toBe("function");
  expect(typeof block.findPartialMatch).toBe("function");
  expect(typeof block.lookBack).toBe("function");
  expect(typeof block.component).toBe("function");
});
