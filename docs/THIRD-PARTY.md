# 第三方来源与许可

本项目的采集页 UI 设计参考了若干开源实现。**以下仅借鉴设计思路与参数，未复制任何源代码**；
标注许可是为了满足上游项目的署名要求并方便后续合规审查。

## 已借鉴的设计点

| 设计点 | 来源项目 | 许可 | 借鉴内容 |
|---|---|---|---|
| 椭圆取景框（遮罩开孔） | [aws-amplify/amplify-ui](https://github.com/aws-amplify/amplify-ui) | Apache-2.0 | 参考 `react-liveness` 的 `OVAL_HEIGHT_WIDTH_RATIO`（黄金比）。**本项目后来改为 1.3**——黄金比过于高瘦，装不下整张脸，见 `RUN.md` |
| 遮罩分层与 `box-shadow` 反向压暗 | aws-amplify/amplify-ui、[rwmsousa/face-validator-sdk](https://github.com/rwmsousa/face-validator-sdk) | Apache-2.0 / **无 LICENSE** | 思路借鉴；本实现为自行编写的 Vue 版 |
| 距离引导（取景洞随人脸缩放） | [kby-ai/FaceActiveLivenessDetection-Android](https://github.com/kby-ai/FaceActiveLivenessDetection-Android) | **无 LICENSE** | 仅借鉴交互思路（`FaceRectView` 的 zoom in/out），未参考其代码 |
| 进度环与保持帧数的滞后判定 | [hgb2016/liveness-h5-sdk](https://github.com/hgb2016/liveness-h5-sdk) | **无 LICENSE** | 仅借鉴思路；本实现为自行编写的 `tickHold()` |
| 音效方案 | 上游普遍缺失 | — | 本项目自行设计（Web Audio 合成，无音频文件依赖） |

**无 LICENSE 的项目（rwmsousa、kby-ai、hgb2016、FaceOnLive、Faceplugin Vue 版）默认保留全部权利**，
本项目只借鉴其交互设计思路，不分发、不复制其代码。

## 运行时依赖

| 依赖 | 许可 | 用途 |
|---|---|---|
| [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) | Apache-2.0 | 人脸关键点检测（FaceLandmarker） |
| [pocketbase](https://github.com/pocketbase/pocketbase) | MIT | 后端与 JS SDK |
| [vue](https://github.com/vuejs/core) | MIT | 前端框架 |
| [Rsbuild](https://github.com/web-infra-dev/rsbuild) | MIT | 构建工具 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | 样式 |

## 后端

PocketBase 为官方 v0.28.1（MIT）。后台界面汉化采用**源码编译**方案：
就地修改 PocketBase 的 UI 源码文案后重新构建并交叉编译，再打进本地镜像。
早期曾用过「nginx 反代注入脚本」的方案，因维护成本高、且注入层需要额外维护
集合名与字段名的映射，已完全移除 —— 现在不存在任何反代或运行时注入。
详见 `RUN.md` 的「后台汉化」章节。
