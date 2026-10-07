# pb-bin 二进制清单与溯源（B#6）

本文件记录 `pb-bin/` 下两份汉化二进制（**按架构分文件**）的**来源与校验值**，使「干净重建」不必再靠某个会话的记忆。
校验值同时被 `pb-bin/Dockerfile` 的构建期断言读取：**sha256 不在本清单内、或与该架构常量不符 → 构建立即失败**。

| 项 | arm64 | amd64 |
|---|---|---|
| 文件 | `pb-bin/pocketbase-zh-linux-arm64` | `pb-bin/pocketbase-zh-linux-amd64` |
| 平台 | Linux / arm64（aarch64，静态链接 ELF，`e_machine`=183） | Linux / amd64（x86-64，静态链接 ELF，`e_machine`=62） |
| 大小 | 41,709,597 字节 | 43,624,965 字节 |
| sha256 | `ad90eff9ce7fe6c925821637934fb812495f1817367db91376e29481a4fafac2` | `5a4a6bf172b4af4aafe4099866c13892cc56c0ac0ed6548bb91384eb8b516f80` |
| md5 | `caf52450b62c9f801487331a035dd56a` | `917b89275bffc43e6816e7f800fe9d5b` |
| 适用机 | 源机 nanopc-t6-lts（RK3588，aarch64） | 目标机（x86_64 构建机） |
| 自报版本 | `pocketbase version (untracked)`（源码编译产物没有版本号） | 同左 |
| 运行时基座 | `ghcr.io/muchobien/pocketbase:0.28.1`（多架构，随 `--platform` 取对应架构） | 同左 |

构建 `pb-bin/Dockerfile` 时按 `ARG TARGETARCH` 自动选对应文件，无需人工切换：
`docker buildx build --platform linux/arm64 …` 取 arm64 那份，`--platform linux/amd64 …` 取 amd64 那份。

## 来源

- 源码：`../webees@pocketbase`（PocketBase v0.28.1 源码，git HEAD `e73077e7e7eb2005a244b748ecc9bbf5d32d4ea9`）
  - 该工作树就地做过汉化替换（`git status --porcelain` 实测 316 行：**254 个已修改** + 29 个已删除 + 33 个未跟踪，2026-10-07 读数），汉化词表脚本为运行根下的
    `pb-source-i18n-v2.mjs`（注意：运行根 `run-20261006-160618` 下**该脚本已不存在**，
    只存在于上一轮运行根 `run-20261005-010657`，见 `findings/R01-C.json` C-13——重建前需先把它找回来）。
- 编译方式（与 `RUN.md`「容器权限」小节一致；两份产物只差 `GOARCH`，UI 产物已 `go:embed` 进二进制）：

```bash
cd ../webees@pocketbase
git checkout -- ui/src                              # 先恢复干净源码（替换是幂等的）
node <运行根>/pb-source-i18n-v2.mjs --write         # 应用词表（超 1290 处）
cd ui && npm run build && cd ..                     # 构建 UI（产物被 go:embed 打进二进制）

# arm64（源机 nanopc）
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o pocketbase-zh-linux-arm64 examples/base/main.go
cp pocketbase-zh-linux-arm64 ../webees@facedb/pb-bin/pocketbase-zh-linux-arm64

# amd64（目标机（x86_64 构建机））
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o pocketbase-zh-linux-amd64 examples/base/main.go
cp pocketbase-zh-linux-amd64 ../webees@facedb/pb-bin/pocketbase-zh-linux-amd64
```

## 重建后必须做的事

1. 重新计算 sha256/md5 与文件大小：

```bash
cd pb-bin
for f in pocketbase-zh-linux-arm64 pocketbase-zh-linux-amd64; do
  shasum -a 256 "$f"; md5 -q "$f"; stat -f '%z' "$f"
done
```

