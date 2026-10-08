// 采集点产物的装配：把「本步连拍的照片」与「本步的视频段」拼成待提交文件清单，
// 并给出视频段在结果清单里的登记项。
//
// 为什么单独成模块（R23 抽出，非新功能）：
// 1. 文件名必须在「待提交文件」与「结果清单」两侧一致 —— 早先只在连拍分支写结果清单，
//    emit 的 payload 恒为 10 条而真实上传 16 个文件（缺的 6 个正是各采集点的
//    `*_video_*.webm`），与 `CaptureResult[]` 的声明自相矛盾。装配放在一处就不会再分叉。
// 2. 视频步不产生照片（`shots` 为空），照片步的 kind 恒为 `'image'` ——
//    原实现用 `isVideo ? 'video' : 'image'` 给照片取名，那个三元永远走不到 'video'，
//    是条死分支；这里直接用 'image'，并让类型系统保证视频段走 kind: 'video'。
// 3. 组件的行数有 800 行硬阈值（仓库标准 S20）。
import { extFor } from './capture'
import type { CaptureMeta, CaptureResult, PendingFile } from './pb'

export interface PoseFiles {
  /** 本采集点要提交的全部文件（照片在前、视频段在后） */
  files: PendingFile[]
  /** 视频段在结果清单里的登记项；本采集点没有可用视频时为 null */
  videoResult: CaptureResult | null
}

/**
 * 装配本采集点的文件清单。
 *
 * @param step 当前采集点（姿态名，进文件名与落库的 pose 字段）
 * @param shots 连拍得到的照片（视频步为空数组）
 * @param poseVideo 段收尾取出的视频；段被丢弃、收尾出错或本步无录制时为 null
 * @param meta 本采集点共用的落库元数据（照片与视频段共用同一个对象引用）
 * @param stamp 文件名用的时间戳（由调用方注入，便于判据固定取值）
 */
export function buildPoseFiles(args: {
  step: string
  shots: { blob: Blob; filename: string }[]
  poseVideo: { blob: Blob; mime: string } | null
  meta: CaptureMeta
  stamp: () => string
}): PoseFiles {
  const files: PendingFile[] = args.shots.map((x) => ({
    pose: args.step,
    blob: x.blob,
    filename: x.filename,
    kind: 'image' as const,
    meta: args.meta,
  }))
  if (!args.poseVideo) return { files, videoResult: null }
  // 文件名先取成变量：待提交文件与结果清单必须用同一个名字。
  const filename = `${args.step}_video_${args.stamp()}.${extFor(args.poseVideo.mime)}`
  files.push({
    pose: args.step,
    blob: args.poseVideo.blob,
    filename,
    kind: 'video',
    meta: args.meta,
  })
  return { files, videoResult: { pose: args.step, filename } }
}
