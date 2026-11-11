/**
 * @dsh-external/dsh-fetch-gzip  v1.0.6
 *
 * 自动把出向 JSON 请求体压成 gzip。零配置、全 harness 通用、失败自动降级。
 * patch 的是进程级 `globalThis.fetch`（Node 内置 fetch 入口拿到的是完整字符串 body，
 * 上游还持有 JSON 字符串时同步取到字节最省事；undici 拦截器里 body 是 ReadableStream，不好用）。
 *
 * ## v1.0.6 修了什么（对应 2026-11-11 的审查报告 review.md 第 1–8 项）
 *
 * 1. **[P1] 首次 5xx 自动重发所有 JSON POST。** 旧版对「没验证过」的接口，任何
 *    400/413/415/422/5xx 都直接明文重发一遍。服务端偶发 5xx 时这是**重复执行**
 *    （重复生成、重复计费、重复写入）。现在默认 `replayPolicy = 'refuse-only'`：
 *    只有 **415 Unsupported Media Type** 这种明确「不收这个请求体编码」的拒绝才降级；
 *    5xx / 400 / 413 / 422 一律原样返回给调用方。要放宽必须显式配置
 *    `replayPolicy: 'json-errors' | 'all'`，并可再用 `replayEndpoints` /
 *    `replayHosts` 把它限定到个别域名或接口。
 * 2. **[P1] 读流式 Request 没有体积上限、也不响应取消。** 旧版无条件
 *    `await input.clone().text()`，流不结束就一直等，AbortSignal 取消后仍然 pending，
 *    大请求整段缓冲进内存。现在：先判取消/方法/头部/端点，再做**带取消的限额预读**
 *    （`maxPreviewBytes`，默认 16 MiB，每次 read 都和 signal 竞争，取消立即抛
 *    AbortError 交给原生 fetch）；超限或读失败就**原样透传**（clone 不消耗原 Request）。
 *    `init.body` 是 ReadableStream 的请求完全不预读，保留原生传输语义。
 * 3. **[P2] 成功一次后永久信任。** `verified` 现在是有 TTL 的能力缓存
 *    （`verifiedTtlMs`，默认 10 分钟），明确的 gzip 拒绝（415）会立即让它失效；
 *    同一接口的并发探测合并成一次，避免并发重发风暴。
 * 4. **[P2] 拆 Request 改变 fetch 语义。** 旧版把 Request 拆成 (url, init) 只搬了
 *    method/headers/body/signal/redirect，credentials/cache/mode/referrer/
 *    referrerPolicy/integrity/keepalive 全被重置。现在**不再拆 Request**：
 *    直接 `origFetch(input, { ...init, body, headers })`，由 undici 自己做 Request
 *    克隆合并，所有选项与 Node 扩展选项（dispatcher 等）原样保留。
 *    `integrity` 校验的是**响应体**，与请求体编码无关，因此照常压缩，属性原样保留。
 * 5. **[P2] 同步压缩、同步写统计、锁等待阻塞主线程。** 现在 gzip 走异步 zlib 并带
 *    并发闸（`maxConcurrency`，默认 2）；统计落盘全异步，锁改成**单次尝试 + 稍后重试**，
 *    拿不到锁不再 `Atomics.wait` 空转（旧版实测阻塞主线程 131 ms）。
 *    只有进程退出兜底才同步落盘（`flushSync()`）。对外 `flush()` 返回 Promise，
 *    `flushSync()` 保留同步语义供 exit 钩子使用。
 * 6. **[P2] 旧 handle 卸载破坏新实例。** `uninstall()` 幂等，且只有**当前属主**
 *    （module 级 activeHandle）才能恢复 fetch、删全局 marker、清共享能力缓存、
 *    停定时器。非属主的旧 handle 卸载只做自我保护。
 * 7. **[P2] 重建 headers 丢重复值。** 现在统一走标准 `Headers` 复制，只对
 *    `content-encoding` / `content-length` 做 delete / set，其余（含重复头
 *    `x-tags: a` + `x-tags: b` → `a, b`）保持标准归一化语义。
 * 8. **[P3] Request + init.body 漏压。** 现在统一计算**有效** method / headers /
 *    body：`fetch(request, { body })` 会继承 Request 上的 content-type，
 *    init.headers 按名覆盖 Request 上的同名头。
 *
 * ## 额外可观测性
 * 统计新增 attempted / failed / replayBytes，并按接口汇总能力结论（上限 200 条，
 * 防止持久化文件无限增长）；诊断键也有上限。
 *
 * ## 不压的情形
 * 非 POST；有效 Content-Type 不含 json；body 不是 string / Uint8Array / ArrayBuffer /
 * Buffer；body < minBytes（默认 1 KiB）；该接口 TTL 内判定不支持；已带 Content-Encoding；
 * 流式 body（init 侧）；预读超限；signal 已取消；压缩后不比原文小。
 *
 * ## 任何异常都原样透传
 * 压缩抛错 ⇒ 直接发原请求。统计写盘失败一律静默、保留增量下次再写。
 */

