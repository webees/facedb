# 人脸采集页 UI 开源实现调研：椭圆遮罩 + 动画引导 + 音效提示

> 目标场景：Vue 3 + MediaPipe FaceLandmarker（浏览器端），6 个姿态（正脸 / 左右 30° / 左右 45° / 6 秒活体视频）。
> **本文是 2026-10-05 的调研快照，场景描述未随实现更新。** 后续变更：
> 左右 45° 两步已删除（MediaPipe 在 45° 处抖动大、且与质量门槛重合，用户几乎无法稳定命中）；
> 「6 秒活体视频」已取消（改为每个采集点各录一段，活体步达标即完成）。
> **R30 复检补充（2026-10-09）**：除上面两项外，本文至少还有 5 处结论已被实现推翻，逐条标注如下
> （复检证据见运行根 `evidence/W30-E-*.log` 与 `findings/W30-E.json`）：
> ① **椭圆半轴比 1.618 → 1.3**：本文 §「结论先行」推荐的 `OVAL_HEIGHT_WIDTH_RATIO = 1.618` 未采用，
>    实现用 1.3（`src/components/CaptureView.vue:124`、`:724-725`）；
> ② **静音开关已删除**：本文建议的「静音/取消静音」按钮不再存在（`src/lib/audio.ts:22-25`；`RUN.md:348`）；
> ③ **保持帧数 8 → 5**：`STABLE_FRAMES = 5`（`src/lib/quality.ts:52`，另见 `CaptureView.vue:159`/`:171`）；
> ④ **绘制层序与本文相反**：本文 §「绘制顺序」写先描边后挖洞，实现是先挖洞后描边（本文 `:644` vs `CaptureView.vue:722`/`:732`/`:737`）；
> ⑤ **未采用 DPR + resize 重建椭圆、洞缩放缓动**：全仓 `devicePixelRatio` 零命中（`RUN.md:340-342` 记录了不采用的理由）。
> **当前实现以 `RUN.md` 为准。**
>
> 调研时间：2026-10-05（星标 / 最近推送时间均为当日通过 GitHub REST API `api.github.com/repos/...` 抓取的快照，非猜测值）。
> 结论先行：**最值得抄的是 `aws-amplify/amplify-ui`（Apache-2.0）的 `react-liveness` 包**——它用 canvas 把「椭圆外变暗 + 椭圆挖洞 + 描边」做成了一套可复用的几何/状态逻辑（`drawLivenessOvalInCanvas`、`getFaceMatchStateInLivenessOval`、`OVAL_HEIGHT_WIDTH_RATIO = 1.618`），并且是唯一一个把「人脸是否落在椭圆内」的判定阈值写成可调配置的成熟实现。
> 音效：**没有找到任何许可证明确、且自带提示音的开源 Web 人脸采集项目**（Android 侧 kby-ai 用震动反馈 `Vibrator` 代替）。音效部分本报告给出可直接落地的 Web Audio 合成方案（不依赖任何音频文件）。

---

## 1. GitHub 项目清单（按对本项目的推荐度排序）

| # | 项目 | ⭐ | 最近推送 | 许可证 | 技术栈 | 椭圆遮罩 | 动画引导 | 音效 |
|---|------|----|---------|--------|--------|---------|---------|------|
| 1 | `aws-amplify/amplify-ui` | 1142 | 2026-10-02 | Apache-2.0 | React + TFJS（`@tensorflow-models/face-detection` BlazeFace/WASM） | ✅ canvas 椭圆挖洞 + 描边 | ✅ 命中度进度条 + 文案/遮罩状态动画 | ❌ |
| 2 | `rwmsousa/face-validator-sdk` | 1 | 2026-02-23 | ⚠️ 无 LICENSE 文件 | TS + **MediaPipe** tasks-vision | ✅ canvas `destination-out` 椭圆 | ⚠️ 状态文案/颜色变化 | ❌ |
| 3 | `hgb2016/liveness-h5-sdk` | 2 | 2026-06-12 | ⚠️ 无 LICENSE 文件 | TS + MediaPipe Face Mesh | ⚠️ 圆形取景（`border-radius:50%`）非椭圆 | ✅ SVG 进度环 + 步骤点 + 完成动画 | ❌ |
| 4 | `google-ai-edge/mediapipe` | 37163 | 2026-10-04 | Apache-2.0 | TS/JS（tasks-vision） | ➖ 不提供 UI | ➖ 提供绘制工具 | ❌ |
| 5 | `vladmandic/human` | 3328 | 2025-12-13 | MIT | TS + TFJS（含自有 liveness/antispoof 模型） | ❌ 只有框与关键点 | ⚠️ 条件清单式引导（勾/叉） | ❌ |
| 6 | `kby-ai/FaceCapture-Web` | 21 | 2026-06-15 | ⚠️ 无 LICENSE 文件 | 原生 JS + 私有 WASM（`liveface.wasm`） | ✅ **静态 PNG 遮罩** `face_cover.png` | ❌ 仅文字提示 | ❌ |
| 7 | `kby-ai/FaceActiveLivenessDetection-Android` | 3 | 2026-06-15 | ⚠️ 无 LICENSE 文件 | Android Java/Kotlin | ✅ `FaceRectView.java` 圆角矩形挖洞（可椭圆化） | ✅ **随人脸远近动态缩放取景洞** | ⚠️ 用震动 `Vibrator` 而非音效 |
| 8 | `TsMask/face-api-demo-vue` | 278 | 2024-04-08 | MIT | Vue 2 + face-api.js | ❌ | ❌ | ❌ |
| 9 | `justadudewhohacks/face-api.js` | 17975 | 2024-01-24 | MIT | TS + TFJS（库本身已停更） | ❌（demo 只有框/关键点） | ❌ | ❌ |
| 10 | `Faceplugin-ltd/FaceRecognition-LivenessDetection-Javascript` | 116 | 2026-09-21 | MIT | JS + ONNX Runtime Web + OpenCV.js | ➖ 无 UI | ➖ | ❌ |
| 11 | `FaceOnLive/ID-Verification-OpenKYC` | 464 | 2025-03-13 | ⚠️ 无 LICENSE 文件 | Flutter Web（仅编译产物 `main.dart.js`） | ⚠️ 有完整 KYC UI，但源码不可读 | ⚠️ | ❌ |
| 12 | `Faceplugin-ltd/FaceRecognition-Vue` | 4 | 2026-09-21 | ⚠️ 无 LICENSE 文件 | Vue 2 + 商业 npm 包 `kby-face` | ❌（canvas 画框+68 点） | ❌ | ❌ |

### 1.1 `aws-amplify/amplify-ui`（首选参考）

