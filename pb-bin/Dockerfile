# 本地汉化版 PocketBase 镜像：官方运行时 + 源码汉化编译产物（双架构：arm64 / amd64）
# 构建上下文 = 本目录（pb-bin/），父级 .dockerignore 里的 pb-bin 规则不影响这里
#
# 二进制来源、编译参数与重建步骤见本目录 README.md；允许清单见本目录 SHA256SUMS（随仓库提交）。
#
# 构建期二进制校验是「正向白名单 + 分架构断言」（B#3/B#5）：
#   旧实现是「md5 != 官方原版」的否定式断言——只能排除恰好等于那一个 md5 的文件，
#   其它任何二进制（别的版本、无关可执行文件）都能通过，证明力接近零。
#   现在：sha256 必须命中 SHA256SUMS 里的某一条（未登记 → 构建失败），
#   且必须逐一命中该架构的 sha256/md5/size 常量，TARGETARCH 必须在允许架构内，
#   文件自身 ELF e_machine 必须与 TARGETARCH 相符 —— 五重正向断言，缺一即失败。
#
# 分架构常量（与 pb-bin/SHA256SUMS、pb-bin/README.md 三方一致）：
#   arm64  size=41709597 md5=115ca8dd9bcbdd667ecc617175c803ed sha256=85a10d0baf5d42d631735304baaaefd79e8a118658daf64981ecda30ebea8ef0
#   amd64  size=43624965 md5=ac39fb7771e03eb49a986f99a1789313 sha256=3786b4f5cbc35379129a35123dd5d2303744036d7fd9c0974d0d089ce3eb0490
#
# 双架构分派：Dockerfile 的 COPY 不能按 ARG 条件选源文件，若把两份都 COPY 进最终镜像再删，
# 被删的那份仍留在下层 layer 里（白占 ~40MB）。故用中间 stage 先按 TARGETARCH 选出一份，
# 最终 stage 只 `COPY --from=prepare` 这一份 —— 未选中的架构不进最终镜像。
FROM ghcr.io/muchobien/pocketbase:0.28.1 AS prepare

ARG TARGETARCH
COPY pocketbase-zh-linux-arm64 /tmp/pb/arm64
COPY pocketbase-zh-linux-amd64 /tmp/pb/amd64
RUN set -eu; \
    mkdir -p /out; \
    case "${TARGETARCH}" in \
      arm64) cp /tmp/pb/arm64 /out/pocketbase ;; \
      amd64) cp /tmp/pb/amd64 /out/pocketbase ;; \
      *) echo "REFUSED: unsupported TARGETARCH=${TARGETARCH}"; exit 1 ;; \
    esac

FROM ghcr.io/muchobien/pocketbase:0.28.1

ARG TARGETARCH
ARG PB_ALLOWED_ARCH="arm64 amd64"

COPY --from=prepare /out/pocketbase /usr/local/bin/pocketbase
COPY SHA256SUMS /tmp/PB-SHA256SUMS

# ① 取该架构的期望常量 ② TARGETARCH 允许清单 ③ 尺寸粗筛 ④ sha256 白名单（SHA256SUMS 登记）
# ⑤ sha256 正向比对 ⑥ 固定预期 md5（同时排除官方原版 50c14b87…）
# ⑦ ELF e_machine 与 TARGETARCH 一致性（该镜像无 file/readelf，用 od 读 ELF 头 offset 18）
RUN set -eu; \
    f=/usr/local/bin/pocketbase; \
    chmod 0755 "$f"; \
    case "${TARGETARCH}" in \
      arm64) want_machine=183; want_size=41709597; want_md5=115ca8dd9bcbdd667ecc617175c803ed; want_sha256=85a10d0baf5d42d631735304baaaefd79e8a118658daf64981ecda30ebea8ef0 ;; \
      amd64) want_machine=62;  want_size=43624965; want_md5=ac39fb7771e03eb49a986f99a1789313; want_sha256=3786b4f5cbc35379129a35123dd5d2303744036d7fd9c0974d0d089ce3eb0490 ;; \
      *) echo "REFUSED: unknown arch ${TARGETARCH}"; exit 1 ;; \
    esac; \
    case " ${PB_ALLOWED_ARCH} " in *" ${TARGETARCH} "*) ;; *) echo "REFUSED: TARGETARCH=${TARGETARCH} not in allowed [${PB_ALLOWED_ARCH}]"; exit 1;; esac; \
    size=$(stat -c %s "$f"); \
    [ "$size" = "$want_size" ] || { echo "REFUSED: size=$size != ${want_size} (TARGETARCH=${TARGETARCH})"; exit 1; }; \
    actual=$(sha256sum "$f" | cut -d' ' -f1); \
    grep -qE "^${actual}[[:space:]]" /tmp/PB-SHA256SUMS || { echo "REFUSED: sha256 ${actual} not in pb-bin/SHA256SUMS allowlist"; exit 1; }; \
    [ "$actual" = "$want_sha256" ] || { echo "REFUSED: sha256 ${actual} != ${want_sha256} (TARGETARCH=${TARGETARCH})"; exit 1; }; \
    echo "${want_md5}  ${f}" | md5sum -c -; \
    machine=$(od -An -tu2 -j18 -N2 "$f" | tr -d ' '); \
    [ "$machine" = "$want_machine" ] || { echo "REFUSED: ELF e_machine=${machine} != TARGETARCH=${TARGETARCH} (want ${want_machine})"; exit 1; }; \
    echo "binary ok: arch=${TARGETARCH} e_machine=${machine} size=${size} sha256=${actual} md5=${want_md5}"