import zlib from 'node:zlib'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const VERSION = '1.0.6'

/** 默认配置。全部可通过 installFetchGzip(options) / cordis config 覆盖。 */
export const DEFAULTS = Object.freeze({
  /** 小于这个不压。 */
  minBytes: 1024,
  /** gzip 级别。 */
  level: 6,
  /** 预读 Request body 的上限；超过则原样透传（不压缩）。 */
  maxPreviewBytes: 16 * 1024 * 1024,
  /** 判定「该接口不支持 gzip 请求体」后，多久再试一次。 */
  unsupportedTtlMs: 60 * 60 * 1000,
  /** 「用 gzip 成功过」的能力缓存有效期。 */
  verifiedTtlMs: 10 * 60 * 1000,
  /** 失败重发策略：off | refuse-only（默认，仅 415） | json-errors | all。 */
  replayPolicy: 'refuse-only',
  /** 额外允许重发的域名后缀（null = 不限制；仅对非 415 的策略生效）。 */
  replayHosts: null,
  /** 额外允许重发的接口 key 列表（origin + pathname）。 */
  replayEndpoints: null,
  /** 只压这些域名后缀（null = 全部）。 */
  allowedHosts: null,
  /** 并发压缩上限。 */
  maxConcurrency: 2,
  /** 统计落盘节流（毫秒）。 */
  saveIntervalMs: 5000,
  /** 锁文件超过这么久算死锁（持锁进程崩了），直接抢。 */
  lockStaleMs: 10 * 1000,
  /** 诊断键上限。 */
  maxDiagKeys: 200,
  /** 持久化的接口能力条目上限。 */
  maxEndpoints: 200,
})

/** 各策略下允许「先压后明文重发」的状态码；415 永远允许（明确拒绝编码）。 */
const REPLAY_STATUSES = {
  off: [],
  'refuse-only': [415],
  'json-errors': [400, 413, 415, 422],
  // all 只额外把闸门放开（不受 verified 拦截、不限域名），状态码范围仍限 4xx
  all: [400, 411, 413, 415, 422],
}

const STATE_VERSION = 2
const FIELDS = ['attempted', 'compressed', 'bytesIn', 'bytesOut', 'skipped', 'degraded', 'replay', 'replayBytes', 'failed']

const MODULE_TOKEN = Symbol('dsh-fetch-gzip')

// ---------------------------------------------------------------- 路径与状态

function dshHome() {
  const h = process.env.DSH_HOME
  return h && h.trim() ? h.trim() : join(homedir(), '.dsh')
}

let config = { ...DEFAULTS }
let STATE_FILE = join(dshHome(), 'dsh-fetch-gzip-stats.json')
let LOCK_FILE = STATE_FILE + '.lock'

/** 判定不支持 gzip 的接口：key → 到期时间。 */
const unsupported = new Map()
/** 用 gzip 成功过的接口：key → 到期时间。 */
const verified = new Map()
/** 正在探测的接口：key → Promise（合并并发探测）。 */
const probing = new Map()

/** 本进程实时统计（只增不减，自进程启动起）。 */
const stats = Object.fromEntries(FIELDS.map((k) => [k, 0]))

const emptyBucket = () => Object.fromEntries(FIELDS.map((k) => [k, 0]))