- 全名 / 数据：`aws-amplify/amplify-ui`，⭐1142，最近推送 2026-10-02，**Apache-2.0**，TypeScript/React。
- 技术栈：`@tensorflow-models/face-detection`（BlazeFace，WASM 后端）+ 自研 `FaceDetection` 抽象类，**不用 MediaPipe**，但几何与状态机与检测器无关，可直接移植。
- UI 形态：`<video>` 上叠一块**同尺寸 canvas**；每帧先在 canvas 上铺一层底色，再用 `ctx.ellipse` 画出椭圆路径 → `ctx.save(); ctx.clip(); ctx.restore()` + `clearRect` 把椭圆内部「擦空」，于是视频从洞里透出来，洞外是一层压暗的底色，椭圆边线用 `lineWidth = 3` 描边，颜色取自 CSS 变量（`--amplify-colors-border-secondary`）。**这正是「椭圆遮罩 + 遮罩外变暗 + 边缘描边」的教科书实现。** 另有 `MatchIndicator`（`role="progressbar"` + `--percentage` CSS 变量驱动的命中度进度条）和 `Hint`/`Overlay` 提示组件做动画反馈。
- **最值得抄的文件**：
  - `packages/react-liveness/src/components/FaceLivenessDetector/service/utils/liveness.ts`
    → `drawLivenessOvalInCanvas()`（canvas 铺底 + ellipse + clip + clearRect 挖洞 + 描边）、`drawStaticOval()`（**从 `MediaStream` track 的 `getSettings()` 拿真实分辨率**再决定椭圆尺寸）、`resizeCanvasToDisplaySize()`、`getVideoScaleFactor()` + `translate`（**解决 `object-fit: cover` 的 letterbox 偏移**，椭圆坐标永远按视频内在尺寸算，不按 CSS 像素）。
  - `.../service/utils/getFaceMatchStateInLivenessOval.ts`
    → 用 **IoU（交并比）+ 阈值**判定人脸是否落在椭圆内，输出 `MATCHED / OFF_CENTER / TOO_FAR / TOO_CLOSE` 状态——可直接映射到我们的「对准成功 / 请居中 / 请靠近 / 请后退」提示与音效触发。
  - `.../service/utils/constants.ts` → `OVAL_HEIGHT_WIDTH_RATIO = 1.618`（黄金比椭圆，比正圆更贴合人脸），`OvalIouThreshold` 等阈值都在会话配置里可调。
  - `.../LivenessCheck/LivenessCameraModule.tsx` → canvas / video / 取景层的组装方式、`videoAnchorRef` 容器尺寸变化（弹窗动画、旋转）时**重建椭圆**（带 100ms 防抖），避免每帧重算。
  - `.../shared/MatchIndicator.tsx` → 一个 20 行不到的命中度进度条，含 a11y 属性。
- 可抄性：✅ Apache-2.0，允许商用与修改（保留版权与 NOTICE）。**注意只抄 UI/几何/状态层**：它的会话建立依赖 AWS Rekognition 后端（`createStreamingClient`、WebSocket 凭证），那部分对我们无用；椭圆与命中判定是纯前端、自包含的。

### 1.2 `rwmsousa/face-validator-sdk`（与我们的技术栈最接近）

- 全名 / 数据：`rwmsousa/face-validator-sdk`，⭐1，最近推送 2026-02-23，**未声明许可证（GitHub API `license = null`）**，TypeScript。
- 技术栈：**MediaPipe**(tasks-vision) + 纯 canvas 叠加，同时提供框架无关的 `FaceValidator` 与 `ReactSelfieCapture.tsx`。
- UI 形态：canvas 覆盖层 `fv-sdk-canvas`（`position:absolute` + `transform: scaleX(-1)` 与镜像视频对齐）里画椭圆：**先全屏铺半透明白底，再用 `globalCompositeOperation = 'destination-out'` 把椭圆内部擦掉**（另一种挖洞写法，见 §2.1），再描边 + 画中心十字准星；debug 模式还会画 478 点关键点与自适应人脸框。
- **最值得抄的文件**：
  - `src/utils.ts` → `drawOverlay()`（`destination-out` 挖洞 + 椭圆描边 + 准星，代码量极小）、`isPointInsideOval()` / `isFaceBoundingBoxInsideOval()`（**鼻尖在椭圆内 + 人脸框整体在椭圆内**的双重判定，比单纯 IoU 更直观）、`checkFaceDistance()`、`isYawAcceptable()`、`isFaceStable()`、`calculateAverageBrightness()`、`hasDarkGlasses()`、`isNeutralExpression()`——后几个正好可用于我们 6 姿态的「是否转到位」判定与质量门限。
  - `src/FaceValidator.ts` → 视频/canvas 的创建与挂载、`fv-sdk-video, fv-sdk-canvas { width:100%; height:100%; object-fit:cover }` 的样式约定、每帧流程编排。
  - `src/i18n.ts` → 提示文案的组织方式（多语言键值）。
- 可抄性：⚠️ **没有 LICENSE 文件，不能直接复制代码**（默认保留全部权利）。建议只按思路自己重写——好在关键逻辑（椭圆内外判定、`destination-out` 挖洞）本身只有几十行。

### 1.3 `hgb2016/liveness-h5-sdk`（动画引导的最佳样本，中文）

- 全名 / 数据：`hgb2016/liveness-h5-sdk`，⭐2，最近推送 2026-06-12，**无 LICENSE**，TypeScript + MediaPipe Face Mesh（468 点）。
- UI 形态：`#camera-wrapper`（316×316）内是 `#camera-area`（300×300，`border-radius:50%`，`overflow:hidden` 装 video），外面套一个 **SVG 进度环** `<svg id="progress-ring" viewBox="0 0 316 316">` + 两个 `<circle r="152">`；下方 `#dots` 是步骤点（`.dot.active / .dot.done` 带 glow）；顶部 `#liveness-tip` 是半透明黑胶囊提示条（「请眨眨眼 👀」「请左右摇头 🙅」）。
- **最值得抄的文件**：
  - `examples/index.html` → **完整的「摄像头圆洞 + SVG 进度环 + 步骤点 + 提示胶囊」单文件实现**：`const CIRCUMFERENCE = 2 * Math.PI * 152`、`ringFg.setAttribute('stroke-dasharray', CIRCUMFERENCE)`、`updateRing(progress)` 里 `stroke-dashoffset = CIRCUMFERENCE * (1 - progress)`；`completeRingAnimation(cb)` 用 `requestAnimationFrame` + 三次缓动 `1 - Math.pow(1 - progress, 3)` 在切步骤时把环快速跑满一圈——**这套「保持 8 帧 → 环涨满 → 播放完成动画 → 切下一步」的节奏直接可用**。
  - `src/liveness-detector.ts` → `updateTip()` / `updateActionTip()` 的提示条组件化（动态创建 DOM + 定位），以及眨眼/张嘴/摇头/点头的动作判定与文案表。
- 可抄性：⚠️ 无 LICENSE，**不可直接复制**；但它的「进度环 + 步骤点」范式完全可以自己用 Vue 3 + SVG 复刻（§2.2 给出了 Vue 版代码）。

### 1.4 `google-ai-edge/mediapipe`（我们已在用的栈，官方绘制工具）

