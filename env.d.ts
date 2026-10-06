/// <reference types="@rsbuild/core/types" />

// 打开 import.meta.env 的严格检查：未在 ImportMetaEnv 里声明的键会报 TS2339，
// 而不是退化到 @rsbuild/core/types 的 `[key: string]: any` 兜底。
// 未开时实测：把下面那条 PUBLIC_PB_URL 声明删掉也不报错 —— 整条类型链形同虚设。
interface RsbuildTypeOptions {
  strictImportMetaEnv: true;
}

interface ImportMetaEnv {
  // 可选：默认留空，此时前端在运行时按页面地址推导后端（见 src/lib/pb.ts）。
  // 仅当后端不在同一主机时才通过构建参数注入绝对地址。
  readonly PUBLIC_PB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
