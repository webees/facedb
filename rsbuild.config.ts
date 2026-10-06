import { defineConfig } from '@rsbuild/core';
import { pluginVue } from '@rsbuild/plugin-vue';

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
  },

  output: {
    distPath: { root: 'dist' },
  },

  // PostCSS 由 Rsbuild 自动读取项目根的 postcss.config.mjs，无需在此配置。
  tools: {
    rspack: {
      // MediaPipe 的 UMD 包内含动态 require（vision_bundle.mjs:1），属第三方库已知告警。
      //
      // 这里把匹配收窄到该来源，而不是通配 /Critical dependency/ ——
      // 实测（不屏蔽时）全量告警只有这 1 条、且来自 node_modules，
      // 但通配写法会把本项目将来引入的同类告警一并静默掉，收窄后不会再掩盖自有问题。
      ignoreWarnings: [{ module: /@mediapipe/, message: /Critical dependency/ }],
    },
  },
});