- 数据：⭐37163，最近推送 2026-10-04，Apache-2.0。
- 对我们最直接的价值不是 UI，而是 **`@mediapipe/tasks-vision` 自带的 `DrawingUtils`**：
  - 源码路径（已核对存在）：`mediapipe/tasks/web/vision/core/drawing_utils.ts`（含 `drawConnectors` / `drawLandmarks` / `drawBoundingBox`），配套 `face_landmarks_connections.ts` 提供 `FaceLandmarker.FACE_LANDMARKS_TESSELATION` 等连接表。
  - 官方 Web 指南：<https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js>（已核实可达）。
- 用法要点：关键点必须画在**独立的 canvas 层**上，不要和椭圆遮罩层抢同一块 canvas（否则每帧互相 `clearRect`）；全部坐标是 `[0,1]` 归一化值，乘 `videoWidth/videoHeight` 后再乘 DPR。
- 可抄性：✅ Apache-2.0。它不含取景遮罩 UI，所以「椭圆」那部分仍要参考 #1/#2。

### 1.5 `vladmandic/human`

- 数据：⭐3328，最近推送 2025-12-13，**MIT**，TS + TFJS。
- UI 形态：`<video>` + `<canvas>`，用 `human.draw.all(canvas, result)` 画框/关键点（`s.draw.canvas(video, canvas)` 负责底图），**没有椭圆遮罩**；引导是「条件清单」式：右侧一列 `ok-*` 小方块，逐项校验 `faceCount / faceSize / blinkDetected / facingCenter / lookingCenter / antispoofCheck / livenessCheck / distance / descriptor` 等，未达成显示红色、达成显示绿色，全部达成才进入人脸匹配。
- **最值得抄的文件**：
  - `src/face/liveness.ts` + `models/liveness.bin` → 人脸活性（anti-spoof）判定，与我们 6 秒活体视频环节的「真伪」判定同源。
  - `demo/faceid/index.js` → **「逐项条件达成才放行」的活体采集流程**（含 `blinkMin/blinkMax` 眨眼时长窗口、`distanceMin/distanceMax` 距离窗口、`maxTime` 超时），以及 `getUserMedia({ audio:false, video:{ facingMode:'user' } })` → `canvas.width = video.videoWidth` 的标准初始化。这套「条件对象 + 全部满足才推进」的结构非常适合我们的 6 姿态状态机。
- 可抄性：✅ MIT，可抄（保留版权声明）。

### 1.6 `kby-ai/FaceCapture-Web`

- 数据：⭐21，最近推送 2026-06-15，**无 LICENSE**，原生 JS（核心是 7MB 的私有 WASM `liveface.wasm`）。
- UI 形态：`#div_video` 用 CSS Grid 把 `<video>`、`#capture`(z-index 2)、`#capture1`(z-index 0)、`#best_capture`(z-index 3)、**`<img src="face_cover.png" id="face_cover">`（z-index 3）** 叠在同一格里；`face_cover.png` 就是**事先做好的椭圆人脸取景遮罩图**（静态 PNG 方案），默认 `visibility:hidden`，需要时显示。方向/距离/遮挡等反馈全部是 `#res_yaw`、`#res_pitch`、`#res_eyeDist` 之类的**文字标签**，没有动画与音效。
- **最值得抄的文件**：`index.html`（grid 叠层结构 + 镜像 `transform: scaleX(-1)` 同时施加在 video 与各 canvas 上）、`style.css`（z-index 分层规范）、`main.js`（"Multiple Person Detected" / "Mask Detected" 等门限文案与自动拍摄触发逻辑）。
- 可抄性：⚠️ 无许可证 + 私有 WASM，**不可抄代码**；「静态 PNG 遮罩」这一手法值得知道：**最省事的做法，但无法做动态变形/发光**，只适合固定取景框。

### 1.7 `kby-ai/FaceActiveLivenessDetection-Android`（动态取景洞的最佳设计参考）

- 数据：⭐3（同厂 `kby-ai/FaceLivenessDetection-Android` ⭐275 为姊妹项目），最近推送 2026-06-15，**无 LICENSE**，Java/Kotlin。
- 虽非 Web，但它的取景框实现思路**在 Web 上一样成立**：`FaceRectView.java` 里维护 `scrimPaint`（渐变压暗层）、`outSideScrimPaint`、`eraserPaint`（`PorterDuff.Mode.CLEAR`，等价于 canvas 的 `destination-out`），并用 `canvas.drawRoundRect(rect, rect.width()/2, rect.height()/2, ...)` **把圆角半径设成宽高的一半，从而画出一个椭圆形的取景洞**；更关键的是它有 `DispState.ROUND_NORMAL / ROUND_ZOOM_IN / ROUND_ZOOM_OUT` 三种模式，**取景洞的四边 margin 随人脸大小改变（`getWidth()/6` ↔ `getWidth()/4`）**——这就是「请靠近一点 / 请后退一点」的视觉引导，比文字提示直观得多。
- 反馈方式：`CameraActivity.kt` 在动作完成后调用 `Vibrator`（`VibrationEffect.createOneShot(500, ...)`）做触觉反馈，**全项目没有任何提示音**——说明连商业 SDK 在「采集提示」上普遍用震动/视觉而非声音。
- **最值得抄的文件**：`app/src/main/java/com/kbyai/faceattribute/FaceRectView.java`（挖洞 + 渐变压暗 + 洞随距离缩放）、`CameraActivity.kt`（动作序列推进与反馈时机）。
- 可抄性：⚠️ 无许可证，**只借设计，不抄代码**。

### 1.8 `TsMask/face-api-demo-vue`（Vue 项目的 canvas 叠加骨架）

- 数据：⭐278，最近推送 2024-04-08，**MIT**，Vue 2 + face-api.js。
- UI 形态：`<video>` + `<canvas>` 一一对应，`faceapi.matchDimensions(canvasEl, videoEl, true)` 负责尺寸同步，然后 `draw.drawDetections / drawFaceLandmarks / drawFaceExpressions` 逐层画；**没有椭圆遮罩、没有引导动画、没有音效**。
- **最值得抄的文件**：`src/views/VideoFaceDetector.vue`、`src/views/WebRTCFaceDetector.vue` → **「video + canvas 双元素 + 每帧 rAF 重绘 + 可配置 draws 数组」**的 Vue 组件结构（`draws: ["box","landmark","expression","ageGender"]`），迁移到 Vue 3 的 `<script setup>` 几乎是逐行改写。
- 可抄性：✅ MIT，可抄结构（但注意它是 Vue 2 Options API）。

### 1.9 `justadudewhohacks/face-api.js`（生态基准，但已停更）

- 数据：⭐17975，最近推送 2024-01-24，**MIT**，TS + TFJS。**已停止维护**（官方推荐迁移到 face-api.js 的分支如 `vladmandic/face-api` ⭐1082 / MIT，或直接用 MediaPipe）。
- 浏览器示例：`examples/examples-browser/views/faceDetection.html` → `faceapi.detectAllFaces(video).withFaceLandmarks()` 后逐层绘制到 canvas 的经典循环。
- **最值得抄的点**：`matchDimensions()` 的思路（canvas 尺寸、显示尺寸、镜像三者一次算清），以及 `WithFaceLandmarks` 链式 API 的分层绘制顺序。椭圆遮罩它没有，需要我们自己加。
- 可抄性：✅ MIT。但**不建议引入**（停更、模型体积大），只当参考资料。