/** 还没写进文件的增量。按日期分桶，跨午夜也不会算错天。 */
let pending = { lifetime: emptyBucket(), days: {} }
/** 诊断：没压的原因 → 次数（只记类别和域名，不记内容）。 */
let pendingDiag = {}
let lastSave = 0
let saveTimer = null
let retryTimer = null
let saving = false
let activeHandle = null

function todayKey() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function diag(reason) {
  if (!reason) return
  const known = Object.prototype.hasOwnProperty.call(pendingDiag, reason)
  if (!known && Object.keys(pendingDiag).length >= config.maxDiagKeys) {
    pendingDiag.other = (pendingDiag.other || 0) + 1
    return
  }
  pendingDiag[reason] = (pendingDiag[reason] || 0) + 1
}

function hasPending() {
  return FIELDS.some((k) => pending.lifetime[k] !== 0) || Object.keys(pendingDiag).length > 0
}

function bump(field, inBytes = 0, outBytes = 0) {
  const tk = todayKey()
  const day = (pending.days[tk] ||= emptyBucket())
  for (const b of [pending.lifetime, day]) {
    b[field] += 1
    if (inBytes) b.bytesIn += inBytes
    if (outBytes) b.bytesOut += outBytes
  }
  if (Date.now() - lastSave >= config.saveIntervalMs) scheduleSave()
}

function sanitize(b) {
  const out = emptyBucket()
  for (const k of FIELDS) if (b && Number.isFinite(b[k])) out[k] = b[k]
  return out
}

function readStateSync() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!raw) return null
    // v1 与 v2 都接受：v1 没有 attempted/failed/replayBytes，sanitize 补 0。
    if (raw.version !== 1 && raw.version !== STATE_VERSION) return null
    return raw
  } catch {
    return null
  }
}

async function readState() {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf8'))
    if (!raw) return null
    if (raw.version !== 1 && raw.version !== STATE_VERSION) return null
    return raw
  } catch {
    return null
  }
}

/** 非阻塞取锁：只试一次，绝不在主线程上等待。 */
function tryAcquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(LOCK_FILE, 'wx'))
      return true
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return false
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > config.lockStaleMs) {
          unlinkSync(LOCK_FILE)
          continue
        }
      } catch {
        continue
      }
      return false
    }
  }
  return false
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE)
  } catch {
    /* ignore */
  }
}

function snapshotPending() {
  const days = {}
  for (const [k, v] of Object.entries(pending.days)) days[k] = { ...v }
  return { lifetime: { ...pending.lifetime }, days, diag: { ...pendingDiag } }
}

function commitSnapshot(snap) {
  for (const k of FIELDS) {
    pending.lifetime[k] -= snap.lifetime[k]
    if (pending.lifetime[k] < 0) pending.lifetime[k] = 0
  }
  for (const [d, b] of Object.entries(snap.days)) {
    const cur = pending.days[d]
    if (!cur) continue
    for (const k of FIELDS) cur[k] -= b[k]
    if (FIELDS.every((k) => cur[k] === 0)) delete pending.days[d]
  }
  for (const [k, v] of Object.entries(snap.diag)) {
    pendingDiag[k] = (pendingDiag[k] || 0) - v
    if (pendingDiag[k] <= 0) delete pendingDiag[k]
  }
}

function buildPayload(cur, snap, extra) {
  const base = cur || {}
  const lifetime = sanitize(base.lifetime)
  const tk = todayKey()
  const day = base.day && base.day.date === tk ? sanitize(base.day) : emptyBucket()
  for (const k of FIELDS) lifetime[k] += snap.lifetime[k]
  const todayDelta = snap.days[tk]
  if (todayDelta) for (const k of FIELDS) day[k] += todayDelta[k]
  let skipReasons = base.skipReasons && typeof base.skipReasons === 'object' ? { ...base.skipReasons } : {}
  for (const [k, v] of Object.entries(snap.diag)) skipReasons[k] = (Number(skipReasons[k]) || 0) + v
  const keys = Object.keys(skipReasons)
  if (keys.length > config.maxDiagKeys) {
    // 只留最高频的 maxDiagKeys 条，其余折叠成 dropped 计数，文件不会无限膨胀
    const sorted = keys.sort((a, b) => skipReasons[b] - skipReasons[a]).slice(0, config.maxDiagKeys)
    const kept = {}
    let dropped = 0
    for (const k of sorted) kept[k] = skipReasons[k]
    for (const k of keys) if (!(k in kept)) dropped += skipReasons[k]
    skipReasons = kept
    if (dropped) skipReasons.droppedReasons = dropped
  }
  return {
    version: STATE_VERSION,
    plugin: VERSION,
    updatedAt: new Date().toISOString(),
    minBytes: config.minBytes,
    level: config.level,
    replayPolicy: config.replayPolicy,
    lifetime,
    day: { date: tk, ...day },
    skipReasons,
    ...(extra || {}),
  }
}

