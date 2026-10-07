// 极简 i18n：按浏览器语言在中文/英文之间切换，不引入任何依赖。
const M = {
  zh: {
    loadingModel: '正在加载人脸模型…',
    modelFailed: '人脸模型加载失败，请刷新页面重试',

    poseFrontal: '请正对镜头',
    poseLeft30: '请向左转头',
    poseRight30: '请向右转头',
    poseUp: '请抬起头',
    poseDown: '请低下头',
    poseLiveness: '请正对镜头，准备录像',

    hintNoFace: '未检测到人脸',
    hintMultiFace: '画面中只能有一人',
    hintTooFar: '请靠近镜头',
    hintOpenEyes: '请睁开眼睛',
    hintYawTooMuchLeft: '向左转过头了，请回正一些',
    hintYawTooMuchRight: '向右转过头了，请回正一些',
    hintPitchUp: '请稍微抬头',
    hintPitchDown: '请稍微低头',
    // 俯仰超出兜底上限（|pitch| > MAX_PITCH）时的措辞：此处幅度已远超目标区间，
    // 「请稍微…」会低估需要回调的量，改为明确的「幅度过大 + 回正」。
    hintPitchTooFarUp: '抬头幅度过大，请回正一些',
    hintPitchTooFarDown: '低头幅度过大，请回正一些',
    hintRoll: '请勿歪头',
    hintTurnLeft: '再向左转一点',
    hintTurnRight: '再向右转一点',
    hintLookUp: '再抬一点头',
    hintLookDown: '再低一点头',
    hintHeadLevel: '头回正一点',
    hintStraighten: '头回正一点',
    hintFaceFront: '正对镜头',
    hintBlurry: '画面模糊，请保持稳定',
    hintTooDark: '光线太暗，请补光',
    hintTooBright: '光线过亮，请避开强光',
    hintHoldStill: '保持不动，正在拍摄…',
    // 录制收尾（等 onstop、补足最短录制时长）与「上传」是两件事，文案必须分开：
    // 此前收尾阶段直接显示「上传中…」，而收尾在 iOS WKWebView 上会卡住，
    // 界面便永久停在上传文案上 —— 用户以为在上传，其实一条请求都没发出去。
    hintFinalizing: '正在处理，请稍候…',
    hintUploading: '上传中…',
    // 提交重试全部失败后的终态文案。此前失败后界面仍停留在「上传中…」，
    // 用户既不知道失败、也没有可点的入口（已采文件只在内存，刷新即丢）。
    hintUploadFailed: '上传失败，请检查网络后点下方「重新提交」',
    // 不要在这里再加「请」：pose* 系列文案本身已带祈使语气（「请正对镜头」等），
    // 加了会拼成「请请正对镜头」。
    hintCameraOn: '{pose}',

    cameraDenied: '摄像头权限被拒绝，请在浏览器允许摄像头后刷新页面',
    cameraNotFound: '未检测到可用摄像头',
    cameraBusy: '摄像头被其他程序占用，请关闭其他程序后刷新页面',
    cameraFailed: '摄像头启动失败（{err}）',
    // 采集中途设备断开（拔掉 USB 摄像头 / 系统撤销权限 / 被其他程序抢占）。
    // 单独一条的原因：此时画面会停在最后一帧，逐帧判定只会报「未检测到人脸」，
    // 用户会误以为是自己姿势的问题。
    cameraLost: '摄像头已断开，请检查设备后刷新页面',
    // 录制器创建失败（MediaRecorder 构造抛错 / 流不可用）：该采集点不会产出视频段。
    // 此前调用方不检查返回值，视频段静默丢失；这里给出可见后果，用户可选择重试或继续。
    segmentFailed: '本段视频录制启动失败，该采集点将没有视频',

    retry: '重试',
    retryUpload: '重新提交',
    uploadFailed: '上传失败',
    failed: '失败：{msg}（保持姿态会自动重试）',
    failedMax: '连续失败，请检查网络后点「重试」',
    uploading: '上传中…',
    camera: '摄像头 {n}',

    doneTitle: '识别完成',
    again: '重新识别',
    linkMissing: '链接中缺少采集编号',
    linkTooLong: '采集编号过长（最多 200 个字符）',

    metricFaceWidth: '脸宽',
    metricSharpness: '清晰度',
    metricLight: '亮度',
    metricCamera: '摄像头',
    metricYaw: '左右转动',
    metricPitch: '上下俯仰',
    metricBlink: '眨眼',
    // 调试面板用语（?debug=1 时可见）
    debugLevel: '平视',
    debugUp: '抬头',
    debugDown: '低头',
    debugUploading: '正在上传…',
    debugUploadFailed: '上传失败：',
    debugPending: '待提交',
    debugFilesUnit: '个文件',
    metricRoll: '头部倾斜',
    emptyRecording: '录制结果为空',
    // 采集过程内部的异常（取帧失败等）。技术细节不进界面 —— 否则切到英文时会中英混杂，
    // 且内部错误对用户没有可操作性。细节见控制台（?debug=1）。
    captureFailed: '采集出错，请保持姿态',
  },
  en: {
    loadingModel: 'Loading face model…',
    modelFailed: 'Failed to load face model, please refresh the page',

    poseFrontal: 'Please face the camera',
    poseLeft30: 'Please turn your head left',
    poseRight30: 'Please turn your head right',
    poseUp: 'Please look up',
    poseDown: 'Please look down',
    poseLiveness: 'Face the camera; recording starts next',

    hintNoFace: 'No face detected',
    hintMultiFace: 'Only one person is allowed in frame',
    hintTooFar: 'Please move closer to the camera',
    hintOpenEyes: 'Please open your eyes',
    hintYawTooMuchLeft: 'Turned too far left, please straighten up',
    hintYawTooMuchRight: 'Turned too far right, please straighten up',
    hintPitchUp: 'Please raise your head slightly',
    hintPitchDown: 'Please lower your head slightly',
    hintPitchTooFarUp: 'Head tilted up too far, please level it a bit',
    hintPitchTooFarDown: 'Head tilted down too far, please level it a bit',
    hintRoll: 'Please keep your head upright',
    hintTurnLeft: 'A little more to the left',
    hintTurnRight: 'A little more to the right',
    hintLookUp: 'A little higher',
    hintLookDown: 'A little lower',
    hintHeadLevel: 'Level your head a bit',
    hintStraighten: 'Straighten your head a bit',
    hintFaceFront: 'Face the camera directly',
    hintBlurry: 'Image is blurry, please hold still',
    hintTooDark: 'Too dark, please add light',
    hintTooBright: 'Too bright, please avoid strong light',
    hintHoldStill: 'Hold still, capturing…',
    hintFinalizing: 'Processing, please wait…',
    hintUploading: 'Uploading…',
    hintUploadFailed: 'Upload failed. Please check your network and tap "Retry upload" below',
    hintCameraOn: '{pose}',

    cameraDenied: 'Camera permission denied. Please allow camera access and refresh the page',
    cameraNotFound: 'No available camera detected',
    cameraBusy: 'Camera is in use by another program. Please close it and refresh the page',
    cameraFailed: 'Failed to start camera ({err})',
    cameraLost: 'Camera disconnected. Please check the device and refresh the page',
    segmentFailed: 'Video recording could not start; this step will have no video',

    retry: 'Retry',
    retryUpload: 'Retry upload',
    uploadFailed: 'Upload failed',
    failed: 'Failed: {msg} (will retry automatically while holding pose)',
    failedMax: 'Repeated failures. Please check the network and tap "Retry"',
    uploading: 'Uploading…',
    camera: 'Camera {n}',

    doneTitle: 'Recognition complete',
    again: 'Recognize again',
    linkMissing: 'Missing capture ID in the link',
    linkTooLong: 'Capture ID is too long (200 characters max)',

    metricFaceWidth: 'Face width',
    metricSharpness: 'Sharpness',
    metricLight: 'Light',
    metricCamera: 'Camera',
    metricYaw: 'Yaw',
    metricPitch: 'Pitch',
    metricBlink: 'Blink',
    debugLevel: 'level',
    debugUp: 'up',
    debugDown: 'down',
    debugUploading: 'uploading…',
    debugUploadFailed: 'upload failed: ',
    debugPending: 'pending',
    debugFilesUnit: 'files',
    metricRoll: 'Roll',
    emptyRecording: 'Empty recording',
    captureFailed: 'Capture error, please hold your pose',
  },
} as const

export type MessageKey = keyof typeof M.zh

// 浏览器语言以 zh 开头用中文，其余一律英文
export const lang: 'zh' | 'en' = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = M[lang][key] ?? M.zh[key]
  // replaceAll 而非 replace：后者只替换第一次出现，
  // 一旦文案里同一占位符出现两次（如「请{pose}，保持{pose}」），第二个会原样展示给用户。
  if (params) {
    // 第二参数用函数而非字符串：字符串形式下 $ 有特殊含义（如 $& 表示「匹配到的内容」），
    // 参数值含这些序列会被当成替换模式解释。当前各调用点的值都是固定枚举，
    // 但函数式写法从结构上消除这类问题。
    for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', () => String(v))
  }
  return s
}