### 1.10 `Faceplugin-ltd/FaceRecognition-LivenessDetection-Javascript`

- 数据：⭐116，最近推送 2026-09-21，**MIT**，JavaScript + ONNX Runtime Web + OpenCV.js。
- UI 形态：**没有 UI**，纯算法库（`lib/fr_detect.js`、`lib/fr_landmark.js`、`lib/fr_liveness.js`、`lib/fr_pose.js`、`lib/fr_eye.js`、`lib/fr_expression.js`、`lib/fr_age.js`）。
- **最值得抄的文件**：`lib/fr_pose.js`（Yaw/Pitch/Roll 的浏览器端回归推理）、`lib/fr_liveness.js`（静默活体打分）——如果我们的 6 姿态判定想摆脱「只靠 landmark 几何阈值」，这里有 MIT 许可的浏览器端 ONNX 方案可对照。
- 可抄性：✅ MIT（算法层）。UI 需自建。

### 1.11 `FaceOnLive/ID-Verification-OpenKYC`

- 数据：⭐464，最近推送 2025-03-13，**无 LICENSE**，Flutter Web。
- 形态：**仓库里只有编译产物**（`app/main.dart.js` 3MB、`admin/main.dart.js` 2.9MB）+ Firebase 云函数 JS；能看 UI 效果，**拿不到可读的 Dart 源码**，因此对我们只能当交互参考。
- 可抄性：❌ 无源码、无许可证。

### 1.12 `Faceplugin-ltd/FaceRecognition-Vue`

- 数据：⭐4，最近推送 2026-09-21，**无 LICENSE**，Vue 2。
- 形态：`src/views/demo.vue` 用 `import * as faceSDK from "kby-face"`（商业 SDK）驱动 `<canvas id="live-canvas">`，逐层画人脸框（`strokeStyle="red"`、`strokeRect`）与 68 点（`arc(...)` + `stroke`）。
- **价值**：看 Vue 里 video/canvas/`detectFace(this.detectSession, 'live-canvas')` 的编排；**没有椭圆、没有音效**。
- 可抄性：❌ 无许可证 + 依赖商业包。

### 附录：次级参考

- `xiaoshuaishuai319/H5FaceVerify`（⭐9，2018-06-27，无 LICENSE，Vue 2）：`feSource/src/pc/views/record.vue` 有「进度条 + 提示 + 录制」的 H5 人脸核身 UI，但检测在百度云服务端，前端只有录制与进度条，**无椭圆遮罩**，年代久远，参考价值有限。
- `exadel-inc/CompreFace`（⭐8334，2024-10-05，Apache-2.0）：完整人脸识别系统，React 前端有框选与标注，但**没有面向用户的采集引导**，与本需求不符。
- `jeeliz/jeelizFaceFilter`（⭐2939，2025-11-14，Apache-2.0）：WebGL 人脸 AR 叠加库，其「canvas 叠加层与视频严格对齐」的工程处理可参考；**未见椭圆取景遮罩（未验证其具体文件）**。

---

## 2. 具体实现方案（Vue 3 可直接落地）

### 2.0 分层结构（三层，别混在一起）

```
<div class="capture">                     ← 定位容器，overflow:hidden
  <video class="capture__video">          ← z0：摄像头画面（镜像、object-fit:cover）
  <div   class="capture__mask">           ← z1：椭圆遮罩（CSS 或 SVG 或 canvas）
  <canvas class="capture__landmarks">     ← z2：MediaPipe 关键点（可选，调试用）
  <svg   class="capture__ring">           ← z3：进度环 / 方向箭头 / 步骤点
  <div   class="capture__tip">            ← z4：文案提示
</div>
```

**关键原则**：遮罩、进度环、关键点是**三个独立层**，各自更新频率不同（遮罩随人脸距离变化才更新、进度环每帧但用 CSS/SVG、关键点每帧画在独立 canvas）。混在一个 canvas 上互相 `clearRect` 是这类页面最常见的性能与闪烁来源。

### 2.1 椭圆遮罩：三种做法与性能对比

#### 做法 A（推荐）：CSS 椭圆 + `box-shadow` 反向遮罩

不需要 canvas、不需要每帧 JS，浏览器把阴影和圆角都交给合成层。

```vue
<template>
  <div class="capture" :class="`capture--${fit}`">
    <video ref="videoEl" class="capture__video" autoplay muted playsinline webkit-playsinline />
    <!-- 遮罩元素本身不可见，靠 box-shadow 的“外圈阴影”压暗椭圆之外 -->
    <div class="capture__hole" :style="{ '--rx': rxPct + '%', '--ry': ryPct + '%' }" />
    <div class="capture__tip">{{ tipText }}</div>
  </div>
</template>

<style scoped>
.capture {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;          /* 裁掉 box-shadow 溢出部分 */
  background: #000;
  border-radius: 16px;
}
.capture__video {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;          /* 注意：cover 会裁切，坐标换算见 §2.5 */
  transform: scaleX(-1);      /* 自拍镜像 */
}
.capture__hole {
  position: absolute;
  left: 50%; top: 50%;
  width: calc(var(--rx) * 2);   /* rx/ry 是“半轴占容器宽/高的百分比” */
  height: calc(var(--ry) * 2);
  transform: translate(-50%, -50%) scale(var(--zoom, 1));
  border-radius: 50%;
  pointer-events: none;
  /* 1) 洞外压暗（只用 spread，无 blur，开销极低） 2) 白色描边 3) 少量发光 */
  box-shadow:
    0 0 0 100vmax rgba(0, 0, 0, 0.55),
    0 0 0 2px rgba(255, 255, 255, 0.92),
    0 0 18px 3px rgba(56, 189, 248, 0.45);
  transition: width .25s ease, height .25s ease, box-shadow .2s ease, transform .25s ease;
}
.capture--ok .capture__hole {           /* 对准成功：变绿 + 加粗描边 */
  box-shadow:
    0 0 0 100vmax rgba(0, 0, 0, 0.42),
    0 0 0 3px #22c55e,
    0 0 24px 6px rgba(34, 197, 94, 0.55);
}
.capture--far .capture__hole { --zoom: .82; }   /* 距离引导：洞变小 = 请你靠近 */
.capture--near .capture__hole { --zoom: 1.12; } /* 请你后退 */
@media (prefers-reduced-motion: reduce) {
  .capture__hole { transition: none; }
}
</style>
```

**为什么把它排第一**：`box-shadow` 的 spread 阴影是**绘制一次后缓存的图层**，椭圆尺寸不变时不产生每帧重绘；`border-radius: 50%` + `transform` 走 GPU 合成。这正是「遮罩外变暗 + 边缘发光」最省的一条路（**未在真机实测**，属基于渲染机制的性能推断：spread 无 blur、尺寸稳定时可被合成层缓存；发光层 blur 半径小，代价可控）。落地时请在目标机型（尤其低端 Android WebView）用 DevTools 的 paint flashing 与本机帧率复核一次。
**注意**：`box-shadow` 的 `100vmax` 只是「足够大」，容器必须 `overflow:hidden`，否则会盖住页面其他内容。

