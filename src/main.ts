// 遥测拦截的「运行期」一层：替换 fetch / XHR / sendBeacon，拦住应用运行中的外发。
//
// 实测（把本行挪到 vue 之后重建对比）：两种顺序下都没有 googleapis 请求发出 ——
// 说明【拦住加载期遥测的是 index.html 里的内联拦截与 CSP】，不是这里的 import 顺序。
// 所以本行不必强求排在最前，但也请保留在应用自己的模块之前，
// 因为它是运行期唯一的 JS 层防线（无法覆盖 Worker，那由 CSP 兜）。
import './lib/block-telemetry'

import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

createApp(App).mount('#root')
