/**
 * 知识库转换层公共类型
 *
 * ImageSink：图片落盘目标（绝对目录 + md 中的相对引用前缀）；
 * ConvertResult：单次转换的统一产出——markdown 正文、落盘图片路径列表、
 * 走的转换通道标识（via）以及非致命告警（warnings，如损坏图片被跳过）。
 */

/** 图片落盘目录与 md 相对引用前缀 */
export interface ImageSink {
  dirAbs: string; // 图片落盘目录（绝对路径）
  relPrefix: string; // md 中的相对引用前缀（已含 ../ 等，空格已转 %20）
}

/** 单次转换结果 */
export interface ConvertResult {
  markdown: string; // 转换后的 markdown 正文
  images: string[]; // 实际落盘的图片绝对路径列表
  via: string; // 转换通道标识（如 "altChunk(mht→html)"）
  warnings: string[]; // 非致命告警（损坏图片跳过、数量不齐等）
}