#### 做法 B：`clip-path: ellipse()`（裁剪视频本身）

```css
.capture__video {
  /* 百分比参照元素自身 border-box：rx 相对宽度，ry 相对高度 */
  clip-path: ellipse(32% 38% at 50% 50%);
  -webkit-clip-path: ellipse(32% 38% at 50% 50%);
  transition: clip-path .25s ease;
}
```

- 优点：一行搞定裁剪，纯合成属性，动画 `clip-path` 也走 GPU。
- **致命缺点**：`clip-path` **只裁剪、不压暗**。想要「遮罩外变暗 + 发光描边」，仍必须再叠一层带 `box-shadow` 或 SVG 的遮罩元素——等于事情做了一半还多一个元素。
- 兼容性：Safari 需要 `-webkit-` 前缀（旧版本），iOS 上对 `<video>` 直接 `clip-path` 的历史 bug 较多（当前版本表现**未验证**），**不建议直接裁 video**。
- 结论：**不单独使用**，可作为做法 A 中「视频被裁成更小一圈」的补充。

#### 做法 C：canvas 挖洞（两种写法，控制力最强）

```ts
// 写法 C1：destination-out（rwmsousa/face-validator-sdk 的做法）
function paintMaskC1(ctx: CanvasRenderingContext2D, w: number, h: number, rx: number, ry: number) {
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, w, h);                    // 1) 整屏压暗
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();                                   // 2) 把椭圆区域“擦”成透明
  ctx.restore();                                // 复原合成模式（务必 save/restore）
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.lineWidth = 3;
  ctx.stroke();                                 // 3) 描边
}

// 写法 C2：clip + clearRect（aws-amplify/amplify-ui 的做法，等价但少一次合成模式切换）
function paintMaskC2(ctx: CanvasRenderingContext2D, w: number, h: number, rx: number, ry: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(0, 0, w, h);                     // 1) 压暗
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.stroke();                                 // 2) 先描边（描边要在 clip 之前，否则会被剪掉一半）
  ctx.save();
  ctx.clip();                                   // 3) 进入椭圆裁剪区
  ctx.setTransform(1, 0, 0, 1, 0, 0);           //    恢复设备坐标，避免被业务 transform 影响
  ctx.clearRect(0, 0, w, h);                    // 4) 把椭圆内部擦空 → 视频透出来
  ctx.restore();
}
```

**canvas 方案的性能要点**：如果椭圆尺寸长期不变，把遮罩**画到一张 `OffscreenCanvas`/隐藏 canvas 上缓存**，每帧只 `drawImage` 贴一次；只有在 `rx/ry` 变化（距离引导动画）时才重绘。否则每帧一次全屏 `fillRect + clearRect`，在 1080p 下大约 0.5–2ms，中低端机叠加 MediaPipe 推理后会明显掉帧。

#### 性能对比结论

| 方案 | 遮罩外变暗 | 边缘发光 | 每帧 CPU（1080p 估算） | 动画椭圆尺寸 | 兼容/降级 | 结论 |
|---|---|---|---|---|---|---|
| A. CSS `border-radius` + `box-shadow` | ✅ 一行 | ✅ 多层阴影 | ~0（合成层） | ✅ CSS transition | 全支持；不支持 `box-shadow` 多值时退化为 `outline` | **首选** |
| B. `clip-path: ellipse()` | ❌ 需另加遮罩层 | ❌ 需另加元素 | ~0 | ✅ | 旧 Safari 需 `-webkit-`；对 `<video>` 有历史坑 | 只作补充 |
| C. canvas 挖洞 | ✅ | ✅ shadowBlur 或双描边 | 0.5–2ms/帧（可缓存到 ~0） | ✅ rAF 逐帧 | 全支持，自己控 DPR/坐标 | **需要和关键点同层绘制时选它** |

**给本项目的建议组合**：遮罩用 **A（CSS）**；MediaPipe 关键点画在独立 canvas 上并**只在 debug 模式显示**；进度环用 SVG；只有在你希望「遮罩与关键点严格同坐标系、且要做每帧形变」时，才整体切到 **C**。

### 2.2 动画引导

#### （1）圆形进度环：表示「保持 8 帧」的进度（SVG `stroke-dasharray`）

```vue
<template>
  <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
    <circle class="ring__bg" cx="50" cy="50" r="46" />
    <circle
      class="ring__fg"
      cx="50" cy="50" r="46"
      :style="{ strokeDasharray: C, strokeDashoffset: offset, stroke: ringColor }"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ progress: number }>(); // 0 ~ 1
const C = 2 * Math.PI * 46;                        // ≈ 289.03，写死避免每帧计算
const RING = 2 * Math.PI * 46;
const offset = computed(() => RING * (1 - Math.min(1, Math.max(0, props.progress))));
const ringColor = computed(() => (props.progress >= 1 ? '#22c55e' : '#38bdf8'));
</script>

<style scoped>
.ring {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  transform: rotate(-90deg);      /* 让进度从 12 点方向开始 */
  pointer-events: none;
}
.ring circle { fill: none; stroke-width: 3; stroke-linecap: round; }
.ring__bg { stroke: rgba(255, 255, 255, 0.22); }
.ring__fg { transition: stroke-dashoffset .12s linear; filter: drop-shadow(0 0 4px rgba(56, 189, 248, .6)); }
</style>
```

保持帧数的判定用一个 composable（**必须带滞后，否则会反复触发音效**）：

```ts
// composables/useHoldProgress.ts
import { ref, computed } from 'vue';

export function useHoldProgress(required = 8, releaseFrames = 3) {
  const held = ref(0);
  const armed = ref(false);          // 已经“完成”过，等待条件释放
  const progress = computed(() => Math.min(1, held.value / required));

  /** 每个检测帧调用一次；返回 true 表示“刚刚达成”（只在边沿返回一次） */
  function tick(ok: boolean): boolean {
    if (ok) {
      if (armed.value) return false;
      held.value += 1;
      if (held.value >= required) {
        armed.value = true;          // 上锁：避免连续多帧重复返回 true（重复播音效）
        return true;
      }
    } else {
      held.value = Math.max(0, held.value - 1);
      // 连续失败若干帧后才解锁，防止 landmark 抖动导致进度来回跳
      if (armed.value && held.value <= required - releaseFrames) armed.value = false;
    }
    return false;
  }
  function reset() { held.value = 0; armed.value = false; }
  return { held, progress, tick, reset };
}
```

#### （2）左右转方向箭头（CSS keyframes）

