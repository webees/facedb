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
| [vue](https://github.com/vuejs/core) | MIT | 前端框架 |
| [Rsbuild](https://github.com/web-infra-dev/rsbuild) | MIT | 构建工具 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT | 样式 |
| [@rsbuild/plugin-vue](https://github.com/web-infra-dev/rsbuild) | MIT | 构建期 Vue 单文件组件支持 |
| [@tailwindcss/postcss](https://github.com/tailwindlabs/tailwindcss) | MIT | 构建期 Tailwind PostCSS 插件 |
| [typescript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 构建期类型检查（tsc / 类型擦除） |
| [vue-tsc](https://github.com/vuejs/language-tools) | MIT | 构建期 `.vue` 类型检查 |

上表最后四行是开发 / 构建期依赖（`devDependencies`），不进运行产物。

### 运行期闭包（`npm ls --prod --all` 实测，2026-10-08）

**口径**：`npm ls --prod --all` 在工程根实跑，输出 **31 个唯一包** = 2 个直接依赖
（`@mediapipe/tasks-vision`、`vue`）+ **29 个传递包**（R30 重测；早期读数是 32 = 3 直接 + 29，
多出的那个直接依赖 `pocketbase` 已从 `package.json` 移除，见下方备注 2）。每个包的 `license` 值都是从
`node_modules/<pkg>/package.json` 的 `license` 字段**实读**的，不是从上游仓库猜的。
下表按包名排序，与上表重复的两个直接依赖也一并列出以便核数。
**两种口径别混**：本表是「装出来的树」（`npm ls --prod --all`，31 个）；`THIRD-PARTY-NOTICES.md` 的自动生成块是
「lock 的非 dev 闭包」（24 个）—— 差额来自 lock 里被标 `dev` 的旁支（`@emnapi/*`、`@napi-rs/*`、`@tybys/*`、`tslib`、`typescript`），
它们装在 `node_modules` 里但不属于 lock 的运行时闭包。

⚠️ 两点口径提醒：`Rsbuild` / `Tailwind CSS` / `@rsbuild/plugin-vue` / `@tailwindcss/postcss` / `vue-tsc`
是 `devDependencies`，`--prod` 树里**根本不出现**（它们的许可仍见上表）；`typescript` 既是
`devDependencies` 又出现在这棵树里，因为 `vue@3.5.43` 的 `peerDependencies` 是 `{"typescript":"*"}`
（`package-lock.json` 里 `node_modules/vue` 条目原文），npm 按根上的 `^5.9.3` 实装了一份。

| 包 | 版本 | 许可 |
|---|---|---|
| `@babel/helper-string-parser` | 7.29.7 | MIT |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT |
| `@babel/parser` | 7.29.9 | MIT |
| `@babel/types` | 7.29.8 | MIT |
| `@emnapi/core` | 1.11.3 | MIT |
| `@emnapi/runtime` | 1.11.3 | MIT |
| `@emnapi/wasi-threads` | 1.2.3 | MIT |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT |
| `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 |
| `@napi-rs/wasm-runtime` | 1.1.6 | MIT |
| `@tybys/wasm-util` | 0.10.4 | MIT |
| `@vue/compiler-core` | 3.5.43 | MIT |
| `@vue/compiler-dom` | 3.5.43 | MIT |
| `@vue/compiler-sfc` | 3.5.43 | MIT |
| `@vue/compiler-ssr` | 3.5.43 | MIT |
| `@vue/reactivity` | 3.5.43 | MIT |
| `@vue/runtime-core` | 3.5.43 | MIT |
| `@vue/runtime-dom` | 3.5.43 | MIT |
| `@vue/server-renderer` | 3.5.43 | MIT |
| `@vue/shared` | 3.5.43 | MIT |
| `csstype` | 3.2.3 | MIT |
| `entities` | 7.0.1 | **BSD-2-Clause** |
| `estree-walker` | 2.0.2 | MIT |
| `magic-string` | 0.30.21 | MIT |
| `nanoid` | 3.3.19 | MIT |
| `picocolors` | 1.1.1 | **ISC** |
| `postcss` | 8.5.28 | MIT |
| `source-map-js` | 1.2.2 | **BSD-3-Clause** |
| `tslib` | 2.8.1 | **0BSD** |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vue` | 3.5.43 | MIT |

三条必须一起读的备注：

1. **`entities` / `picocolors` / `source-map-js` / `tslib` 是闭包里唯一的四个非 MIT/Apache 许可**
   （BSD-2-Clause / ISC / BSD-3-Clause / 0BSD，四者都是宽松许可、均允许商用与再分发，
   义务只是保留版权与许可声明）。**0BSD 是四个里最宽松的** —— 它连署名义务都没有。
2. **`pocketbase` 已不是本仓库的依赖（R30 修正）**：它曾作为「后端与 JS SDK」登记在本表与上表，
   但 `package.json` 的 `dependencies` 现在只有 `@mediapipe/tasks-vision` 与 `vue`，`package-lock.json` 顶层也没有它，
   `node_modules/pocketbase` 目录不存在（移除该**死依赖**的改动已落地）。本文档曾写「有一笔在途改动尚未提交」，那是当时的事实，现已过期。
   **判「它现在算不算依赖」要读 `package.json`，别读本文。**
3. **`@mediapipe/tasks-vision` 的 `package.json` 里没有任何 `dependencies` / `optionalDependencies` /
   `peerDependencies` 字段** —— 它把 WASM 运行时随包分发（`wasm/`），所以那 6 个 `@emnapi/*`、
   `@napi-rs/*`、`@tybys/*`、`tslib` 是 npm 从 lock 里带出来的旁支，不是 MediaPipe 的声明依赖。
   npm 把其中 5 个标为 `extraneous`，本身就说明这条链是旁支。

## 随镜像分发的第三方资源

除了 `node_modules` 里的包，`web` 镜像里还**原样分发**两组第三方二进制资源（它们不是本仓库生成的）：

| 资源 | 位置 | 大小 | 许可 | 来源 |
|---|---|---|---|---|
| MediaPipe WASM 运行时（4 个文件） | `public/wasm/` | `vision_wasm_internal.js` 323377 B、`vision_wasm_internal.wasm` 11756954 B、`vision_wasm_nosimd_internal.js` 323180 B、`vision_wasm_nosimd_internal.wasm` 10960242 B | Apache-2.0 | `@mediapipe/tasks-vision` 包内的 `wasm/` |
| FaceLandmarker 模型 | `public/face_landmarker.task` | 3758596 B | Apache-2.0 | Google 官方发布的人脸关键点模型 |

三条已实测的归属事实（不是推断）：

1. `public/wasm/` 那 4 个文件与 `node_modules/@mediapipe/tasks-vision/wasm/` 下的同名文件
   **逐字节相同**（`shasum -a 256` 逐个比对，4/4 IDENTICAL）。也就是说 `public/wasm/` 是该包
   运行时的一份 **vendored 副本**，用途是让浏览器从本站同源路径加载，而不是从 CDN 拉。
2. 这 5 个文件都已在 `public/SHA256SUMS` 登记（含 sha256 与 size），仓库自检 `npm run verify`
   会按该清单做「登记项逐个比对 + 目录资源反向断言」。**换版本时必须同步该清单**，否则自检报红。
3. `Dockerfile:66-70` 在构建期断言这两组资源**必须进镜像**
   （`test -f /public/face_landmarker.task && test -f /public/wasm/vision_wasm_internal.wasm`），
   缺任何一个就构建失败 —— 这是「打出了能启动但打不开页面的空壳」的拦截。

### ✅ 已处置（R20-F7）：MediaPipe 的许可原文改为随分发物提供

打包产物 `dist/static/js/` 里，承载 MediaPipe 的 chunk 是 `m.79c0ab86b6.js`（154243 B，
内含 `FaceLandmarker` 等符号，与 `vision_bundle.mjs` 同源）。实测两个事实：

- **该 chunk 没有许可侧车文件**。同目录下只有 `lib-vue.0518959aef.js.LICENSE.txt`（421 B，
  内容是 `@vue/reactivity` / `@vue/runtime-core` / `@vue/runtime-dom` / `@vue/shared` 的 MIT 声明），
  **没有与 MediaPipe 对应的 `.LICENSE.txt`**。
- **`node_modules/@mediapipe/tasks-vision` 包内也没有许可原文**。该包目录下只有
  `README.md`、`package.json`（`license: "Apache-2.0"`）、`vision.d.ts`、`vision_bundle.{cjs,js,mjs}`
  及其 `.map`、`wasm/` —— **没有任何 LICENSE / NOTICE / COPYING 文件**。

Apache-2.0 第 4 条要求再分发时随附许可副本；上游包内不带原文，意味着这份义务落在**分发方**身上。
处置（R20-F7，2026-10-08）：

- 仓库根新增 [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)：含 **Apache-2.0 全文**（9195 字符，
  取自本机 `node_modules/typescript/LICENSE.txt` —— 该文件即 Apache-2.0 标准全文）、MIT 全文、
  随镜像分发的 wasm/模型文件清单，以及运行期闭包表（**口径**：`package-lock.json` 的非 dev 闭包，24 个包；
  与本文上表的 `npm ls --prod --all` 口径不同，后者是 31 个 —— 差额来自 lock 里被标 `dev` 的旁支）。
  生成器 `lib/r20-thirdparty-gen.mjs` **已不在本仓库**（运行根脚本未入库），改依赖后需按同一口径重新生成，
  再由 `npm run verify:notices` 校验该块与 lock 逐条一致。
- `rsbuild.config.ts` 的 `output.copy` 把它复制进 `dist/THIRD-PARTY-NOTICES.md`；`dist` 是 web 容器的
  静态根（`Dockerfile` 的 `COPY --from=build /app/dist /public`），因此它随镜像被分发，
  可在 `https://<host>/THIRD-PARTY-NOTICES.md` 读到。
- 判据 `scripts/check-third-party-notices.mjs` 守住这条链：文件在、Apache 全文完整、闭包块与 lock 一致、
  构建配置确实复制、且 `dist/` 里的副本与仓库根逐字节相同。

#### 如何在线上核验（**不要看状态码**）

```bash
# 1) 本地算出这份文件的指纹
shasum -a 256 THIRD-PARTY-NOTICES.md
# 2) 取线上那一份，比指纹（不是比 HTTP 状态码）
curl -s https://<host>/THIRD-PARTY-NOTICES.md | shasum -a 256
```

也可直接跑 `node scripts/check-third-party-notices.mjs --live https://<host>`（N10 会比 sha256）。

**为什么必须比内容**：本服务是 SPA，任何未命中的路径都会回退到 `index.html`，因此
`GET /THIRD-PARTY-NOTICES.md` 在**文件根本不存在**时也返回 **200**（实测：content-type 是
`text/html`，正文 sha256 与 `dist/index.html` 一致）—— 只看状态码的「可达性检查」在这里是**假通过**。
镜像重建后该路径才会返回真正的声明文件。

**仍未解决的部分**：上游未提供 NOTICE 文本，故本仓库只能随附许可证副本与归属声明，无法「保留上游 NOTICE」；
若上游日后发布 NOTICE，应把它并入 `THIRD-PARTY-NOTICES.md`。

## 后端

PocketBase 为官方 **v0.40.4**（MIT）。**基座版本按双态读**：
**部署态**是 `webees-facedb-pocketbase:0.40.4-zh`（生产容器正在跑，上游基座
`ghcr.io/muchobien/pocketbase:0.40.4@sha256:9390b7b63ce114dbab577be72e6ef75f718a19083866607fcbdd1b915632b943`）；
**仓库态**读 `pb-bin/Dockerfile` 的 `FROM` 与 `docker-compose.yml` 的 `image:` 标签 ——
工作区已改成 0.40.4，但那几个文件仍是**未提交的在途改动**，`HEAD` 上还写着
`ghcr.io/muchobien/pocketbase:0.28.1@sha256:c11d164acd6266e31d2b5e88160b7bb3902c472c1ec90e0f403f56e802f23935`。
0.28.1 是本工程 R19 及以前使用的版本，已不再部署。

后台界面汉化采用**源码编译**方案：
就地修改 PocketBase 的 UI 源码文案后重新构建并交叉编译，再打进本地镜像。
早期曾用过「nginx 反代注入脚本」的方案，因维护成本高、且注入层需要额外维护
集合名与字段名的映射，已完全移除 —— 现在不存在任何反代或运行时注入。
详见 `RUN.md` 的「后台汉化」章节。
