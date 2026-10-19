// build-kernel-sidecar 纯函数测试：运行时依赖清单（精简 external 清单，无 patchedDependencies）。
// 不真的跑编译/下载（那是 Task 6 集成测试与 Task 8 打包冒烟的职责）。
import { test, expect } from "bun:test";
import { buildRuntimeManifest } from "../scripts/build-kernel-sidecar";
import kernelPkg from "../../kernel/package.json" with { type: "json" };

test("buildRuntimeManifest: 精简清单——仅磁盘必需依赖，无 patchedDependencies", () => {
  const m = buildRuntimeManifest() as any;
  expect(m.name).toBe("wa-pi-kernel-sidecar");
  expect(m.private).toBe(true);
  // patch 编译期已生效（内联进 exe），磁盘副本供 -e 扩展加载，无需 patch
  expect(m.patchedDependencies).toBeUndefined();
  // pi-coding-agent：pi RPC 子进程入口 cli.js 必须在磁盘（子进程读不到父进程虚拟 FS）
  expect(m.dependencies["@earendil-works/pi-coding-agent"]).toBeString();
  // keyring：原生 .node 无法内联，external 从磁盘加载
  expect(m.dependencies["@napi-rs/keyring"]).toBeString();
  // 内置 npm 扩展已清空：pi-mcp-adapter / pi-web-access 均已移除，不得再回到清单里
  // （web 工具由自研 web-access 扩展提供，源码随内核 bundle 走 --asset，无需磁盘依赖）
  // 版本与 kernel package.json 单一来源一致（升级依赖时本测试自动跟随，不硬编码版本串）
  expect(m.dependencies["pi-mcp-adapter"]).toBeUndefined();
  expect(m.dependencies["pi-web-access"]).toBeUndefined();
  expect(m.dependencies["@earendil-works/pi-coding-agent"]).toBe(
    kernelPkg.dependencies["@earendil-works/pi-coding-agent"],
  );
  expect(m.dependencies["@napi-rs/keyring"]).toBe(
    kernelPkg.dependencies["@napi-rs/keyring"],
  );
  // 其余内联进 exe 的包不再出现（jiti 在虚拟 FS 内解析）
  expect(m.dependencies["@amaster.ai/pi-memory"]).toBeUndefined();
});