function endpointSnapshot() {
  const now = Date.now()
  const entries = []
  for (const [key, until] of unsupported) if (until > now) entries.push({ key, state: 'unsupported', until: new Date(until).toISOString() })
  for (const [key, until] of verified) if (until > now) entries.push({ key, state: 'verified', until: new Date(until).toISOString() })
  if (entries.length > config.maxEndpoints) entries.length = config.maxEndpoints
  return entries
}

/**
 * 把本进程的增量合并进统计文件（异步、非阻塞）。失败就保留增量，稍后重试。
 *
 * 并发语义：同一进程内落盘是**串行**的 —— 已有落盘在跑时，后来的调用
 * 不立刻返回 false（那会让调用方误以为增量丢了），而是排队等当前这轮结束后
 * 再跑一轮（合并写，拿到最终结果）。锁竞争仍然只试一次、绝不阻塞。
 */
let saveChain = Promise.resolve()

function savePersisted() {
  const run = async () => {
    lastSave = Date.now()
    if (!hasPending()) return true
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true })
    } catch {
      return false
    }
    if (!tryAcquireLock()) {
      scheduleRetry()
      return false
    }
    saving = true
    const tmp = `${STATE_FILE}.${process.pid}.tmp`
    const snap = snapshotPending()
    try {
      const cur = await readState()
      const payload = buildPayload(cur, snap, {
        endpoints: endpointSnapshot(),
      })
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, STATE_FILE)
      commitSnapshot(snap)
      return true
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* ignore */
      }
      return false
    } finally {
      saving = false
      releaseLock()
    }
  }
  const next = saveChain.then(run, run)
  // 链尾只保留结果，不允许 reject 泄漏成 unhandled
  saveChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** 进程退出兜底：同步落盘，只试一次锁，绝不空转。 */
function flushSync() {
  if (!hasPending()) return true
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
  } catch {
    return false
  }
  if (!tryAcquireLock()) return false
  const tmp = `${STATE_FILE}.${process.pid}.exit.tmp`
  const snap = snapshotPending()
  try {
    const payload = buildPayload(readStateSync(), snap, { endpoints: endpointSnapshot() })
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, STATE_FILE)
    commitSnapshot(snap)
    return true
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    return false
  } finally {
    releaseLock()
  }
}

function scheduleSave() {
  if (saving) return
  if (retryTimer) return
  const p = savePersisted().catch(() => false)
  void p
}

function scheduleRetry() {
  if (retryTimer) return
  try {
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (hasPending()) scheduleSave()
    }, 400)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  } catch {
    retryTimer = null
  }
}

function ensureSaveTimer() {
  if (saveTimer) return
  try {
    saveTimer = setInterval(() => {
      if (hasPending()) scheduleSave()
    }, config.saveIntervalMs)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
    process.once('exit', onExit)
  } catch {
    saveTimer = null
  }
}

