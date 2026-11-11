# @dsh-external/dsh-fetch-gzip

自动把出向 JSON 请求体压成 gzip，patch 进程级 `globalThis.fetch`。零配置可用，全部行为可配。

当前版本：**1.0.6**（对应 2026-11-11 审查报告 `review.md` 的第 1–8 项修复）。

## 装在哪

- 源目录：`~/.dsh/plugins/dsh-fetch-gzip`
- 各 profile 安装副本：`~/.dsh/profiles/<profile>/node_modules/@dsh-external/dsh-fetch-gzip`
- 改动后必须把 `lib/index.js`、`package.json`、`cordis.patch.yml` 同步到每个 profile，并重启对应进程。

```bash
SRC=~/.dsh/plugins/dsh-fetch-gzip
for p in acp desktop dsh-tui dsh-tui-safe headless po061 web; do
  DST=~/.dsh/profiles/$p/node_modules/@dsh-external/dsh-fetch-gzip
  [ -d "$DST" ] || continue
  cp "$SRC/lib/index.js"        "$DST/lib/index.js"
  cp "$SRC/package.json"        "$DST/package.json"
  cp "$SRC/cordis.patch.yml"    "$DST/cordis.patch.yml"
  rm -rf "$DST/test"; cp -R "$SRC/test" "$DST/test"
done
```

## 配置

`installFetchGzip(options)` / cordis 插件 `config` 均可传：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `minBytes` | `1024` | 小于这个不压 |
| `level` | `6` | gzip 级别 |
| `maxPreviewBytes` | `16 MiB` | 预读 Request body 的上限，超限原样透传 |
| `unsupportedTtlMs` | `1 h` | 判定「该接口不支持 gzip」后的冷却时间 |
| `verifiedTtlMs` | `10 min` | 「用 gzip 成功过」的能力缓存有效期 |
| `replayPolicy` | `refuse-only` | `off` / `refuse-only` / `json-errors` / `all` |
| `replayHosts` | `null` | 额外放行重发的域名后缀列表 |
| `replayEndpoints` | `null` | 额外放行重发的接口 key（origin + pathname） |
| `allowedHosts` | `null` | 只压这些域名后缀（null = 全部） |
| `maxConcurrency` | `2` | 并发压缩上限 |
| `saveIntervalMs` | `5000` | 统计落盘节流 |
| `lockStaleMs` | `10000` | 锁文件死锁判定 |
| `maxDiagKeys` | `200` | 诊断键上限 |
| `maxEndpoints` | `200` | 持久化能力条目上限 |

### 重发策略

补丁是进程级的，重发会造成**重复执行**（重复生成、重复计费、重复写入），所以默认只在服务端**明确拒绝请求体编码**时降级：

- `off`：从不重发。
- `refuse-only`（默认）：只有 **415** 重发。
- `json-errors` / `all`：400 / 411 / 413 / 415 / 422 可重发，但**必须**再用 `replayHosts` 或 `replayEndpoints` 圈定范围，否则不生效。
- **5xx 在任何策略下都不重发**：服务故障时重发等于重复执行，也无法据此判断 gzip 能力。

## 不压的情形

非 POST；有效 Content-Type 不含 json；body 不是 string / Uint8Array / ArrayBuffer / Buffer；流式 body（`init.body` 是 ReadableStream）；预读超过 `maxPreviewBytes`；请求体小于 `minBytes`；已带 `Content-Encoding`；该接口在 `unsupportedTtlMs` 内被判定不支持；`signal` 已取消；压缩后不比原文小。

## 统计

文件：`$DSH_HOME/dsh-fetch-gzip-stats.json`（默认 `~/.dsh/dsh-fetch-gzip-stats.json`）。

字段：`attempted`、`compressed`、`bytesIn`、`bytesOut`、`skipped`、`degraded`、`replay`、`replayBytes`、`failed`。
另含按接口汇总的 `endpoints`（能力结论，上限 `maxEndpoints`）、`skipReasons`（上限 `maxDiagKeys`，溢出折叠成 `droppedReasons`）。

handle API：`flush()` 返回 Promise（异步非阻塞）；`flushSync()` 只给退出兜底用。

## 测试

```bash
node test/regression.mjs   # 19 项行为回归，全部走本地 http server 真实收发
```

## 已知取舍

- 压缩在 Node 侧是 CPU 密集的：8 MiB 合成 base64 JSON、level 6 约 196–214 ms。已改成异步 zlib + 并发闸（默认 2），不再阻塞事件循环，但吞吐上限受 CPU 限制。大模型上下文请求若成为瓶颈，调低 `level`（1/3）或按 `allowedHosts` 缩小范围。
- `init.body` 为 ReadableStream 的请求完全不预读，保留原生传输语义（这类请求不会被压缩）。
