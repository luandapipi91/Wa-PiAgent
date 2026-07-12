// systray2 是 CJS（exports.default = SysTray）。Bun 解释执行与 --compile 后的 __toESM
// 互操作层数不同：编译后 .default 被多包一层。这里防御性解包，两种模式都能拿到构造器。
export function unwrapSysTray(namespace: any): any {
  const d = namespace?.default;
  if (typeof d?.default === "function") return d.default;
  if (typeof d === "function") return d;
  return namespace;
}
