/**
 * useTranslation 门面：re-export react-i18next 的 useTranslation，并在模块顶层
 * import "./i18n" 以触发 i18next 实例初始化。
 *
 * 为什么需要门面：react-i18next 的 useTranslation 内部硬编码使用 i18next 的
 * 默认实例。组件应从此处 import useTranslation（而非直接 from "react-i18next"），
 * 这样每个组件的模块图都会经由本模块 → "./i18n" 触发 i18next.init +
 * use(initReactI18next)，保证 useTranslation 拿到的是已初始化实例。
 * （在 bun:test --isolate 下，preload 与各测试文件模块图隔离，组件自身的
 * import 链是确保实例初始化的唯一可靠途径。）
 */
import "./index";
export { useTranslation } from "react-i18next";
