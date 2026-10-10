// 摄像头启动失败时，把 DOMException.name 变成用户可读文案。
//
// 形态沿用 quality.ts 的 POSE_KEY：**名字 → i18n 键**的映射表，取值时再 t()，
// 所以中英两张表各自决定文案，这里不出现任何一句硬编码文案。
//
// 为什么是「映射表 + 原样回落」而不是穷举：name 的取值集合由浏览器实现决定、随版本新增，
// 穷举不可能。表外的 name **原样上屏** —— SecurityError / NotSupportedError 这类原始 name
// 是排查依据，丢弃它等于把「为什么打不开摄像头」这条线索一起丢掉。
//
// 表里只放「会落到 cameraFailed 分支」的 name：NotAllowedError / NotFoundError /
// OverconstrainedError / NotReadableError 已被 CaptureView.vue 的前置分支分流成
// cameraDenied / cameraNotFound / cameraBusy，放进来就是永不命中的死条目。
//
// 单独成模块而不是写在组件里：CaptureView.vue 有 800 行阈值（判据 S20），
// 仓库既有做法就是把这类纯映射抽出组件（先例：upload-batch.ts、batch-files.ts）。
import { t, type MessageKey } from './i18n'

const CAMERA_ERR_KEY: Record<string, MessageKey> = {
  SecurityError: 'cameraErrSecurity',
  NotSupportedError: 'cameraErrUnsupported',
  TypeError: 'cameraErrType',
  AbortError: 'cameraErrAbort',
}

/**
 * cameraFailed 文案里 `{err}` 槽位的取值。
 *
 * - 命中映射表 → 当前语言下的说明（中文界面不会出现中英混排）
 * - 未命中 → 原始 name 原样返回（保留排查信息）
 * - 连 name 都没有 → i18n 兜底文案 cameraErrUnknown（此前是硬编码英文 'unknown'）
 */
export function cameraErrText(name?: string): string {
  const key = name ? CAMERA_ERR_KEY[name] : undefined
  return key ? t(key) : (name ?? t('cameraErrUnknown'))
}