```vue
<template>
  <div class="guide" :class="`guide--${dir}`" v-if="dir !== 'none'">
    <svg class="guide__arrow" viewBox="0 0 24 24" width="56" height="56">
      <path d="M4 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor"
            stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="guide__label">{{ dir === 'left' ? '请向左转 30°' : '请向右转 30°' }}</span>
  </div>
</template>

<style scoped>
.guide {
  position: absolute; left: 50%; bottom: 8%;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,.6);
  pointer-events: none;
}
/* 默认朝右滑 */
.guide__arrow { animation: slide-x 1.15s ease-in-out infinite; }
@keyframes slide-x {
  0%, 100% { transform: translateX(-8px); opacity: .3; }
  50%      { transform: translateX(10px); opacity: 1; }
}
/* 朝左：水平镜像动画方向 */
.guide--left .guide__arrow { transform: scaleX(-1); animation-name: slide-x-left; }
@keyframes slide-x-left {
  0%, 100% { transform: scaleX(-1) translateX(-8px); opacity: .3; }
  50%      { transform: scaleX(-1) translateX(10px); opacity: 1; }
}
/* 45° 阶段：加快 + 换色，制造“难度升级”的感知 */
.guide--left.guide--stage2 .guide__arrow,
.guide--right.guide--stage2 .guide__arrow { color: #f59e0b; animation-duration: .8s; }
@media (prefers-reduced-motion: reduce) { .guide__arrow { animation: none; opacity: 1; } }
</style>
```

**方向与镜像的坑（务必处理）**：自拍预览是镜像的（`scaleX(-1)`）。AWS 的做法是给椭圆和维护的坐标额外记一个 `flippedCenterX = videoWidth - centerX`（见 `liveness.ts` 中 `getOvalDetailsFromSessionInformation`），**任何基于 MediaPipe landmark 的左右判断，如果输入帧被镜像过，yaw 的符号必须取反**，否则「左转」提示会反。建议：**用未镜像的帧做检测**（MediaPipe 输入原始帧），**只对显示层做镜像**——这样 yaw 符号不需要额外翻转。方向箭头的朝向要按「用户自己的左右」措辞（镜像下用户感觉自然）。

#### （3）步骤点 + 动态取景洞（距离引导）

```vue
<div class="dots">
  <i v-for="(s, i) in steps" :key="i"
     class="dot" :class="{ 'dot--active': i === current, 'dot--done': i < current }" />
</div>
```

```css
.dots { display: flex; gap: 12px; justify-content: center; margin-top: 16px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,255,255,.28); transition: all .3s; }
.dot--active { background: #fbbf24; box-shadow: 0 0 10px #fbbf24; }
.dot--done   { background: #22c55e; box-shadow: 0 0 10px #22c55e; }
```

距离引导（借鉴 kby `FaceRectView` 的 `ROUND_ZOOM_IN/OUT`）：根据人脸框宽度 / 椭圆宽度的比值调整 `--zoom`——
`ratio < 0.7` → `capture--far`（洞缩小、提示「请靠近」）；`ratio > 1.05` → `capture--near`（洞放大、提示「请后退」）；中间为正常。**洞的缩放动画比文字更快被理解。**

#### （4）6 姿态流的状态机骨架

```ts
type Pose = 'front' | 'left30' | 'right30' | 'left45' | 'right45' | 'video';
const ORDER: Pose[] = ['front', 'left30', 'right30', 'left45', 'right45', 'video'];
// 每个姿态：判定函数 + 保持帧数 + 提示文案 + 建议音效
const SPEC: Record<Pose, { hold: number; tip: string; cue: 'ok' | 'next' | 'done' }> = {
  front:   { hold: 8, tip: '请正对镜头，保持不动', cue: 'ok' },
  left30:  { hold: 8, tip: '请向左缓慢转头约 30°', cue: 'ok' },
  right30: { hold: 8, tip: '请向右缓慢转头约 30°', cue: 'ok' },
  left45:  { hold: 8, tip: '继续向左转头约 45°', cue: 'ok' },
  right45: { hold: 8, tip: '继续向右转头约 45°', cue: 'ok' },
  video:   { hold: 0, tip: '请眨眨眼并保持 6 秒', cue: 'done' },
};
```

Yaw 取值：MediaPipe FaceLandmarker 的 `facialTransformationMatrixes`（4×4，可反解 yaw/pitch/roll）或直接用 landmark 几何（`rwmsousa` 的 `isYawAcceptable()` 用的是 234/454 耳点与鼻子 1 号点的横向偏移比，简单够用）。

### 2.3 音效：Web Audio API 合成（不依赖任何音频文件）

```ts
// composables/useCueSound.ts
let ctx: AudioContext | null = null;
let muted = false;
const listeners = new Set<(m: boolean) => void>();

/** 必须在“用户手势”里调用一次（点击「开始采集」按钮时） */
export function unlockAudio(): void {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    // iOS 技巧：手势内播一个 1 帧的静音 buffer，真正“解锁”音频通道
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function setMuted(m: boolean): void { muted = m; listeners.forEach((f) => f(m)); }
export function isMuted(): boolean { return muted; }

/** 单个音符：带 ADSR 式的短包络，避免爆音（gain 不能以 0 起步/收尾） */
function tone(
  freq: number,
  { at = 0, dur = 0.09, type = 'sine' as OscillatorType, peak = 0.12 } = {},
): void {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);                 // 不能设 0（exponentialRamp 不接受 0）
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);                            // 用完即弃，别复用
}

/** ① 对准成功：清亮、短促，单次「叮」 */
export function cueFit(): void {
  tone(880, { dur: 0.07, peak: 0.10 });
  tone(1320, { at: 0.055, dur: 0.10, peak: 0.06 });
}

/** ② 切换姿态：上滑双音，表示“下一项” */
export function cueNext(): void {
  tone(660, { dur: 0.07, type: 'triangle', peak: 0.10 });
  tone(990, { at: 0.08, dur: 0.10, type: 'triangle', peak: 0.10 });
}

/** ③ 全部完成：上行三音琶音（C6-E6-G6），带轻微尾音 */
export function cueDone(): void {
  const notes = [1046.5, 1318.5, 1568.0];
  notes.forEach((f, i) => tone(f, { at: i * 0.11, dur: 0.18, peak: 0.11 }));
  tone(2093, { at: 0.34, dur: 0.26, peak: 0.05 });      // 泛音尾巴，增加“完成感”
}

/** 可选：失败/离开取景框，低频短鸣（不要做得刺耳） */
export function cueWarn(): void {
  tone(320, { dur: 0.12, type: 'sawtooth', peak: 0.05 });
}

/** 节流：同一个音效 250ms 内只响一次，防止 landmark 抖动连播 */
const last = new Map<string, number>();
export function throttled(fn: () => void, key: string, ms = 250): void {
  const now = performance.now();
  if (now - (last.get(key) ?? 0) < ms) return;
  last.set(key, now);
  fn();
}
```

Vue 里接入：

