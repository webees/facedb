# facedb 采集页镜像（多阶段 + 极简静态服务器）
#
# 体积演进：
#   单阶段 node:22-slim + node_modules     934MB
#   多阶段 + nginx:alpine                  131MB   ← nginx 自身就占 78.2MB
#   多阶段 + static-web-server:alpine      66.6MB  ← 当前（docker images 口径、arm64，2026-10-07 实测；
#                                                      同口径下删掉死 wasm 模块前为 80MB。体积必须连口径一起写）
#
# 关键认识：dist 只有 27.4MB（12 个文件合计 27,408,705 字节；39.5MB 是删掉死 wasm 变体之前的读数），
# 镜像的大头从来不是产物，而是「托管它的服务器」。
# 两个口径都实测过（2026-10-07，arm64）：
#   docker images 的 Size          nginx:1.27-alpine 78.2MB   static-web-server:2-alpine 58.6MB
#   docker image inspect .Size     nginx:1.27-alpine 21,832,241 字节   static-web-server:2-alpine 8,190,662 字节
# 两个口径下 static-web-server 都明显更小，且原生支持 SPA 回退。

# ─────────────────────────── 构建阶段 ───────────────────────────
FROM node:22-slim AS build
WORKDIR /app

# 依赖层单独缓存：package 文件不变就不重装
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# PUBLIC_PB_URL 会被内联进产物（Rsbuild 的 import.meta.env）。
# 留空即可：产物在运行时按页面地址推导后端。
ARG PUBLIC_PB_URL=
ENV PUBLIC_PB_URL=$PUBLIC_PB_URL

COPY . .
RUN npm run build

# ─────────────────────────── 运行阶段 ───────────────────────────
FROM joseluisq/static-web-server:2-alpine

# 站点配置：全部用环境变量（该镜像原生支持 SERVER_* 前缀）
ENV SERVER_ROOT=/public
ENV SERVER_PORT=3000
ENV SERVER_HOST=0.0.0.0
# SPA 回退：采集页 URL 形如 /202610050513，路径段是采集编号而非真实文件，
# 不做回退就会 404。用绝对路径（该选项要求不相对 root）。
ENV SERVER_FALLBACK_PAGE=/public/index.html
# 只压文本，二进制（wasm/模型）本就压不动
ENV SERVER_COMPRESSION=true
ENV SERVER_COMPRESSION_LEVEL=default
# B#4：回退页保住了深链接（/202610050513），代价是「缺失资源也返回 200 + index.html」。
# static-web-server 2.44.0 的缓存策略只能按请求路径匹配（CLI 只有全局开关 --cache-control-headers；
# 配置文件 advanced.headers 的路径 glob 同样无法区分「真实文件」与「回退响应」，实测见
# evidence/R02-CT-03b-b4-capability.log），于是缺失的 .js/.css/.png 被按扩展名赋 max-age=31536000，
# 等于把回退页当资产缓存一年。这里关掉自动缓存头：不再向客户端下达 1 年强缓存，
# 真实产物改为 Last-Modified 协商缓存（实测：带 If-Modified-Since 仍是 304，不带则 200；
# 该开关同时也会去掉 ETag，所以协商只剩时间戳这一条路——见 evidence/R02-CT-11-b4-cache-after.log）。
ENV SERVER_CACHE_CONTROL_HEADERS=false

# 仅拷贝构建产物；--chown 是必需的：该镜像默认以非 root 用户（uid 1000）运行，
# 而 COPY 出来的文件属主是 root，权限不符会导致 403。
COPY --from=build --chown=1000:1000 /app/dist /public

EXPOSE 3000

# 构建期自证：产物必须在，避免打出能启动但打不开页面的空壳
USER root
RUN test -f /public/index.html \
 && test -f /public/face_landmarker.task \
 && test -f /public/wasm/vision_wasm_internal.wasm \
 && echo "artifacts ok"
USER 1000

# 健康检查用镜像自带的 wget。
# B#8：这组数值必须与 docker-compose.yml 的 web.healthcheck 完全一致——compose 起容器时
# compose 的值会整体覆盖这里的烘焙值（实测 docker inspect 生效的是 compose 值），
# 两处不一致就等于 Dockerfile 里这份是死代码，还会误导只看 Dockerfile 的人。
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s --start-interval=3s \
  CMD wget --spider -q http://127.0.0.1:3000/ || exit 1
