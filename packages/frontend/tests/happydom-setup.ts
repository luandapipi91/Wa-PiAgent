// bun:test 的 DOM 测试 preload:注册 happy-dom 全局 + WebSocket polyfill。
// vitest 时代靠 vitest.config.ts 的 environment+setupFiles;迁 bun:test 后改用 preload。
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// 组件直接 import 的 .css（如 react-complex-tree/lib/style-modern.css）在 bun:test
// 下无法处理，统一 mock 成空模块，避免加载即崩。
Bun.plugin({
  name: "ignore-css",
  setup(build) {
    build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "ignore-css" }));
    build.onLoad({ filter: /\.css$/, namespace: "ignore-css" }, () => ({ contents: "", loader: "js" }));
  },
});

GlobalRegistrator.register();

// 为前端测试提供可用的 IndexedDB（happy-dom 未实现）
// @ts-ignore：fake-indexeddb 的 types 在 exports 解析上有问题，运行时无影响
await import("fake-indexeddb/auto");

// @testing-library/react 的 auto-cleanup 只在模块首次加载时注册一次 afterEach，
// 仅对「触发首次加载的那个文件」生效。bun 多文件共享同一 happy-dom document →
// 跨文件 body 残留，getByTestId 会命中上个文件遗留的元素。这里在每个文件 preload
// 里显式注册 afterEach 清空 body 兜底（不直接 import @testing-library/react，避免
// 抢在 happy-dom 注册前缓存 document 引用）。需要 cleanup() 的测试文件自行注册。
afterEach(() => {
  document.body.innerHTML = "";
});
