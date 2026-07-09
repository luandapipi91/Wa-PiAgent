// 测试环境 setup：注册 happy-dom + 每个测试后清理 DOM
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

// 注册 happy-dom 全局环境（document, window 等）
GlobalRegistrator.register();

// 每个测试后清理 DOM 残留，防止跨测试污染
afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});