```ts
// 在「开始采集」按钮的 click 处理函数内（必须是手势同步栈内第一件事）
function onStart() {
  unlockAudio();          // ① 手势内解锁
  cueNext();              // ② 直接给一次“开始”反馈
  startCamera();
}
// 状态机里
const { tick, progress } = useHoldProgress(8);
function onFrame(ok: boolean) {
  if (tick(ok)) {
    throttled(cueFit, 'fit');                 // 对准成功音
    setTimeout(() => { throttled(cueNext, 'next'); nextPose(); }, 400); // 切姿态音（与视觉动画错开 400ms）
  }
}
// 全部完成
function finish() { cueDone(); }
```

**静音开关**：把 `muted` 持久化到 `localStorage`，并在提示条旁放一个喇叭按钮（很多人是在地铁里做采集的）。同时提供 `prefers-reduced-motion`/静音的降级路径：视觉反馈始终独立于声音存在。

### 2.4 移动端适配注意点

1. **`playsinline` 必须写死**，否则 iOS Safari 会全屏播放，遮罩层全部失效：
   `<video autoplay muted playsinline webkit-playsinline />`，并在 JS 里 `video.setAttribute('playsinline', '')` 再赋 `srcObject`。
2. **自动播放**：iOS 只允许 `muted` + `playsinline` 的 `<video>` 自动播放；`video.play()` 仍建议在用户手势后调用一次，并 `catch()` 掉 rejection（有的机型会 reject）。
3. **`getUserMedia` 需要安全上下文**：`https://` 或 `localhost`；局域网 IP 直连调试会被拒。
4. **音频必须在用户手势后解锁**：`AudioContext` 初始状态是 `suspended`（Safari 尤其严格）。解锁时机＝「开始采集」按钮点击；并在 `document.visibilitychange` 回到前台时再次 `ctx.resume()`（系统来电/切 App 后会被挂起）。
5. **iOS 静音拨片与 Web Audio 的交互在不同系统版本上表现不一致（未验证）**：不要让「音效」成为流程的必需反馈，视觉提示必须独立成立。
6. **DPR 与 canvas 尺寸**：`canvas.width = Math.round(clientWidth * devicePixelRatio)`，然后 `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`；否则在 iPhone 上椭圆边缘和关键点会糊。
7. **`object-fit: cover` 的坐标换算**：视频会被裁掉两侧或上下，椭圆与关键点若按 CSS 像素摆放就会错位。照 AWS 的思路做：用 `video.videoWidth/videoHeight` 得到内在尺寸 → 算 `scaleFactor = max(elWidth / vw, elHeight / vh)` → 居中偏移 `translate = ((elW - vw*scale)/2, (elH - vh*scale)/2)` → 用 `ctx.setTransform(scale, 0, 0, scale, tx, ty)` 后再画椭圆。
8. **前置摄像头与镜像**：`facingMode: 'user'`；显示层统一 `transform: scaleX(-1)`（video 与所有 canvas 都要，别漏），检测输入用**未镜像**的帧。
9. **6 秒活体录制**：用 `MediaRecorder` 直接录**原始 `MediaStream`**（`new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })`），这样录到的只有摄像头画面，遮罩不会被烧进视频；若用 `canvas.captureStream()` 合成则会把 UI 一起录进去（而且 iOS Safari 对 `canvas.captureStream` 支持不全）。录制期间保持 video 元素常驻，不要因切换组件销毁重建。
10. **触摸与滚动**：遮罩层 `pointer-events: none`；采集页 `overscroll-behavior: none` + `touch-action: manipulation`，避免用户在取景框上滑动导致页面橡皮筋滚动。

### 2.5 与 MediaPipe FaceLandmarker 集成的骨架（Vue 3）

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { FaceLandmarker, FilesetResolver, DrawingUtils } from '@mediapipe/tasks-vision';
import { useHoldProgress } from '@/composables/useHoldProgress';
import { unlockAudio, cueFit, cueNext, cueDone, throttled } from '@/composables/useCueSound';

const videoEl = ref<HTMLVideoElement>();
const lmkCanvas = ref<HTMLCanvasElement>();   // 独立层，仅 debug 时显示
const fit = ref<'idle' | 'ok' | 'far' | 'near'>('idle');
const tipText = ref('请正对镜头');
const { progress, tick } = useHoldProgress(8);

let landmarker: FaceLandmarker | null = null;
let stream: MediaStream | null = null;
let raf = 0;
let lastVideoTime = -1;

async function startCamera() {
  unlockAudio();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const v = videoEl.value!;
  v.srcObject = stream;
  v.setAttribute('playsinline', '');
  v.muted = true;
  await v.play().catch(() => {});

  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
  );
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: '.../face_landmarker.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFacialTransformationMatrixes: true,   // 用矩阵反解 yaw/pitch/roll
  });
  loop();
}