function onExit() {
  try {
    flushSync()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- headers

/** 把 Headers / 字节数组 / 扁平数组 / 普通对象统一成 [k, v] 列表。 */
function entriesOf(headers) {
  if (!headers) return []
  if (Array.isArray(headers)) {
    if (headers.length && headers.every((p) => Array.isArray(p))) {
      return headers.map(([k, v]) => [String(k), String(v ?? '')])
    }
    const out = []
    for (let i = 0; i + 1 < headers.length; i += 2) out.push([String(headers[i]), String(headers[i + 1] ?? '')])
    return out
  }
  if (typeof headers.entries === 'function') {
    const out = []
    for (const [k, v] of headers.entries()) out.push([String(k), String(v ?? '')])
    return out
  }
  return Object.entries(headers).map(([k, v]) => [String(k), String(v ?? '')])
}

/**
 * 合并 headers：base 打底，override 按名覆盖（同名多值保留 override 的多个值）。
 * 走标准 Headers，重复头按规范归一成 `a, b`，不再像旧版那样只留最后一个。
 */
function mergeHeaders(base, override) {
  const out = new Headers()
  const appendAll = (list) => {
    for (const [k, v] of list) {
      try {
        out.append(k, v)
      } catch {
        /* 非法头名/值：忽略该条，不影响请求 */
      }
    }
  }
  appendAll(entriesOf(base))
  if (override !== undefined && override !== null) {
    const list = entriesOf(override)
    for (const name of new Set(list.map(([k]) => k.toLowerCase()))) {
      try {
        out.delete(name)
      } catch {
        /* ignore */
      }
    }
    appendAll(list)
  }
  return out
}

function headerOf(headers, name) {
  try {
    if (headers && typeof headers.get === 'function') return String(headers.get(name) ?? '')
  } catch {
    /* ignore */
  }
  const want = name.toLowerCase()
  for (const [k, v] of entriesOf(headers)) if (k.toLowerCase() === want) return v
  return ''
}

const contentTypeOf = (h) => headerOf(h, 'content-type')
const contentEncodingOf = (h) => headerOf(h, 'content-encoding')

/** 输出摘要用：掩掉 query，避免把敏感查询串写进统计。 */
function endpointKeyOf(url) {
  try {
    const u = new URL(String(url))
    return u.origin + u.pathname
  } catch {
    return ''
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).host
  } catch {
    return ''
  }
}

function hostMatches(host, list) {
  if (!list || !list.length) return false
  return list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

// ---------------------------------------------------------------- 能力缓存

function markUnsupported(key) {
  if (!key) return
  verified.delete(key)
  unsupported.set(key, Date.now() + config.unsupportedTtlMs)
  if (unsupported.size > config.maxEndpoints) {
    const now = Date.now()
    for (const [k, until] of unsupported) if (until <= now) unsupported.delete(k)
    while (unsupported.size > config.maxEndpoints) {
      const oldest = unsupported.keys().next().value
      unsupported.delete(oldest)
    }
  }
}

function markVerified(key) {
  if (!key) return
  unsupported.delete(key)
  verified.set(key, Date.now() + config.verifiedTtlMs)
}

function isUnsupported(key) {
  const until = unsupported.get(key)
  if (until === undefined) return false
  if (Date.now() > until) {
    unsupported.delete(key)
    return false
  }
  return true
}

function isVerified(key) {
  const until = verified.get(key)
  if (until === undefined) return false
  if (Date.now() > until) {
    verified.delete(key)
    return false
  }
  return true
}

// ---------------------------------------------------------------- 压缩

let activeCompressions = 0
const compressionQueue = []

function acquireSlot() {
  return new Promise((resolve) => {
    const grant = () => {
      activeCompressions++
      resolve(() => {
        if (activeCompressions > 0) activeCompressions--
        const next = compressionQueue.shift()
        if (next) next()
      })
    }
    if (activeCompressions < config.maxConcurrency) grant()
    else compressionQueue.push(grant)
  })
}

async function gzipAsync(buf) {
  const release = await acquireSlot()
  try {
    return await new Promise((resolve, reject) => {
      zlib.gzip(buf, { level: config.level }, (err, out) => (err ? reject(err) : resolve(out)))
    })
  } finally {
    release()
  }
}

function abortError(signal) {
  const reason = signal && signal.reason
  if (reason instanceof Error) return reason
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

/**
 * 只在 signal 未取消时读一块；取消立即 reject。
 *
 * 注意：**不要 cancel 这个 reader**。clone() 与原 Request 共享底层 tee，
 * cancel 会连带作废原 Request 的 body，导致后续透传原生 fetch 抛 TypeError。
 * 放弃读取只是丢掉已读的那一支缓冲，原 Request 仍然可用。
 */
function readWithAbort(reader, signal) {
  if (!signal) return reader.read()
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {
        /* ignore */
      }
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError(signal))
    }
    try {
      signal.addEventListener('abort', onAbort, { once: true })
    } catch {
      /* ignore */
    }
    reader.read().then(
      (v) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      },
    )
  })
}

