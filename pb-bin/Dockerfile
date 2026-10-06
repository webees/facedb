# 本地汉化版 PocketBase 镜像：官方运行时 + 源码汉化编译产物
# 构建上下文 = 本目录（pb-bin/），父级 .dockerignore 里的 pb-bin 规则不影响这里
#
# 二进制来源、编译参数与重建步骤见本目录 README.md；允许清单见本目录 SHA256SUMS（随仓库提交）。
#
# 构建期二进制校验是「正向白名单 + 架构断言」（B#3/B#5）：
#   旧实现是「md5 != 官方原版」的否定式断言——只能排除恰好等于那一个 md5 的文件，
#   其它任何二进制（别的版本、无关可执行文件）都能通过，证明力接近零。
#   现在：sha256 必须命中 SHA256SUMS 里的某一条（未登记 → 构建失败），
#   并且 TARGETARCH 必须在允许架构内、文件自身 ELF e_machine 必须与 TARGETARCH 相符。
FROM ghcr.io/muchobien/pocketbase:0.28.1

ARG TARGETARCH
ARG PB_ALLOWED_ARCH="arm64"
ARG PB_EXPECTED_MD5="115ca8dd9bcbdd667ecc617175c803ed"
ARG PB_EXPECTED_SIZE="41709597"

COPY pocketbase-zh /usr/local/bin/pocketbase
COPY SHA256SUMS /tmp/PB-SHA256SUMS

# ① 尺寸粗筛 ② sha256 白名单 ③ 固定预期 md5（双保险，同时排除官方原版 50c14b87…）
# ④ TARGETARCH 允许清单 ⑤ ELF e_machine 与 TARGETARCH 一致性（该镜像无 file/readelf，用 od 读 ELF 头 offset 18）
RUN set -eu; \
    f=/usr/local/bin/pocketbase; \
    chmod 0755 "$f"; \
    size=$(stat -c %s "$f"); \
    [ "$size" = "$PB_EXPECTED_SIZE" ] || { echo "REFUSED: size=$size != ${PB_EXPECTED_SIZE}"; exit 1; }; \
    actual=$(sha256sum "$f" | cut -d' ' -f1); \
    grep -qE "^${actual}[[:space:]]" /tmp/PB-SHA256SUMS || { echo "REFUSED: sha256 ${actual} not in pb-bin/SHA256SUMS allowlist"; exit 1; }; \
    echo "${PB_EXPECTED_MD5}  ${f}" | md5sum -c -; \
    case " ${PB_ALLOWED_ARCH} " in *" ${TARGETARCH} "*) ;; *) echo "REFUSED: TARGETARCH=${TARGETARCH} not in allowed [${PB_ALLOWED_ARCH}]"; exit 1;; esac; \
    case "${TARGETARCH}" in arm64) want=183;; amd64) want=62;; *) echo "REFUSED: unknown arch ${TARGETARCH}"; exit 1;; esac; \
    machine=$(od -An -tu2 -j18 -N2 "$f" | tr -d ' '); \
    [ "$machine" = "$want" ] || { echo "REFUSED: ELF e_machine=${machine} != TARGETARCH=${TARGETARCH} (want ${want})"; exit 1; }; \
    echo "binary ok: arch=${TARGETARCH} e_machine=${machine} size=${size} sha256=${actual} md5=${PB_EXPECTED_MD5}"