function loop() {
  raf = requestAnimationFrame(loop);
  const v = videoEl.value;
  if (!v || !landmarker || v.readyState < 2) return;
  if (v.currentTime === lastVideoTime) return;      // 同一帧不重复推理
  lastVideoTime = v.currentTime;

  const res = landmarker.detectForVideo(v, performance.now());
  // ① 关键点画在独立 canvas（仅调试）
  if (lmkCanvas.value && res.faceLandmarks?.length) {
    const c = lmkCanvas.value;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(v.clientWidth * dpr)) {
      c.width = Math.round(v.clientWidth * dpr);
      c.height = Math.round(v.clientHeight * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const du = new DrawingUtils(ctx);
    du.drawLandmarks(res.faceLandmarks[0], { radius: 1 });
  }
  // ② 距离/居中判定 → 驱动 CSS 的椭圆缩放与提示（不碰遮罩层）
  const ok = judge(res);           // ← 你自己的 6 姿态判定（yaw/roll/居中/稳定性）
  fit.value = ok.state;
  tipText.value = ok.tip;
  if (tick(ok.hold)) { throttled(cueFit, 'fit'); advancePose(); }
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  landmarker?.close();
  stream?.getTracks().forEach((t) => t.stop());
});
</script>
```

---

## 3. 验收清单（必须逐条过）

### 遮罩与绘制

1. **`clip-path` 降级**：若用 `clip-path`，必须同时提供 `-webkit-clip-path` 与不支持时的替代（退回 `box-shadow` 遮罩或 canvas）；**不要在 iOS 上直接对 `<video>` 用 `clip-path`**（历史 bug 多，当前版本未验证）。
2. **`box-shadow` 遮罩的越界**：容器必须 `overflow: hidden`；`100vmax` 的阴影会覆盖整个视口，父级若没裁切会盖住页面其它 UI 与点击区（配合 `pointer-events: none`）。
3. **绘制顺序**：video → 遮罩 → 关键点 canvas → 进度环/UI，用 z-index 显式固定；**遮罩和关键点不要共用一块 canvas**（互相 `clearRect` 会闪烁）。
4. **描边别被自己裁掉**：先 `stroke()` 再 `clip()`（AWS 的顺序），否则椭圆边线只剩一半。
5. **`save()`/`restore()` 成对**：`globalCompositeOperation = 'destination-out'` 用完必须还原，否则后续所有绘制都在「擦除」模式。
6. **DPR 与尺寸同步**：`canvas.width/height` 按 `clientWidth * devicePixelRatio` 设置，并 `setTransform(dpr,0,0,dpr,0,0)`；容器 resize / 旋屏 / 弹窗动画时重建椭圆（AWS 用 100ms 防抖）。
7. **`object-fit: cover` 偏移**：椭圆与关键点必须按 `videoWidth/videoHeight` + `scaleFactor` + `translate` 换算，不能直接用 CSS 像素。
8. **镜像一致性**：`scaleX(-1)` 要同时作用于 video 与所有 canvas；检测输入用未镜像帧，否则左右提示反了。
9. **性能**：椭圆尺寸不变时不要每帧重绘遮罩（缓存到离屏 canvas 或改用纯 CSS 方案）；`blur` 半径别开大（发光阴影用**小 blur + 无 blur 的 spread 组合**）。
10. **`getImageData` 会拖慢**：做亮度/清晰度校验时给 context 加 `{ willReadFrequently: true }`，并且降频到每秒 2–5 次，不要每帧做。

### 动画与状态

11. **保持 8 帧的判定必须带滞后**：进入用 8 帧、退出用较低阈值（如 3 帧），否则 landmark 抖动会让进度条来回跳、音效连播。
12. **音效节流**：同一音效 200–250ms 内只播一次；「对准成功」与「切换姿态」两个音之间**故意留 300–400ms 间隔**，并让视觉动画（进度环跑满、打勾）先于/伴随音效发生，避免机械感。
13. **`prefers-reduced-motion`**：箭头/旋转动画要能关闭；进度环与步骤点仍然传达信息（不要只靠动画传达状态）。
14. **不要只靠颜色**：对准成功用「颜色 + 图标 + 文案」三重表达（色弱用户）。
15. **文案与音效同源**：提示文案、音效、进度环三者必须由**同一个状态**派生，避免出现「音效响了但文案还没变」。
16. **距离引导的洞缩放**要有上下限与缓动（`transition` 200–300ms），不要每帧直接赋值造成抖动。

### 音效与浏览器策略

17. **`AudioContext` 必须在用户手势内创建/`resume()`**：页面加载即 `new AudioContext()` 会一直是 `suspended`，表现为「本地开发有声音、iOS 上静默」。
18. **不要每帧 new `OscillatorNode`/`AudioContext`**；Oscillator 用完即弃是正确做法，但 `AudioContext` 全局只建一个。
19. **包络起止值不能用 0**：`exponentialRampToValueAtTime` 不接受 0，用 `0.0001`，否则抛异常或产生爆音（click）。
20. **切后台/来电后恢复**：监听 `visibilitychange` 重新 `ctx.resume()`；video 可能暂停，回到前台要重新 `play()`。
21. **提供静音开关并持久化**，尊重用户环境（通勤/办公场景）。
22. **iOS 静音拨片对 Web Audio 的影响因版本而异（未验证）**——必须真机验证；即使没声音，流程也要能走完。

### 与 MediaPipe / 录制的联动

23. **推理频率与渲染频率解耦**：用 `requestVideoFrameCallback`（可用时）或 `video.currentTime !== lastVideoTime` 去重，避免同一帧重复推理。
24. **6 秒视频录制录原始 `MediaStream`**（`MediaRecorder(stream)`），让遮罩只存在于 UI 层，绝不录进成品；录制前确认 `mimeType` 支持（Safari 优先 `video/mp4`）。
25. **求解 `FacialTransformationMatrixes` 的 yaw 时注意坐标系**：矩阵是相机坐标系的（含镜像约定），建议把 yaw 阈值先在真机上校准 30°/45° 两个档位，别用网上的通用阈值硬套。
26. **资源释放**：`landmarker.close()`、`stream.getTracks().forEach(t => t.stop())`、`cancelAnimationFrame`，否则在移动端会残留摄像头指示灯与耗电。

### 法务/许可

27. `rwmsousa/face-validator-sdk`、`hgb2016/liveness-h5-sdk`、`kby-ai/*`、`FaceOnLive/*`、`Faceplugin-ltd/FaceRecognition-Vue` **均无 LICENSE 文件**——**只能参考思路，不能复制代码**（默认保留全部权利）。
28. 可直接抄代码的是：`aws-amplify/amplify-ui`（Apache-2.0，保留版权/NOTICE）、`vladmandic/human`（MIT）、`TsMask/face-api-demo-vue`（MIT）、`google-ai-edge/mediapipe`（Apache-2.0）、`Faceplugin-ltd/FaceRecognition-LivenessDetection-Javascript`（MIT）、`justadudewhohacks/face-api.js`（MIT）。抄之前把来源写进代码注释与第三方许可清单。

---

## 4. 参考链接（已核实可达 / 数据来源）

- GitHub REST API（星标、`pushed_at`、`license` 快照来源）：`https://api.github.com/repos/{owner}/{repo}`（2026-10-05 查询）
- AWS Amplify UI Liveness（椭圆遮罩 + 命中判定）：
  - <https://github.com/aws-amplify/amplify-ui/blob/main/packages/react-liveness/src/components/FaceLivenessDetector/service/utils/liveness.ts>
  - <https://github.com/aws-amplify/amplify-ui/blob/main/packages/react-liveness/src/components/FaceLivenessDetector/service/utils/getFaceMatchStateInLivenessOval.ts>
  - <https://github.com/aws-amplify/amplify-ui/blob/main/packages/react-liveness/src/components/FaceLivenessDetector/LivenessCheck/LivenessCameraModule.tsx>
- MediaPipe FaceLandmarker Web 指南：<https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js>
- MediaPipe 绘制工具源码：<https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/web/vision/core/drawing_utils.ts>
- rwmsousa/face-validator-sdk：<https://github.com/rwmsousa/face-validator-sdk>（`src/utils.ts` 的 `drawOverlay`）
- hgb2016/liveness-h5-sdk：<https://github.com/hgb2016/liveness-h5-sdk>（`examples/index.html` 的 SVG 进度环）
- kby-ai/FaceCapture-Web：<https://github.com/kby-ai/FaceCapture-Web>（`face_cover.png` 静态遮罩）
- kby-ai/FaceActiveLivenessDetection-Android：<https://github.com/kby-ai/FaceActiveLivenessDetection-Android>（`FaceRectView.java` 动态取景洞）
- vladmandic/human：<https://github.com/vladmandic/human>（`demo/faceid/index.js`、`src/face/liveness.ts`）
- TsMask/face-api-demo-vue：<https://github.com/TsMask/face-api-demo-vue>（`src/views/VideoFaceDetector.vue`）
- justadudewhohacks/face-api.js 浏览器示例：<https://github.com/justadudewhohacks/face-api.js/blob/master/examples/examples-browser/views/faceDetection.html>
- Faceplugin JS SDK（MIT，算法层）：<https://github.com/Faceplugin-ltd/FaceRecognition-LivenessDetection-Javascript>
- FaceOnLive OpenKYC（仅编译产物）：<https://github.com/FaceOnLive/ID-Verification-OpenKYC>