const PREVIEW_TOO_LARGE = Symbol('preview-too-large')

/** 带取消 + 体积上限的 body 预读。超限抛 PREVIEW_TOO_LARGE。 */
async function readCapped(stream, cap, signal) {
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal)
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > cap) throw PREVIEW_TOO_LARGE
      chunks.push(Buffer.from(value))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  return total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total)
}

const isByteBody = (b) =>
  b instanceof Uint8Array ||
  (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) ||
  (typeof Buffer !== 'undefined' && Buffer.isBuffer(b))

function toBuffer(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return Buffer.from(body)
  return null
}

// ---------------------------------------------------------------- 请求分析

/**
 * 统一计算「有效」请求属性，覆盖 fetch(request) / fetch(url, init) /
 * fetch(request, { body }) / fetch(request, { headers }) 各种组合。
 */
function effectiveRequest(input, init) {
  const isRequest = typeof Request === 'function' && input instanceof Request
  const base = isRequest ? input : null
  let rawUrl = ''
  try {
    if (base) rawUrl = base.url
    else if (input instanceof URL) rawUrl = input.href
    else if (typeof input === 'string') rawUrl = input
  } catch {
    rawUrl = ''
  }
  const method = String((init && init.method) || (base && base.method) || 'GET').toUpperCase()
  const headers = mergeHeaders(base ? base.headers : null, init && init.headers)
  const initHasBody = !!(init && init.body !== undefined && init.body !== null)
  const signal = (init && init.signal) || (base && base.signal) || null
  const integrity = (init && init.integrity) || (base && base.integrity) || ''
  return { isRequest, base, rawUrl, method, headers, initHasBody, signal, integrity }
}

function skip(why) {
  return { type: 'skip', why }
}

/** 判断并压缩。返回 { type:'skip', why } 或 { type:'compress', ... }。 */
async function planCompression(input, init) {
  const req = effectiveRequest(input, init)
  const host = hostOf(req.rawUrl)

  if (req.method !== 'POST') return skip(`method:${req.method}@${host}`)
  if (!contentTypeOf(req.headers).match(/json/i)) {
    return skip(`ctype:${(contentTypeOf(req.headers).split(';')[0] || 'none')}@${host}`)
  }
  if (contentEncodingOf(req.headers)) return skip(`encoded@${host}`)
  if (req.signal && req.signal.aborted) return skip(`aborted@${host}`)
  if (config.allowedHosts && !hostMatches(host, config.allowedHosts)) return skip(`host-not-allowed@${host}`)

  const key = endpointKeyOf(req.rawUrl)
  if (!key) return skip(`nokey@${host}`)
  if (isUnsupported(key)) return skip(`unsupported@${host}`)

  // ---- 取 body 字节：优先调用方直接给的 string / 字节；否则对 Request 做限额预读
  let buf = null
  if (req.initHasBody) {
    const raw = init.body
    if (!(typeof raw === 'string' || isByteBody(raw))) {
      const tag = raw && raw.constructor ? raw.constructor.name : typeof raw
      return skip(`body:${tag}@${host}`)
    }
    buf = toBuffer(raw)
    if (!buf) return skip(`body:unsupported@${host}`)
  } else if (req.base && req.base.body) {
    if (req.base.bodyUsed) return skip(`body:used@${host}`)
    let clone = null
    try {
      clone = req.base.clone()
    } catch {
      return skip(`body:uncloneable@${host}`)
    }
    try {
      buf = await readCapped(clone.body, config.maxPreviewBytes, req.signal)
    } catch (e) {
      if (e === PREVIEW_TOO_LARGE) return skip(`large>${config.maxPreviewBytes}@${host}`)
      if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return skip(`aborted@${host}`)
      return skip(`body:unreadable@${host}`)
    }
  } else {
    return skip(`body:none@${host}`)
  }

  if (buf.length < config.minBytes) return skip(`small@${host}`)

  // 复检：预读期间可能已被取消
  if (req.signal && req.signal.aborted) return skip(`aborted@${host}`)

  let gz
  try {
    gz = await gzipAsync(buf)
  } catch {
    return skip(`gzip-error@${host}`)
  }
  if (!gz || gz.length >= buf.length) return skip(`no-gain@${host}`)

  const gzHeaders = new Headers(req.headers)
  try {
    gzHeaders.delete('content-length')
  } catch {
    /* ignore */
  }
  gzHeaders.set('content-encoding', 'gzip')
  try {
    gzHeaders.set('content-length', String(gz.length))
  } catch {
    /* 某些实现禁止设置：交给 undici 自己算 */
  }

  const plainHeaders = new Headers(req.headers)
  try {
    plainHeaders.delete('content-length')
    plainHeaders.delete('content-encoding')
  } catch {
    /* ignore */
  }

  return {
    type: 'compress',
    key,
    host,
    input,
    init,
    isRequest: req.isRequest,
    base: req.base,
    inBytes: buf.length,
    plainBody: req.initHasBody ? init.body : buf,
    gz,
    gzHeaders,
    plainHeaders,
  }
}

