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
function pbUrlOrThrow(v: string): URL {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    // 不可解析（相对路径、单主机名、多值）⇒ 构建期直接失败。
    // 旧实现静默返回空串：产物与「未配置」逐字节相同，于是配置写错时全部静态判据照样全绿，
    // 症状只在真浏览器里表现为上传失败（R39-LEAD-01 · W39-C · W39-REV RED-01）。
    throw new Error(
      `PUBLIC_PB_URL 必须是带方案的绝对 URL（例如 https://pb.example.com 或 http://192.168.1.5:8090），当前值是 ${JSON.stringify(v)}`,
    );
  }
  // 只接受「源」：带路径的覆盖值在运行期被原样拼成 `<path>/api/collections/...`
  // （src/lib/pb.ts 的 PB_BASE 只去掉尾部斜杠），PB 回 404、**库里零写入**，而界面显示成功 ——
  // R39 实测 `http://<host>/facedb` 与 `.../facedb/` 归一化后逐字相同。网关必须把 /api/* 与
  // /_/* 映射在域名根（见 RUN.md「后端地址的推导规则」），所以这里 fail-closed，不做静默裁剪。
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '') {
    throw new Error(
      `PUBLIC_PB_URL 只接受源（scheme://host[:port]），不接受路径、查询或片段：当前值是 ${JSON.stringify(v)}`,
    );
  }
  return u;
}

function derivePbConnectSrc(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  const u = pbUrlOrThrow(v);
  // 只认 http:/https: —— PB 的 API 与实时订阅（SSE）都走 http；其它方案（ws:/wss:/ftp:/data: 等）
  // 不属于 connect-src 的 fetch 通道，且非特殊方案会被 CSP 解析成不透明源（`null`）。
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`PUBLIC_PB_URL 只支持 http:/https:，当前方案是 ${u.protocol}（值：${JSON.stringify(v)}）`);
  }
  const ws = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // 主机里出现分隔符/引号时 `new URL` 仍会「解析成功」并给出一个垃圾主机
  // （实测 `http://a.example.com,http://b.example.com` ⇒ 主机 `a.example.com,http`），
  // 追加进 CSP 只会得到一个被浏览器忽略的源 —— 配置错误再次静默通过。
  if (/[\s,;'"]/.test(u.host)) {
    throw new Error(`PUBLIC_PB_URL 的主机部分含非法字符（空白/逗号/分号/引号）：${JSON.stringify(u.host)}`);
  }
  // 去重：显式写了默认端口时（http://h:80）origin 与 ws 源可能逐字相同。
  return ` ${[...new Set([u.origin, `${ws}//${u.host}`])].join(' ')}`;
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
