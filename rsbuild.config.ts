import { defineConfig } from '@rsbuild/core';
import { pluginVue } from '@rsbuild/plugin-vue';

/**
 * index.html 里 CSP 的额外 connect-src 源，按构建期的 PUBLIC_PB_URL 推导。
 *
 * 为什么必须有：`connect-src` 里的 `*:8090` 只覆盖「方案与文档一致 + 恰好 8090 端口」，
 * 而 PUBLIC_PB_URL 的推荐写法是 `https://pb.example.com`（标准 443 端口）——
 * 实测该地址会被文档自己的 CSP 拦死，上传必然失败。留空时退化为空串，
 * CSP 与旧版逐字一致（默认部署行为不变）。
 *
 * 同时给出对应的 WebSocket 方案（PB 的实时订阅走 SSE 属 http，这里只为将来留口）。
 */
function derivePbConnectSrc(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    const ws = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return ` ${u.origin} ${ws}//${u.host}`;
  } catch {
    // 非绝对地址（相对路径、单主机名等）不追加：这类值本就不能作为跨源地址使用，
    // 静默追加一个猜出来的源只会掩盖配置错误。
    return '';
  }
}

export default defineConfig({
  plugins: [pluginVue()],

  source: {
    // src/main.ts 不是 Rsbuild 的默认入口名，必须显式声明。
    entry: { index: './src/main.ts' },
  },

  html: {
    // 入口 script/link 由 Rsbuild 自动注入，模板内不要手写。
    template: './index.html',
    title: 'facedb',
    templateParameters: {
      PB_CONNECT_SRC: derivePbConnectSrc(process.env.PUBLIC_PB_URL),
    },
  },

  output: {
    distPath: { root: 'dist' },
    // 分发物必须自带第三方许可声明（见 THIRD-PARTY-NOTICES.md 第 2.2 节）。
    // 用 Rsbuild 内建的 output.copy（rspack CopyPlugin 的封装）而不是自写插件：
    // 自写插件要 import('node:fs')，而本仓库没装 @types/node，typecheck 会红。
    copy: [{ from: 'THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' }],
  },

  // PostCSS 由 Rsbuild 自动读取项目根的 postcss.config.mjs，无需在此配置。
  tools: {
    rspack: {
      // MediaPipe 的 UMD 包内含**表达式动态 import**（vision_bundle.mjs 偏移 55951），属第三方库已知告警。
      // 措辞更正（R38 / W38A-06）：此前写「动态 require」是错的 —— 实测 vision_bundle.{cjs,mjs,js}
      // 里 `require(` 出现 0 次，真正触发 rspack 的 Critical dependency 告警的是动态 import。
      //
      // 这里把匹配收窄到该来源，而不是通配 /Critical dependency/ ——
      // 实测（不屏蔽时）全量告警只有这 1 条、且来自 node_modules，
      // 但通配写法会把本项目将来引入的同类告警一并静默掉，收窄后不会再掩盖自有问题。
      ignoreWarnings: [{ module: /@mediapipe/, message: /Critical dependency/ }],
    },
  },
});