/**
 * 用原生 fetch 发，只覆盖 body 与 headers。
 *
 * 关键：init.body 存在时 undici 会重新构造 Request，`referrer` 与 `referrerPolicy`
 * 会退回默认值（实测 referrer → about:client、referrerPolicy → ""），
 * 其余 credentials / cache / mode / integrity / keepalive / redirect 会被保留。
 * 所以这里显式把这两个补回去（init 显式给了就以 init 为准）。
 */
function sendWith(origFetch, plan, body, headers) {
  const init = plan.init || {}
  const out = { ...init, body, headers }
  if (plan.base) {
    if (init.referrer === undefined) out.referrer = plan.base.referrer
    if (init.referrerPolicy === undefined) out.referrerPolicy = plan.base.referrerPolicy
  }
  return origFetch(plan.input, out)
}

async function discard(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') await res.body.cancel()
  } catch {
    /* ignore */
  }
}

/** 压缩请求失败后要不要明文重发。 */
function shouldReplay(status, key) {
  const policy = config.replayPolicy
  if (policy === 'off') return false
  const explicitRefusal = status === 415 // 明确「不收这个请求体编码」
  if (explicitRefusal) return true
  // 只接受「明确拒绝请求体编码」这一族 4xx。5xx 是服务端故障，重发会重复执行，
  // 任何策略下都不重发（审查报告第 1 项的核心结论）。
  const statuses = REPLAY_STATUSES[policy] || []
  if (!statuses.includes(status)) return false
  // 用 gzip 成功过的接口，偶发错误跟 gzip 无关 —— 原样返回，不重发
  if (isVerified(key)) return false
  const replays = config.replayEndpoints
  if (replays && replays.length) {
    if (!replays.includes(key)) return false
    return true
  }
  const hosts = config.replayHosts
  if (hosts && hosts.length) return hostMatches(hostOf(key), hosts)
  // 放宽后的策略只对显式配置过的域名/接口生效，避免全局重发
  return false
}

// ---------------------------------------------------------------- 安装

