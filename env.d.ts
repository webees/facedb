/// <reference types="@rsbuild/core/types" />

interface ImportMetaEnv {
  // 可选：默认留空，此时前端在运行时按页面地址推导后端（见 src/lib/pb.ts）。
  // 仅当后端不在同一主机时才通过构建参数注入绝对地址。
  readonly PUBLIC_PB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
