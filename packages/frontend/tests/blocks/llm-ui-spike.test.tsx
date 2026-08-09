// llm-ui React 19 兼容性 spike（流式卡顿修复 3.4 前置验证）。
// 验证点：useLLMOutput 在 React 19.2 + happy-dom 下正常渲染；
// 代码块完整/部分匹配器按预期分段；markdown fallback 正常渲染。
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { useLLMOutput } from "@llm-ui/react";
import type { BlockMatch } from "@llm-ui/react";
import { markdownLookBack } from "@llm-ui/markdown";
import {
  codeBlockLookBack,
  findCompleteCodeBlock,
  findPartialCodeBlock,
  parseCompleteMarkdownCodeBlock,
  parsePartialMarkdownCodeBlock,
} from "@llm-ui/code";

function Probe({ output }: { output: string }) {
  const { blockMatches } = useLLMOutput({
    llmOutput: output,
    isStreamFinished: false,
    blocks: [
      {
        findCompleteMatch: findCompleteCodeBlock(),
        findPartialMatch: findPartialCodeBlock(),
        lookBack: codeBlockLookBack(),
        component: ({ blockMatch }: { blockMatch: BlockMatch }) => (
          <pre data-testid="spike-code">{blockMatch.outputRaw}</pre>
        ),
      },
    ],
    fallbackBlock: {
      lookBack: markdownLookBack(),
      component: ({ blockMatch }: { blockMatch: BlockMatch }) => (
        <div data-testid="spike-md">{blockMatch.output}</div>
      ),
    },
  });
  return (
    <>
      {blockMatches.map((m, i) => {
        const C = m.block.component as any;
        return <C key={i} blockMatch={m} />;
      })}
    </>
  );
}

test("spike：React 19 下 useLLMOutput 渲染不抛错，文本与闭合代码块正确分段", () => {
  render(<Probe output={"前文\n\n```js\nconst x = 1;\n```\n\n"} />);
  expect(screen.getByTestId("spike-code").textContent).toContain("const x = 1;");
  // llm-ui 会把代码围栏前/后的文本各切成一个 markdown fallback 块，故此输入产生
  // 两个 spike-md（首段「前文」+ 尾段空文本）。这是正确的流式分段行为，用
  // getAllByTestId 取全部回退块，断言至少有一段包含「前文」。
  // （简报原稿用 getByTestId，在多 fallback 块场景下会因 multiple-match 抛错——
  // 属测试写法问题，非 React 19 运行时不兼容，已记录于 task-4-report。）
  const mdBlocks = screen.getAllByTestId("spike-md");
  expect(mdBlocks.some((el) => el.textContent?.includes("前文") ?? false)).toBe(true);
});

test("spike：未闭合代码块走 partial 匹配器", () => {
  render(<Probe output={"前文\n\n```js\nconst x ="} />);
  expect(screen.getByTestId("spike-code").textContent).toContain("const x =");
});

test("spike：parse 函数从匹配结果提取 language 与 code", () => {
  const complete = findCompleteCodeBlock()("```ts\nlet a = 1;\n```\n");
  expect(complete).toBeTruthy();
  const pc = parseCompleteMarkdownCodeBlock(complete!.outputRaw);
  expect(pc.language).toBe("ts");
  expect(pc.code).toContain("let a = 1;");
  const partial = findPartialCodeBlock()("```python\nprint(1)\n");
  expect(partial).toBeTruthy();
  const pp = parsePartialMarkdownCodeBlock(partial!.outputRaw);
  expect(pp.language).toBe("python");
  expect(pp.code).toContain("print(1)");
});
