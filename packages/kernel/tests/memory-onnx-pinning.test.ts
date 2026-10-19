// 钉版护栏：onnxruntime-node 必须锁在 1.23.2，且包里必须带 darwin/x64 原生资产。
//
// 为什么需要自动化护栏（最终审查延后 Minor 里性价比最高的一条）：
// 规格 §7.6 要求 Intel Mac 可用，而 onnxruntime-node 的 npm 包是**全平台分发**的 ——
// macOS 的 x64 目录就在包里。上游自 1.30.0 起不再发布该目录（`bin/napi-v6/darwin/` 下
// 只剩 arm64），而 @huggingface/transformers@4.3.0 声明的正是 onnxruntime-node@1.30.0：
// 一旦根 package.json 的 `overrides: { "onnxruntime-node": "1.23.2" }` 失效
//（override 被删 / 被改名 / bun 升级后不再生效），bun install 会静默回落到 1.30.0，
// 产出「Intel Mac 上语义检索永久不可用」的安装包 —— 而本机是 Windows，
// 打包脚本里没有一处能发现这件事，只能靠人工核对。
//
// 本文件在 Windows 上也能跑：npm 包全平台分发，装了 1.23.2 就必然有 darwin/x64 目录。
// 回归检测：把根 package.json 的 overrides 去掉后重装依赖 → 本文件第一条变红。
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** 唯一允许的版本（上游 1.30.0 起 darwin/x64 不再发布） */
const EXPECTED_ORT_VERSION = "1.23.2";
/** 原生绑定目录（版本化目录名，升级换名时本断言也会红） */
const DARWIN_X64_DIR = ["bin", "napi-v6", "darwin", "x64"];

/**
 * 用 Node 解析规则定位已安装的 onnxruntime-node（不依赖 bun 的 node_modules/.bun 布局）。
 * 它不在 kernel 的直接依赖里，是 @huggingface/transformers 的传递依赖，
 * 故从 transformers 的包目录出发解析（与 desktop/scripts/stage-native-assets.ts 同款做法）。
 */
function resolveOrtDir(): string {
  const transformersPkg = Bun.resolveSync(
    "@huggingface/transformers/package.json",
    import.meta.dir,
  );
  const ortPkg = Bun.resolveSync(
    "onnxruntime-node/package.json",
    dirname(transformersPkg),
  );
  return dirname(ortPkg);
}

test(`onnxruntime-node 钉在 ${EXPECTED_ORT_VERSION}（回落 1.30.0 会让 Intel Mac 失去语义检索）`, () => {
  const dir = resolveOrtDir();
  const version = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ).version as string;
  expect(
    version,
    `onnxruntime-node 锁定失效：实际装的是 ${version}，应为 ${EXPECTED_ORT_VERSION}。\n` +
      `  1.30.0 起上游不再发布 bin/napi-v6/darwin/x64（Intel Mac 的语义检索会永久不可用）。\n` +
      `  多半是根 package.json 的 overrides.onnxruntime-node 被删/改名，或 bun 升级后 override 不再生效。\n` +
      `  请恢复 overrides 并重新 bun install。`,
  ).toBe(EXPECTED_ORT_VERSION);
});

test("onnxruntime-node 包内含 darwin/x64 原生资产（Intel Mac 与交叉打包的前提）", () => {
  const target = join(resolveOrtDir(), ...DARWIN_X64_DIR);
  let entries: string[] = [];
  try {
    entries = readdirSync(target).filter((f) => statSync(join(target, f)).isFile());
  } catch {
    entries = [];
  }
  expect(
    entries.length,
    `包内缺少 ${join(...DARWIN_X64_DIR)}（或目录为空）：${target}\n` +
      `  这是 npm 包的全平台分发内容。若版本已是 ${EXPECTED_ORT_VERSION} 却仍缺，\n` +
      `  说明上游改了资产布局（目录名/文件名变了）→ 打包脚本的 keep 过滤与\n` +
      `  onnxruntime 运行时寻址路径都要同步核对，否则会产出语义检索不可用的安装包。`,
  ).toBeGreaterThan(0);
});
