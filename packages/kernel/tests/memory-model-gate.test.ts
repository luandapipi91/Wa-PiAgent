// 模型可用性门的三态判定（覆盖整个分支的最终审查 I2）。
//
// 背景：6 个测试文件的顶层探测原先都是 `(await embedQuery(...)) === null → 全部 skipIf`，
// 这把「环境没网」与「模型加载被改坏」混为一谈 —— dtype / localModelPath /
// allowRemoteModels / 模型目录名任一被改坏，这些用例都会**静默 skip 而不是变红**，
// 在无网机器 / CI 上「全绿」；而规格 §7.1（语义召回）与 §7.3（降级）的全部断言
// 都挂在这道门上。
//
// 现改为三态：available（照常跑）/ noSource（真没来源 → skip）/ broken（声明了来源却仍
// 加载失败 → 判红）。判定逻辑抽成纯函数 classifyModelProbe，本文件直接钉住三态口径：
// 把 broken 改回 noSource（即回到修复前的行为）本文件立刻变红。
import { test, expect } from "bun:test";
import { classifyModelProbe } from "./helpers/model-gate";

const none = { probeOk: false, probeError: null, envDir: null, cacheDir: null };

test("探测拿到向量 → available", () => {
  const g = classifyModelProbe({ ...none, probeOk: true });
  expect(g.status).toBe("available");
});

test("探测失败且本机没有任何模型来源 → noSource（环境不具备条件，skip）", () => {
  const g = classifyModelProbe(none);
  expect(g.status).toBe("noSource");
  expect(g.detail).toContain("WA_PI_MODEL_DIR");
  expect(g.detail).toContain("skip");
});

test("WA_PI_MODEL_DIR 已设置却加载失败 → broken（真实故障，不许静默 skip）", () => {
  const g = classifyModelProbe({ ...none, envDir: "D:/models" });
  expect(g.status).toBe("broken");
  expect(g.detail).toContain("WA_PI_MODEL_DIR=D:/models");
  expect(g.detail).toContain("真实故障");
});

test("本机缓存里有该模型却加载失败 → broken（同属真实故障）", () => {
  const g = classifyModelProbe({ ...none, cacheDir: "C:/cache/Xenova/bge-small-zh-v1.5" });
  expect(g.status).toBe("broken");
  expect(g.detail).toContain("bge-small-zh-v1.5");
});

test("探测期抛异常不再炸在模块顶层：有来源 → broken，无来源 → noSource", () => {
  const thrown = { ...none, probeError: "TypeError: 推理失败" };
  expect(classifyModelProbe(thrown).status).toBe("noSource");
  const withSource = classifyModelProbe({ ...thrown, envDir: "D:/models" });
  expect(withSource.status).toBe("broken");
  expect(withSource.detail).toContain("推理失败");
});
