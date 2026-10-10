# facedb 采集端

[![CI](https://github.com/webees/facedb/actions/workflows/ci.yml/badge.svg)](https://github.com/webees/facedb/actions/workflows/ci.yml)

浏览器端的人脸采集与姿态质检工具，配套自建 [PocketBase](https://pocketbase.io/) 存档。
用于现场按**六个采集点**采集人脸照片与短视频，全部推理在浏览器本地完成，不依赖任何人脸识别云服务。

## 功能

- **六个体位采集点**：正面 / 左转 30° / 右转 30° / 抬头 / 低头 / 活体（依次）。
- **实时质检**：人脸数量、人脸占比、姿态（yaw / pitch / roll）、清晰度（拉普拉斯方差）、
  亮度、眨眼（活体步），未达标时给出**带方向的**中文/英文提示。
- **防抖表决**：普通提示需在最近 5 帧中达成 3 帧共识才上屏，避免文案闪烁；姿态切换等
  离散事件立即生效。
- **自动拍摄**：5 个照片采集点各连拍 2 张 JPEG（合计 10 张，质量 0.92），六个采集点
  各录 1 段 WebM（合计 6 段），一并打包为一条 PocketBase 记录，按链接里的
  **采集编号**（`session_id`）分组。
- **批量上传**：一次请求上传整批文件，共用 90 秒**墙钟**预算；内外两层重试相乘
  （外层 3 轮 × 内层 3 次 = 最坏 9 次尝试），预算耗尽即停，失败可原地重试
  （照片与视频不会因为一次网络抖动而全部丢弃）。「最多 3 次」只在单层成立，见 `RUN.md` 的口径更正。
- **无遥测**：三层拦截（CSP、`index.html` 内联拦截、`block-telemetry` 运行期补丁）阻断
  MediaPipe 自身可能发起的 Google 遥测请求。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | Vue 3.5 + TypeScript 5.9 + Rsbuild 2 + Tailwind CSS v4 |
| 本地推理 | `@mediapipe/tasks-vision` 1.0.1（FaceLandmarker，GPU 优先并回退到 CPU，wasm 与模型随前端一起发布） |
| 后端 | PocketBase（本地化构建，SQLite 存储，`pb_migrations/` 为唯一 schema 来源）。**版本有两套口径**：`pb-bin/` 脚本产出的基线是 `0.28.1-zh`，而当前部署态跑的是 `0.40.4-zh`（`docker compose` 指定的 tag） |
| 静态服务 | `static-web-server`（生产容器内运行的是**构建产物**，不是 dev server） |
| 部署 | Docker Compose：`web`（:3000）+ `pocketbase`（:8090） |

运行时与浏览器基线（Node 版本、构建转译档位、实际最低浏览器版本）以 [`RUN.md`](RUN.md) 的「运行时与浏览器基线」段为唯一出处，并由 `scripts/check-repo-standards.mjs` 的 S36/S37 逐项对拍。

## 快速开始

```bash
cp .env.example .env          # 默认留空 PUBLIC_PB_URL：前端在运行时按页面地址推导后端地址
docker compose up -d --build  # 采集端 → http://localhost:3000/<采集编号>，后台 → http://localhost:8090/_/
```

首次启动后按 `RUN.md` 的说明在后台创建超级用户，然后访问
`http://localhost:3000/202610050528` 之类的链接开始采集。链接末段即采集编号，
它决定这批数据在后台的分组，规则：**1–200 个 Unicode 码点，首尾不得为空白或分隔符，
不得包含控制字符**（不合规会被后端以 400 拒绝）。

## 目录结构

```
src/                 前端源码
  components/        CaptureView.vue（采集流程主体）、CaptureFooter.vue（页脚与操作按钮）
  lib/               capture.ts 录制/拍照、face.ts 推理、quality.ts 质检判定、
                     pb.ts 上传、i18n.ts 文案、hints.ts 提示状态机、audio.ts 提示音、
                     block-telemetry.ts 遥测拦截、upload-batch.ts 批量上传、
                     batch-files.ts 文件批构造、submit-key.ts 幂等键
pb_migrations/       PocketBase 迁移（集合、字段、约束、权限的唯一来源）
public/              随前端发布的静态资源（MediaPipe wasm、人脸模型、SHA256SUMS 清单）
pb-bin/              PocketBase 本地化二进制与构建说明（二进制本体不入库，只入库指纹清单）
docs/                第三方依赖与 UI 调研文档
RUN.md               运行手册 + 全部实测记录（部署、阈值、边界、已知取舍）
```

## 开发

```bash
npm ci             # 按 package-lock.json 安装
npm run dev        # 开发服务器
npm run typecheck  # vue-tsc --noEmit
npm run verify     # 仓库自检（7 节）：资源指纹、迁移可解析性与约束不变量、文案键对称、
                   # pb-bin 指纹、RUN.md 常量、CSP 覆盖范围、启动兜底框转义
npm run build      # 生产构建
```

## 数据与隐私

- 照片与视频**只**上传到你自己部署的 PocketBase；前端代码里没有任何第三方上传地址。
- 人脸检测在浏览器本地完成（MediaPipe wasm + 3.7 MB 模型），不把画面送出去做推理。
- 采集数据默认由 PocketBase 的字段规则保护：`captures` 集合不允许匿名读取，写入需通过
  现场链接；部署方应自行按需收紧密集权限与备份策略，详见 `SECURITY.md`。
- 仓库内不含任何真实采集数据；`pb_data/`、`dist/`、`node_modules/` 与本地化二进制均在
  `.gitignore` 之内。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`RUN.md`](RUN.md) | 运行手册：部署、构建、后端约束、阈值与边界实测、已知取舍与教训 |
| [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md) | 运行时依赖与许可证清单 |
| [`docs/face-ui-research.md`](docs/face-ui-research.md) | 人脸采集界面调研与设计依据 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录（Keep a Changelog / SemVer） |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 分支、提交、评审与合并规范 |
| [`SECURITY.md`](SECURITY.md) | 漏洞报告流程与数据安全边界 |

## 许可

本项目以 **MIT** 许可证发布，全文见 [`LICENSE`](LICENSE)。
