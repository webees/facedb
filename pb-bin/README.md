# pb-bin 二进制清单与溯源（B#6）

本文件记录 `pb-bin/pocketbase-zh` 的**来源与校验值**，使「干净重建」不必再靠某个会话的记忆。
校验值同时被 `pb-bin/Dockerfile` 的构建期白名单读取：**sha256 不在本清单内 → 构建立即失败**。

| 项 | 值 |
|---|---|
| 文件 | `pb-bin/pocketbase-zh` |
| 平台 | Linux / arm64（aarch64，静态链接 ELF） |
| 大小 | 41,709,597 字节 |
| sha256 | `85a10d0baf5d42d631735304baaaefd79e8a118658daf64981ecda30ebea8ef0` |
| md5 | `115ca8dd9bcbdd667ecc617175c803ed` |
| 自报版本 | `pocketbase version (untracked)`（源码编译产物没有版本号） |
| 运行时基座 | `ghcr.io/muchobien/pocketbase:0.28.1`（amd64 之外仅用于提供运行环境） |

## 来源

- 源码：`../webees@pocketbase`（PocketBase v0.28.1 源码，git HEAD `e73077e7e7eb2005a244b748ecc9bbf5d32d4ea9`）
  - 该工作树就地做过汉化替换（`git status` 显示 259 个已修改文件），汉化词表脚本为运行根下的
    `pb-source-i18n-v2.mjs`（注意：当前运行根 `run-20261006-160618` 下**该脚本已不存在**，
    只存在于上一轮运行根 `run-20261005-010657`，见 `findings/R01-C.json` C-13——重建前需先把它找回来）。
- 编译方式（与 `RUN.md` 1531-1542 行一致）：

```bash
cd ../webees@pocketbase
git checkout -- ui/src                              # 先恢复干净源码（替换是幂等的）
node <运行根>/pb-source-i18n-v2.mjs --write         # 应用词表（超 1290 处）
cd ui && npm run build && cd ..                     # 构建 UI（产物被 go:embed 打进二进制）
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o pocketbase-zh-linux examples/base/main.go
cp pocketbase-zh-linux ../webees@facedb/pb-bin/pocketbase-zh
```

## 重建后必须做的事

1. 重新计算 sha256/md5 与文件大小：

```bash
cd pb-bin
shasum -a 256 pocketbase-zh && md5 -q pocketbase-zh && stat -f '%z' pocketbase-zh
```

2. 若校验值变化，**必须同时更新两处**，否则构建会失败（这是预期的）：

   - `pb-bin/SHA256SUMS`（允许清单）
   - `pb-bin/Dockerfile` 的 `PB_EXPECTED_MD5` / `PB_EXPECTED_SIZE`

   然后更新本文件表格。**注意：本文件不参与构建校验** —— 「构建失败」只由上面两处触发，
   本文件写错不会被拦住（本文件的指纹曾因此与实际二进制脱节）。
   建议每次重建后跑运行根的 `lib/check-pbbin-fingerprint.mjs` 做三方比对。
3. `docker compose build pocketbase` 会执行白名单与架构断言，任何未登记的二进制都会被拦下。

## 已知边界（如实记录）

- 白名单是**仓库内**的自证：清单与二进制同处一个仓库，能拦住「拿错二进制/被打包进来无关程序」，
  但不能抵抗「同时改二进制与清单」的提交；要抵抗后者需要仓库外的签名或公证（当前工程无此设施）。
- 本清单只登记 arm64 一份构建（`PB_ALLOWED_ARCH=arm64`）。要在 x86 主机上构建需先产出 amd64 二进制、
  登记其 sha256，并把 `amd64` 加进 `PB_ALLOWED_ARCH`。
