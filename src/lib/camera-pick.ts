// 摄像头选择：默认设备可能是**虚拟摄像头**，而它往往没有用户本人的画面。
//
// 实测（本机 macOS + Chrome，`navigator.mediaDevices.getUserMedia({video:{facingMode:'user'}})`
// 不指定 deviceId 时）Chrome 选中的是 **OBS Virtual Camera**（1920x1080@60）：
//   · OBS 未推流时它 `track.readyState === 'live'` 但 `video.videoWidth === 0`（永远没有帧）；
//   · OBS 推的是桌面/空场景时帧照常来，但画面里没有人脸。
// 两种情况的用户观感都是「一直检测不到我」—— 用户无从知道当前用的是哪个摄像头
// （原来的下拉框只写「摄像头 1 / 摄像头 2」，不显示设备名）。
//
// 本模块只做一件事：**首次取流（未指定 deviceId）时，若当前设备是虚拟摄像头且有实体设备可选，
// 自动改选实体设备**；用户在下拉框里显式选择过的设备不会被改动（那条路径带 deviceId）。

/** 虚拟/合成摄像头的名字特征（macOS 上是中英文混合的，如「OBS Virtual Camera」「虚拟摄像头」）。 */
const VIRTUAL_LABEL = /virtual|obs|虚拟|capture|screen|screencap|dummy|fake|manycam|snap camera/i

export function isVirtualCameraLabel(label: string): boolean {
  return VIRTUAL_LABEL.test(label)
}

/**
 * 当前流若来自虚拟摄像头、且另有实体设备，则改取实体设备并返回新流（旧的会被停掉）；
 * 否则返回 null，调用方沿用原流。
 *
 * 任何一步失败都返回 null —— 这是「尽力而为的改选」，绝不能因此让采集起不来。
 */
export async function preferPhysicalCamera(cur: MediaStream): Promise<MediaStream | null> {
  const label = cur.getVideoTracks()[0]?.label ?? ''
  if (!isVirtualCameraLabel(label)) return null
  let list: MediaDeviceInfo[] = []
  try {
    list = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput' && d.deviceId && d.label,
    )
  } catch {
    return null
  }
  const alt = list.find((d) => !isVirtualCameraLabel(d.label))
  if (!alt) return null
  try {
    const next = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: alt.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
    for (const t of cur.getTracks()) t.stop()
    return next
  } catch {
    return null
  }
}