export function installFetchGzip(options) {
  if (activeHandle && activeHandle.fetch === globalThis.fetch) return activeHandle
  const existing = globalThis.__dshFetchGzip
  if (existing && typeof existing.uninstall === 'function' && existing.owner === MODULE_TOKEN) return existing

  config = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) }
  STATE_FILE = join(dshHome(), 'dsh-fetch-gzip-stats.json')
  LOCK_FILE = STATE_FILE + '.lock'

  ensureSaveTimer()
  const origFetch = globalThis.fetch

  const wrapper = async function fetchWithGzip(input, init) {
    let plan = null
    try {
      plan = await planCompression(input, init)
    } catch {
      plan = null
    }

    if (!plan || plan.type !== 'compress') {
      const why = (plan && plan.why) || 'error'
      stats.skipped++
      diag(why)
      bump('skipped')
      // 保持原生调用形态：init 没给就不补第二参，避免改变 fetch 的参数语义
      return init === undefined ? origFetch(input) : origFetch(input, init)
    }

    stats.attempted++
    bump('attempted')

    let res
    try {
      res = await sendWith(origFetch, plan, plan.gz, plan.gzHeaders)
    } catch (e) {
      stats.failed++
      bump('failed')
      throw e
    }

    if (res && res.ok) {
      markVerified(plan.key)
      stats.compressed++
      stats.bytesIn += plan.inBytes
      stats.bytesOut += plan.gz.length
      bump('compressed', plan.inBytes, plan.gz.length)
      return res
    }

    const status = res ? res.status : 0
    stats.failed++
    bump('failed')
    if (status === 415) verified.delete(plan.key) // 能力变了：作废缓存

    if (!shouldReplay(status, plan.key)) return res

    const plainSend = () => sendWith(origFetch, plan, plan.plainBody, plan.plainHeaders)

    // 同一接口已有探测在跑：等它出结论，别并发重发
    if (probing.has(plan.key)) {
      try {
        await probing.get(plan.key)
      } catch {
        /* ignore */
      }
      if (isUnsupported(plan.key)) {
        stats.replay++
        stats.replayBytes += plan.inBytes
        bump('replay', 0, 0)
        return plainSend()
      }
      return res
    }

    let resolveProbe
    const gate = new Promise((resolve) => {
      resolveProbe = resolve
    })
    probing.set(plan.key, gate)
    try {
      await discard(res)
      stats.replay++
      stats.replayBytes += plan.inBytes
      bump('replay', 0, 0)
      const plain = await plainSend()
      if (plain && plain.ok) {
        // 明文行、gzip 不行 ⇒ 这个接口不支持 gzip 请求体
        markUnsupported(plan.key)
        stats.degraded++
        bump('degraded')
      } else {
        // 明文也失败 ⇒ 不是 gzip 的锅，不做能力结论
        diag(`replay-failed:${plain ? plain.status : 'throw'}@${plan.host}`)
      }
      return plain
    } finally {
      probing.delete(plan.key)
      resolveProbe()
    }
  }

  globalThis.fetch = wrapper

  const handle = {
    owner: MODULE_TOKEN,
    version: VERSION,
    stats,
    stateFile: STATE_FILE,
    get config() {
      return { ...config }
    },
    unsupported,
    verified,
    capabilities() {
      return endpointSnapshot()
    },
    /** 异步落盘，返回是否写成功；绝不阻塞事件循环。 */
    flush() {
      return savePersisted()
    },
    /** 同步落盘，只给进程退出兜底用。 */
    flushSync,
    fetch: wrapper,
    retired: false,
    uninstall() {
      if (handle.retired) return
      handle.retired = true
      if (activeHandle !== handle) {
        // 非属主：只做自我保护，不碰全局 marker / 共享缓存 / 定时器
        if (globalThis.fetch === handle.fetch) globalThis.fetch = origFetch
        return
      }
      void savePersisted()
      if (globalThis.fetch === wrapper) globalThis.fetch = origFetch
      if (globalThis.__dshFetchGzip === handle) delete globalThis.__dshFetchGzip
      unsupported.clear()
      verified.clear()
      probing.clear()
      if (saveTimer) {
        clearInterval(saveTimer)
        saveTimer = null
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      try {
        process.removeListener('exit', onExit)
      } catch {
        /* ignore */
      }
      activeHandle = null
    },
  }

  activeHandle = handle
  globalThis.__dshFetchGzip = handle
  return handle
}

export const name = '@dsh-external/dsh-fetch-gzip'

/** 不需要 inject：只 patch 进程级全局对象。 */
export function apply(ctx, options) {
  const handle = installFetchGzip(options)
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => () => handle.uninstall())
  try {
    console.log(`[dsh-fetch-gzip] v${VERSION} 已启用（统计：${handle.stateFile}，重发策略：${config.replayPolicy}）`)
  } catch {
    /* ignore */
  }
}
