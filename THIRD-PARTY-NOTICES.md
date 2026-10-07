# 第三方软件声明（Third-Party Notices）

本文件随**分发物**一起提供：构建时由 `rsbuild.config.ts` 的 `output.copy` 复制到 `dist/THIRD-PARTY-NOTICES.md`，
而 `dist/` 是 web 容器（`--publicDir=/pb_public`）的静态根 —— 也就是说，任何拿到本服务前端产物的人
都能在 `https://<host>/THIRD-PARTY-NOTICES.md` 读到本文件。

本文件回答的是「**分发物里有哪些第三方代码、各自什么许可、许可原文在哪**」。
逐包清单与构建期依赖的完整说明见 [`docs/THIRD-PARTY.md`](docs/THIRD-PARTY.md)；本仓库自身的许可见 [`LICENSE`](LICENSE)（MIT）。

## 1. 本项目

`facedb` 采集端 —— MIT，版权归 webees。见 [`LICENSE`](LICENSE)。

## 2. 随前端产物分发的第三方代码

| 组件 | 版本 | 许可证 | 分发形态 |
| --- | --- | --- | --- |
| [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) | 1.0.1 | Apache-2.0 | 打进 JS 产物（`dist/static/js/m.*.js`，含 `FaceLandmarker` 符号） |
| [`vue`](https://www.npmjs.com/package/vue) | 3.5.43 | MIT | 打进 JS 产物（`dist/static/js/lib-vue.*.js`，Rsbuild 自动生成 `.LICENSE.txt` 侧车） |

### 2.1 MediaPipe 随镜像分发的模型与运行时资源

以下文件**不在** npm 包内，而是随镜像分发（`Dockerfile` 有构建期断言 `RUN test -f …` 保证它们必须进镜像）：

| 文件 | 字节数 | 来源 | 许可证 |
| --- | --- | --- | --- |
| `public/wasm/vision_wasm_internal.js` | 323377 | `@mediapipe/tasks-vision/wasm` | Apache-2.0 |
| `public/wasm/vision_wasm_internal.wasm` | 11756954 | 同上 | Apache-2.0 |
| `public/wasm/vision_wasm_nosimd_internal.js` | 323180 | 同上 | Apache-2.0 |
| `public/wasm/vision_wasm_nosimd_internal.wasm` | 10960242 | 同上 | Apache-2.0 |
| `public/face_landmarker.task` | 3758596 | MediaPipe 官方模型（`face_landmarker`） | Apache-2.0 |

实测归属事实（R20）：`public/wasm` 的 4 个文件与 `node_modules/@mediapipe/tasks-vision/wasm` 下的同名文件**逐字节相同**，
且已在 `public/SHA256SUMS` 登记（`npm run verify:public` 会校验）。

### 2.2 为什么这一节必须存在

`node_modules/@mediapipe/tasks-vision` 包内**不含** `LICENSE` / `NOTICE` / `COPYING` 任何一个文件
（R20 实测：目录下只有 `package.json`、`wasm/`、各 `*.mjs` 产物），上游也未提供 NOTICE 文本。
Apache-2.0 第 4 条要求「向接收者提供许可证副本」，因此许可证原文必须由**分发方**随附 ——
本文件即为此而设。

## 3. 构建期依赖（不随分发物提供）

构建期工具链（`@rsbuild/*`、`typescript`、`tailwindcss`、`lightningcss`、`vue-tsc` 等）不进入运行时产物：
`Dockerfile` 的运行阶段不 `COPY node_modules`。其中 `lightningcss` 与其平台包为 **MPL-2.0**（弱 copyleft），
由于其代码不分发，MPL-2.0 的文件级 copyleft 义务不触发；完整清单与各包许可证见 `docs/THIRD-PARTY.md`。

## 4. 运行期闭包清单（自动生成）

<!-- BEGIN GENERATED: runtime-closure -->
<!-- 本块由 lib/r20-thirdparty-gen.mjs 从 package-lock.json 生成，勿手改；改依赖后重跑该脚本。 -->
运行期闭包（lock 推导，共 24 个包）：

| 包 | 版本 | 许可证 |
| --- | --- | --- |
| `@babel/helper-string-parser` | 7.29.7 | MIT |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT |
| `@babel/parser` | 7.29.9 | MIT |
| `@babel/types` | 7.29.8 | MIT |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT |
| `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 |
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
| `entities` | 7.0.1 | BSD-2-Clause |
| `estree-walker` | 2.0.2 | MIT |
| `magic-string` | 0.30.21 | MIT |
| `nanoid` | 3.3.19 | MIT |
| `picocolors` | 1.1.1 | ISC |
| `postcss` | 8.5.28 | MIT |
| `source-map-js` | 1.2.2 | BSD-3-Clause |
| `vue` | 3.5.43 | MIT |
<!-- END GENERATED: runtime-closure -->

## 5. 许可证原文

### 5.1 Apache License 2.0（适用于 `@mediapipe/tasks-vision` 及其随镜像分发的 wasm 与模型文件）

<!-- Apache-2.0 官方全文（含 APPENDIX），取自 node_modules/detect-libc/LICENSE；本机 @mediapipe/tasks-vision 包内不含任何许可文件。 -->

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright {yyyy} {name of copyright owner}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

### 5.2 MIT License（适用于 `vue`）

The MIT License (MIT)

Copyright (c) 2018-present, Yuxi (Evan) You

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
