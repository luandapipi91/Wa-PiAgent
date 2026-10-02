// pi-catalog 数据访问契约测试：目录改为「直接读 pi-ai 自带 JSON」后，钉住三件事——
//   ① provider 列表与模型数来自数据文件（不是执行模块）
//   ② 只取 chat 类、且字段与 pi-ai 数据逐项一致（抽样 deepseek-flash）
//   ③ provider 显示名仍能从各家模块文本里提取到（缺一个就会在 UI 上退化成 slug）
//
// 这些都是「跑在真实安装的 pi-ai 上」的契约测试：pi 升级后数据变了，这里会红，提醒重核。
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAllCatalogModels,
  getBuiltinProviderIds,
  getProviderDisplayName,
} from "../src/pi-catalog.ts";

/** 空 agentDir：避免读到真实 <WA_PI_DIR>/models-store.json 的远程覆盖层，只测内置目录 */
function emptyAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-catalog-data-"));
}

describe("目录数据来自 pi-ai 的 JSON 数据文件", () => {
  test("provider 列表非空且含常见家（data/ 目录里每家一个文件）", async () => {
    const ids = await getBuiltinProviderIds();
    expect(ids.length).toBeGreaterThan(30);
    expect(ids).toContain("deepseek");
    expect(ids).toContain("openrouter");
    // 顺序稳定（同一次读取内一致），便于上层做「先按 manifest 顺序」的展示
    expect(await getBuiltinProviderIds()).toEqual(ids);
  });

  test("只含 chat 类模型（classifier/image 不进目录——与替换前 all.js 口径一致）", async () => {
    const models = await getAllCatalogModels(emptyAgentDir());
    expect(models.length).toBeGreaterThan(1000);
    const nonChat = models.filter(
      (m) => ((m as { type?: string }).type ?? "chat") !== "chat",
    );
    expect(nonChat).toEqual([]);
  });

  test("字段与 pi-ai 数据逐项一致（抽样 deepseek-flash）", async () => {
    const models = await getAllCatalogModels(emptyAgentDir());
    const flash = models.find(
      (m) => m.provider === "deepseek" && m.id === "deepseek-flash",
    );
    expect(flash).toBeTruthy();
    expect(flash?.name).toBe("DeepSeek V4.1 Flash");
    expect(flash?.api).toBe("openai-completions");
    expect(flash?.contextWindow).toBe(1000000);
    expect(flash?.maxTokens).toBe(384000);
    expect(flash?.cost.input).toBe(0.3);
    expect(flash?.cost.output).toBe(1.2);
    expect(flash?.reasoning).toBe(true);
    // thinkingLevelMap 必须透传（丢了会让 pi 侧钳制失效，见 CatalogModel 注释）
    expect(flash?.thinkingLevelMap?.max).toBe("max");
  });
});

describe("provider 显示名（从各家模块文本提取，不执行模块）", () => {
  test("常见家能拿到人类可读名", async () => {
    expect(await getProviderDisplayName("deepseek")).toBe("DeepSeek");
    expect(await getProviderDisplayName("openrouter")).toBe("OpenRouter");
  });

  test("全部内置 provider 都能提取到名字（提取不到会退化成 slug，这里直接拦住）", async () => {
    const ids = await getBuiltinProviderIds();
    const fellBack = [];
    for (const id of ids) {
      if ((await getProviderDisplayName(id)) === id) fellBack.push(id);
    }
    expect(fellBack).toEqual([]);
  });

  test("未知 provider 回退为 key 本身（不抛错）", async () => {
    expect(await getProviderDisplayName("not-a-real-provider")).toBe(
      "not-a-real-provider",
    );
  });
});