2. 若校验值变化，**必须同时更新两处**，否则构建会失败（这是预期的）：

   - `pb-bin/SHA256SUMS`（允许清单，两份都要登记）
   - `pb-bin/Dockerfile` 里对应架构的 `want_sha256` / `want_md5` / `want_size` 常量

   然后更新本文件表格。**注意：本文件不参与构建校验** —— 「构建失败」只由上面两处触发，
   本文件写错不会被拦住（本文件的指纹曾因此与实际二进制脱节）。
   建议每次重建后跑运行根的 `lib/check-pbbin-fingerprint.mjs` 做三方比对。
3. `docker compose build pocketbase`（或 `docker buildx build --platform …`）会执行白名单与分架构断言，
   任何未登记的二进制、或架构与 `TARGETARCH` 不符的二进制都会被拦下。

## `SHA256SUMS` 历史条目处置（E05-3）

`SHA256SUMS` 曾同时含两条 `pocketbase-zh` 记录，第二条 `188d7e7a4fca5c9ba0ebfc22b64f40ae3f97840761cc4cbfe200bad9377a4361`
是**上一版 arm64 二进制的历史指纹**（其 md5 为 `41d7bbf2a066a695f9a2b96676118a11`），文件本体早已被
`85a10d0b…` 那份覆盖，仓库内无任何文件与之相符。证据：

2026-10-07 重锚（R14-PBBIN-FP）：两份二进制被重建过一次（尺寸不变、内容变），
而清单/Dockerfile/README 三方常量当时未同步 —— 结果是 `docker compose build pocketbase` 必然
`REFUSED: sha256 … not in pb-bin/SHA256SUMS allowlist`（R19 席实测 exit=1）。
现按**实际部署中的**二进制重锚，被替换掉的旧指纹登记在此备查：

| 架构 | 旧 sha256 | 旧 md5 | 状态 |
| --- | --- | --- | --- |
| arm64 | `85a10d0baf5d42d631735304baaaefd79e8a118658daf64981ecda30ebea8ef0` | `115ca8dd9bcbdd667ecc617175c803ed` | 已被替换（仓库内无相符文件） |
| amd64 | `3786b4f5cbc35379129a35123dd5d2303744036d7fd9c0974d0d089ce3eb0490` | `ac39fb7771e03eb49a986f99a1789313` | 已被替换（仓库内无相符文件） |

重锚依据：生产镜像 `webees-facedb-pocketbase:0.28.1-zh` 创建于 2026-10-07T07:52:06Z（本地 14:52:06 +07，2026-10-07 实测 `docker image inspect` 读数；镜像创建时刻与二进制 mtime 03:47:09Z **不是同一时刻**），
容器内 `/usr/local/bin/pocketbase` 的 sha256 与新常量一致；两份二进制均为汉化版
（`集合` 各 122 处、`API 运行正常` 各 1 处），运行实例 `/api/health` 返回 `{"message":"API 运行正常。"}`。
`run-20261006-160618/evidence/R02-CT-13-b3b5-mutants-after.log:41`（旧值实测）、
`run-20261006-160618/evidence/W7-docs.log:111,136`（已记为 P3 残留 E05-3）。

本次改为按架构分文件后，该条目**已移除**：清单只保留与磁盘上两份文件实际相符的条目，
避免「未登记的二进制能过白名单」这类证明力被稀释的情况。历史值记录在此处，不再进白名单。

## 已知边界（如实记录）

- 白名单是**仓库内**的自证：清单与二进制同处一个仓库，能拦住「拿错二进制/被打包进来无关程序」，
  但不能抵抗「同时改二进制与清单」的提交；要抵抗后者需要仓库外的签名或公证（当前工程无此设施）。
- 本清单登记 arm64 与 amd64 两份构建，`PB_ALLOWED_ARCH="arm64 amd64"`。新增架构（如 arm/v7）需先产出二进制、
  登记其 sha256、在 `Dockerfile` 的 `case` 里补该架构的 `want_*` 常量，并把新架构名加进 `PB_ALLOWED_ARCH`。
- 两份二进制的 sha256 白名单是**合并**的（同一份 `SHA256SUMS`），架构绑定靠分架构 `want_sha256`/`want_md5`/`want_size`
  与 ELF `e_machine` 断言完成 —— 即「把 arm64 二进制塞进 amd64 构建」会被三重拦下。
