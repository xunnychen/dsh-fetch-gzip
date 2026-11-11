#!/usr/bin/env node
/**
 * dsh-fetch-gzip 1.0.6 回归测试。
 *
 * 与 2026-11-11 审查报告里的 review-checks.mjs 相反：那个脚本断言的是
 * **旧版缺陷行为**（用于复现），本脚本断言的是**修复后的正确行为**。
 *
 * 全部走本地 http.Server 真实收发（不走 mock fetch），因此能验证
 * content-length / content-encoding 在网络上真实的形态。
 *
 * 用法：node test/regression.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'lib', 'index.js')

const results = []
let seq = 0

/**
 * 起一个隔离实例。
 * `under` 会在安装插件**之前**铺到 globalThis.fetch，因此插件拿到的 origFetch
 * 就是它 —— 这样 globalThis.fetch 仍然是插件 wrapper，探针在插件之下，分层正确。
 */
async function fresh(options, under) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-gzip-reg-'))
  const mod = await import(`file://${source}?reg=${++seq}`)
  const native = globalThis.fetch
  if (under) globalThis.fetch = under
  const handle = mod.installFetchGzip(options)
  return {
    mod,
    handle,
    native,
    wrapper: globalThis.fetch,
    restore() {
      handle.uninstall()
      globalThis.fetch = native
      delete globalThis.__dshFetchGzip
    },
  }
}

/**
 * 只做隔离环境与异常收口，**不预装插件**。
 * 预装会让后续 fresh() 把新实例叠在旧 wrapper 之上（双层压缩），必须由用例自己管。
 */
async function test(name, fn) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-gzip-reg-'))
  try {
    const detail = await fn()
    results.push({ name, status: 'pass', detail: detail || null })
  } catch (e) {
    results.push({ name, status: 'FAIL', error: String(e && e.message), stack: e && e.stack })
  }
}

/** 起一个本地服务，记录每次请求的 body 头与原始字节。 */
async function withServer(handler, fn) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      handler(req, res, { raw, body: body.toString('utf8'), headers: req.headers })
    })
    req.on('error', () => {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

const jsonOf = (n) => JSON.stringify({ messages: [{ role: 'user', content: '测试上下文 abc '.repeat(n) }] })

// ------------------------------------------------------------------ 1. 重发策略

await test('1a. 首次 5xx 不重发（refuse-only 默认）', async () => {
  return withServer(
    (req, res) => res.writeHead(500).end('boom'),
    async (base) => {
      const seen = []
      const nativeFetch = globalThis.fetch
      const ctx = await fresh(undefined, async (input, init) => {
        const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : null))
        seen.push(h.get('content-encoding') || 'plain')
        return nativeFetch(input, init)
      })
      try {
        const res = await ctx.wrapper(`${base}/create`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        assert.equal(res.status, 500)
        assert.deepEqual(seen, ['gzip'], '5xx 只应发送一次（gzip），不得明文重发')
        return { sends: seen }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('1b. 415 明确拒绝 → 降级明文并把接口标记 unsupported', async () => {
  return withServer(
    (req, res, info) => {
      if (info.headers['content-encoding'] === 'gzip') res.writeHead(415).end('no gzip body')
      else res.writeHead(200).end('ok')
    },
    async (base) => {
      const sends = []
      const nativeFetch = globalThis.fetch
      // 探针铺在插件**之下**（作为插件的 origFetch），才能看到插件真正发出去的编码
      const ctx = await fresh(undefined, async (input, init) => {
        const h = new Headers((init && init.headers) || null)
        sends.push(h.get('content-encoding') || 'plain')
        return nativeFetch(input, init)
      })
      try {
        const res = await ctx.wrapper(`${base}/s415`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        assert.equal(res.status, 200, '415 后应明文重发并拿到 200')
        assert.deepEqual(sends, ['gzip', 'plain'], '415 必须先 gzip 再降级明文，顺序不能变')
        assert.equal(ctx.handle.unsupported.size, 1, '明文成功后应把该接口标为 unsupported')
        assert.equal(ctx.handle.stats.replay, 1)
        assert.equal(ctx.handle.stats.degraded, 1)
        const key = [...ctx.handle.unsupported.keys()][0]
        assert.ok(key.endsWith('/s415'), `unsupported key 应是该接口，实际 ${key}`)
        return { sends, status: res.status, unsupported: key, replay: ctx.handle.stats.replay }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('1c. 5xx 不能纳入重发（只有 4xx 编码拒绝类才降级）', async () => {
  return withServer(
    (req, res) => res.writeHead(503).end('down'),
    async (base) => {
      const sends = []
      const nativeFetch = globalThis.fetch
      const ctx = await fresh(
        { replayPolicy: 'all', replayHosts: [new URL(base).host] },
        async (input, init) => {
          const h = new Headers((init && init.headers) || null)
          sends.push(h.get('content-encoding') || 'plain')
          return nativeFetch(input, init)
        },
      )
      try {
        const res = await ctx.wrapper(`${base}/down`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        assert.equal(res.status, 503)
        assert.deepEqual(sends, ['gzip'], '5xx 属服务故障，重发会造成重复执行，必须不重发')
        return { sends }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('1d. 400/422 在显式放行域名后才重发', async () => {
  return withServer(
    (req, res) => res.writeHead(400).end('bad'),
    async (base) => {
      const sends = []
      const nativeFetch = globalThis.fetch
      const ctx = await fresh({ replayPolicy: 'json-errors', replayHosts: [new URL(base).host] }, async (input, init) => {
        const h = new Headers((init && init.headers) || null)
        sends.push(h.get('content-encoding') || 'plain')
        return nativeFetch(input, init)
      })
      try {
        await ctx.wrapper(`${base}/bad`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        assert.deepEqual(sends, ['gzip', 'plain'], '显式放行后应重发一次')
        return { sends }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 2. 流式 body

await test('2a. 流式 body 取消后立刻结束，不拖住调用方', async () => {
  return withServer(
    (req, res) => res.writeHead(200).end('ok'),
    async (base) => {
      const ctx = await fresh()
      try {
        let nativeCalls = 0
        const origNative = ctx.native
        ctx.handle // 插件已装
        // 统计插件到底有没有把请求交给原生 fetch（= 预读阶段结束）
        const realFetch = globalThis.fetch
        globalThis.fetch = async (input, init) => {
          nativeCalls++
          return realFetch(input, init)
        }
        // 上面这层在插件之上，测不到；改从 handle.stats 侧观察预读发生
        globalThis.fetch = realFetch

        const abort = new AbortController()
        let controller
        const stream = new ReadableStream({
          start(c) {
            controller = c
            c.enqueue(new TextEncoder().encode(jsonOf(200)))
            // 故意不 close：模拟长流
          },
        })
        const req = new Request(`${base}/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stream,
          duplex: 'half',
          signal: abort.signal,
        })
        const pending = ctx.wrapper(req).then(
          () => 'resolved',
          (e) => e.name,
        )
        await new Promise((r) => setTimeout(r, 30))
        // 取消前必须已经进入预读：流已被读走一块，且请求还没交给原生 fetch
        assert.equal(ctx.handle.stats.attempted, 0, '取消前不应已经发出压缩请求')
        abort.abort()
        const state = await Promise.race([pending, new Promise((r) => setTimeout(() => r('pending'), 300))])
        try {
          controller.close()
        } catch {}
        assert.equal(state, 'AbortError', '取消后应立刻以 AbortError 结束，而不是一直 pending')
        assert.ok(ctx.handle.stats.skipped >= 1, '取消应记入 skipped')
        return { state, skipped: ctx.handle.stats.skipped, native: typeof origNative }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('2b. Request body 超过 maxPreviewBytes 时原样透传（不压缩）', async () => {
  return withServer(
    (req, res, info) => res.writeHead(200).end(JSON.stringify({ ce: info.headers['content-encoding'] || null, len: info.body.length })),
    async (base) => {
      const ctx = await fresh({ maxPreviewBytes: 1024 })
      try {
        const body = jsonOf(2000)
        const req = new Request(`${base}/big`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        const res = await ctx.wrapper(req)
        const info = await res.json()
        assert.equal(info.ce, null, '超过预读上限应保留原生传输（无 content-encoding）')
        assert.equal(info.len, body.length, '透传后服务端收到的 body 必须完整')
        assert.ok(ctx.handle.stats.skipped >= 1)
        return { ce: info.ce, skipped: ctx.handle.stats.skipped, len: info.len }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('2c. init.body 是 ReadableStream 时不预读、不压缩', async () => {
  return withServer(
    (req, res, info) =>
      res.writeHead(200).end(JSON.stringify({ ce: info.headers['content-encoding'] || null, len: info.body.length })),
    async (base) => {
      const ctx = await fresh()
      try {
        let consumed = 0
        const payload = jsonOf(200)
        const stream = new ReadableStream({
          pull(c) {
            if (consumed === 0) {
              consumed += payload.length
              c.enqueue(new TextEncoder().encode(payload))
            } else {
              c.close()
            }
          },
        })
        const res = await ctx.wrapper(`${base}/s`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stream,
          duplex: 'half',
        })
        const info = await res.json()
        assert.equal(info.ce, null, '流式 init.body 必须保留原生传输语义')
        assert.equal(info.len, payload.length, '请求体应完整送达')
        // 经过插件：被记为 skipped（body:ReadableStream），且没有压缩尝试
        assert.ok(ctx.handle.stats.skipped >= 1, '应经过插件并记为 skipped')
        assert.equal(ctx.handle.stats.attempted, 0, '不得进入压缩')
        const reasons = Object.keys(JSON.parse(readFileSync(ctx.handle.stateFile || '', 'utf8') || '{}')).length
        void reasons
        return { ce: info.ce, len: info.len, skipped: ctx.handle.stats.skipped, attempted: ctx.handle.stats.attempted }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 3. 能力缓存 TTL

await test('3a. verified 有 TTL，过期后重新探测', async () => {
  return withServer(
    (req, res, info) => res.writeHead(info.headers['content-encoding'] === 'gzip' ? 200 : 415).end(''),
    async (base) => {
      const mod = await import(`file://${source}?reg=${++seq}`)
      const native = globalThis.fetch
      const handle = mod.installFetchGzip({ verifiedTtlMs: 60, unsupportedTtlMs: 60 })
      try {
        const opts = () => ({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        await handle.fetch(`${base}/ttl`, opts())
        assert.equal(handle.verified.size + handle.unsupported.size, 1)
        await new Promise((r) => setTimeout(r, 120))
        handle.capabilities() // 触发一次读取
        const before = handle.verified.size + handle.unsupported.size
        await handle.fetch(`${base}/ttl`, opts())
        const after = handle.verified.size + handle.unsupported.size
        assert.ok(after >= 1, 'TTL 过期后应重新探测并重新记录能力')
        return { before, after }
      } finally {
        globalThis.fetch = native
        handle.uninstall()
        delete globalThis.__dshFetchGzip
      }
    },
  )
})

await test('3b. 已 verified 的接口后来回 415 → 作废缓存并降级', async () => {
  let flip = false
  const sends = []
  const nativeFetch = globalThis.fetch
  return withServer(
    (req, res, info) => {
      const ce = info.headers['content-encoding'] || 'plain'
      sends.push(ce)
      if (flip && ce === 'gzip') res.writeHead(415).end('')
      else res.writeHead(200).end('ok')
    },
    async (base) => {
      const ctx = await fresh()
      try {
        const opts = () => ({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        await ctx.wrapper(`${base}/flip`, opts())
        assert.equal(ctx.handle.verified.size, 1, '第一次应 verified')
        flip = true
        const second = await ctx.wrapper(`${base}/flip`, opts())
        assert.equal(second.status, 200, 'verified 接口遇 415 应降级明文，而不是把 415 直接抛给调用方')
        assert.deepEqual(sends, ['gzip', 'gzip', 'plain'])
        assert.equal(ctx.handle.verified.size, 0, '415 应作废 verified 缓存')
        assert.equal(ctx.handle.unsupported.size, 1, '明文成功 ⇒ 标记该接口不支持 gzip')
        return { sends, secondStatus: second.status }
      } finally {
        ctx.restore()
        globalThis.fetch = nativeFetch
      }
    },
  )
})

// ------------------------------------------------------------------ 4. fetch 语义

await test('4a. Request 上的 credentials/cache/mode/referrer/integrity/keepalive 全部保留', async () => {
  return withServer(
    (req, res) => res.writeHead(200).end('ok'),
    async (base) => {
      let seen = null
      const nativeFetch = globalThis.fetch
      const ctx = await fresh(undefined, async (input, init) => {
        seen = new Request(input instanceof Request ? input.clone() : input, init)
        return nativeFetch(input, init)
      })
      try {
        const req = new Request(`${base}/opts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
          credentials: 'omit',
          cache: 'no-store',
          mode: 'same-origin',
          referrer: 'https://client.invalid/source',
          referrerPolicy: 'no-referrer',
          keepalive: true,
        })
        const before = {
          cache: req.cache,
          credentials: req.credentials,
          mode: req.mode,
          referrer: req.referrer,
          referrerPolicy: req.referrerPolicy,
          keepalive: req.keepalive,
        }
        await ctx.wrapper(req)
        for (const key of ['credentials', 'cache', 'mode', 'referrer', 'referrerPolicy', 'keepalive']) {
          assert.equal(seen[key], before[key], `${key} 必须与原 Request 一致`)
        }
        assert.equal(seen.headers.get('content-encoding'), 'gzip', '压缩应真的发生')
        return before
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('4b. 带 integrity 的请求照常压缩，且 integrity 保留（校验的是响应体）', async () => {
  const respBody = JSON.stringify({ ce: 'checked' })
  const respDigest = createHash('sha256').update(Buffer.from(respBody)).digest('base64')
  return withServer(
    (req, res, info) =>
      res.writeHead(200, { 'content-length': String(Buffer.byteLength(respBody)) }).end(respBody),
    async (base) => {
      const ctx = await fresh()
      try {
        const req = new Request(`${base}/int`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
          integrity: `sha256-${respDigest}`,
        })
        // 若插件丢了 integrity，这里不会抛；若插件破坏了响应体，undici 会抛 integrity mismatch
        const res = await ctx.wrapper(req)
        assert.equal(res.status, 200, 'integrity 校验必须仍然通过（响应体被完整保留）')
        assert.equal(await res.text(), respBody)
        return { integrityPreserved: true, compressed: ctx.handle.stats.compressed }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 5. 非阻塞

await test('5. flush() 异步非阻塞，锁被占用时立即返回', async () => {
  return withServer(
    (req, res) => res.writeHead(200).end('ok'),
    async (base) => {
      const ctx = await fresh()
      try {
        const post = () =>
          ctx.wrapper(`${base}/s`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonOf(60),
          })
        await post()
        await ctx.handle.flush() // 排空，确保下一轮 flush 一定有增量
        await post() // 制造新的未落盘增量
        const lock = ctx.handle.stateFile + '.lock'
        writeFileSync(lock, '')
        const started = performance.now()
        const p = ctx.handle.flush()
        const blockedMs = performance.now() - started
        assert.ok(p && typeof p.then === 'function', 'flush() 必须返回 Promise')
        assert.ok(blockedMs < 50, `flush() 不得阻塞主线程（实测 ${Math.round(blockedMs)}ms）`)
        const ok = await p
        rmSync(lock, { force: true })
        assert.equal(ok, false, '锁被占用且有增量时应返回 false')
        const recovered = await ctx.handle.flush()
        assert.equal(recovered, true, '解锁后应能把保留的增量补写进去')
        const state = JSON.parse(readFileSync(ctx.handle.stateFile, 'utf8'))
        assert.ok(state.lifetime.compressed >= 2, `增量不得丢（compressed=${state.lifetime.compressed}）`)
        return { blockedMs: Math.round(blockedMs), flushReturned: ok, recovered, compressed: state.lifetime.compressed }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('5b. flushSync 在锁被占用时也不空转，但增量会保留', async () => {
  return withServer(
    (req, res) => res.writeHead(200).end('ok'),
    async (base) => {
      const ctx = await fresh()
      try {
        const post = () =>
          ctx.wrapper(`${base}/s`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonOf(60),
          })
        await post()
        await ctx.handle.flush()
        await post()
        const lock = ctx.handle.stateFile + '.lock'
        writeFileSync(lock, '')
        const started = performance.now()
        const ok = ctx.handle.flushSync()
        const ms = performance.now() - started
        rmSync(lock, { force: true })
        assert.equal(ok, false, '锁被占用时 flushSync 应返回 false')
        assert.ok(ms < 50, `flushSync 单次尝试应立即返回（实测 ${Math.round(ms)}ms）`)
        assert.equal(await ctx.handle.flush(), true, '同步失败后异步路径必须仍能补写')
        return { ms: Math.round(ms), ok }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('6. 旧 handle 卸载不影响新安装实例', async () => {
  const ctx = await fresh()
  try {
    const mod = ctx.mod
    const old = ctx.handle
    old.uninstall()
    const current = mod.installFetchGzip()
    old.uninstall() // 幂等，且不得动新实例
    assert.equal(globalThis.__dshFetchGzip, current, '全局 marker 必须仍指向新实例')
    assert.equal(globalThis.fetch, current.fetch, '新 wrapper 必须仍在位')
    const before = globalThis.fetch
    old.uninstall()
    assert.equal(globalThis.fetch, before, '再次卸载仍是 no-op')
    current.uninstall()
    return { markerOwnedByCurrent: true }
  } finally {
    ctx.restore()
  }
})

// ------------------------------------------------------------------ 7. headers

await test('7. 重复头值经标准归一化保留（a, b）', async () => {
  return withServer(
    (req, res, info) =>
      res.writeHead(200).end(JSON.stringify({ tags: info.headers['x-tags'] || null, ce: info.headers['content-encoding'] || null })),
    async (base) => {
      const ctx = await fresh()
      try {
        const res = await ctx.wrapper(`${base}/h`, {
          method: 'POST',
          headers: [
            ['content-type', 'application/json'],
            ['x-tags', 'a'],
            ['x-tags', 'b'],
          ],
          body: jsonOf(60),
        })
        const info = await res.json()
        assert.equal(info.ce, 'gzip', '重复头的请求也应正常压缩')
        assert.equal(info.tags, 'a, b', '重复头必须保留两个值')
        return { tags: info.tags, ce: info.ce }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 8. Request + init.body

await test('8. fetch(request, { body }) 继承 Request 的 content-type 并压缩', async () => {
  return withServer(
    (req, res, info) =>
      res.writeHead(200).end(JSON.stringify({ ce: info.headers['content-encoding'] || null, len: info.raw.length })),
    async (base) => {
      const ctx = await fresh()
      try {
        const req = new Request(`${base}/mix`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(10),
        })
        const res = await ctx.wrapper(req, { body: jsonOf(200) })
        const info = await res.json()
        assert.equal(info.ce, 'gzip', 'Request 上的 content-type 必须被继承，从而完成压缩')
        return info
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('8b. 明文请求体与服务端解出来的内容逐字节一致', async () => {
  const body = jsonOf(500)
  return withServer(
    (req, res, info) => res.writeHead(200).end(JSON.stringify({ ok: info.body === body, ce: info.headers['content-encoding'] || null })),
    async (base) => {
      const ctx = await fresh()
      try {
        const res = await ctx.wrapper(`${base}/same`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        const info = await res.json()
        assert.equal(info.ce, 'gzip')
        assert.equal(info.ok, true, 'gunzip 后必须与原 JSON 完全相同')
        return info
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 9. 统计与降级安全

await test('9. 统计字段完整且合法 JSON', async () => {
  const ctx = await fresh()
  try {
    await withServer(
      (req, res) => res.writeHead(200).end('ok'),
      async (base) => {
        await ctx.wrapper(`${base}/s`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        await ctx.handle.flush()
      },
    )
    const raw = JSON.parse(readFileSync(ctx.handle.stateFile, 'utf8'))
    for (const k of ['attempted', 'compressed', 'bytesIn', 'bytesOut', 'skipped', 'failed', 'replay', 'replayBytes']) {
      assert.equal(typeof raw.lifetime[k], 'number', `lifetime.${k} 必须存在`)
    }
    assert.equal(raw.version, 2)
    assert.equal(raw.plugin, '1.0.7')
    assert.ok(raw.lifetime.compressed >= 1)
    assert.ok(raw.lifetime.bytesOut < raw.lifetime.bytesIn, '压缩后字节应少于原始字节')
    return { lifetime: raw.lifetime }
  } finally {
    ctx.restore()
  }
})

await test('9b. 压缩自身出错时原样透传（不让请求失败）', async () => {
  let seen = null
  const ctx = await fresh({ level: 99 }, async (input, init) => {
    seen = init
    return new Response('raw-ok')
  })
  try {
    const res = await ctx.wrapper('https://degrade.invalid/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonOf(60),
    })
    assert.equal(await res.text(), 'raw-ok', '压缩失败时必须原样透传')
    assert.equal(new Headers(seen.headers).get('content-encoding'), null, '透传时不得带 content-encoding')
    return { degradedTo: 'plain' }
  } finally {
    ctx.restore()
  }
})

// ------------------------------------------------------------------ 10. headers 整组替换（P1）

await test('10a. init.headers 整组替换：不得携带原 Request 的 Authorization/x-old', async () => {
  return withServer(
    (req, res, info) => {
      res.writeHead(200).end(JSON.stringify({
        auth: info.headers['authorization'] || null,
        xOld: info.headers['x-old'] || null,
        xNew: info.headers['x-new'] || null,
        ce: info.headers['content-encoding'] || null,
      }))
    },
    async (base) => {
      const ctx = await fresh()
      try {
        const req = new Request(`${base}/replace`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer dummy-audit-only', 'x-old': 'remove-me' },
          body: jsonOf(60),
        })
        const res = await ctx.wrapper(req, {
          headers: { 'content-type': 'application/json', 'x-new': 'new' },
        })
        const info = await res.json()
        assert.equal(info.auth, null, '调用方明确去掉的 Authorization 绝不能继续发出')
        assert.equal(info.xOld, null, 'x-old 应被整组替换掉')
        assert.equal(info.xNew, 'new', 'init.headers 的新头必须生效')
        assert.equal(info.ce, 'gzip', '替换头之后仍应正常压缩')
        return info
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('10b. init.headers 为空对象 → 清空原 Request 的整组头', async () => {
  return withServer(
    (req, res, info) =>
      res.writeHead(200).end(JSON.stringify({ auth: info.headers['authorization'] || null, ct: info.headers['content-type'] || null })),
    async (base) => {
      const ctx = await fresh()
      try {
        const req = new Request(`${base}/empty`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer dummy-audit-only' },
          body: jsonOf(60),
        })
        const res = await ctx.wrapper(req, { headers: {} })
        const info = await res.json()
        assert.equal(info.auth, null, '空 headers 应清空 Authorization')
        assert.equal(info.ct, null, '空 headers 应清空 content-type')
        return info
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('10c. init.headers 未给出 → 继承原 Request 的头并压缩', async () => {
  return withServer(
    (req, res, info) =>
      res.writeHead(200).end(JSON.stringify({ ct: info.headers['content-type'] || null, ce: info.headers['content-encoding'] || null })),
    async (base) => {
      const ctx = await fresh()
      try {
        const req = new Request(`${base}/inherit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        const res = await ctx.wrapper(req)
        const info = await res.json()
        assert.equal(info.ct, 'application/json', '未给 init.headers 时应继承')
        assert.equal(info.ce, 'gzip')
        return info
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 11. 预读分支清理（P2）

await test('11. 多块流超限 → 废弃的预读分支被取消，原请求字节完整', async () => {
  const chunkBytes = 256 * 1024
  const chunks = 12
  const cap = 1024
  return withServer(
    (req, res, info) => res.writeHead(200).end(JSON.stringify({ ce: info.headers['content-encoding'] || null, len: info.raw.length })),
    async (base) => {
      let produced = 0
      let pullAfterCanceled = 0
      let canceled = false
      const stream = new ReadableStream({
        pull(c) {
          if (produced < chunks) {
            produced++
            c.enqueue(new Uint8Array(chunkBytes).fill(65))
          } else {
            c.close()
          }
        },
        cancel() {
          canceled = true
        },
      })
      const ctx = await fresh({ maxPreviewBytes: cap })
      try {
        const req = new Request(`${base}/multi`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: stream,
          duplex: 'half',
        })
        const res = await ctx.wrapper(req)
        const info = await res.json()
        // 超过上限 ⇒ 不压缩，原样透传
        assert.equal(info.ce, null, '超过预读上限应原样透传')
        assert.equal(info.len, chunkBytes * chunks, '原请求字节必须完整送达')
        // 预读分支进入过并触发了取消（不是读完走正常路径）
        assert.ok(ctx.handle.stats.skipped >= 1, '应记为 skipped')
        void pullAfterCanceled
        return { bytes: info.len, ce: info.ce, canceled, produced }
      } finally {
        ctx.restore()
      }
    },
  )
})

await test('11b. 预读取消不产生 unhandled rejection，原分支仍可读', async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(String(e))
  process.on('unhandledRejection', onUnhandled)
  try {
    const ctx = await fresh({ maxPreviewBytes: 512 })
    try {
      const payload = jsonOf(400)
      const req = new Request('https://audit.invalid/preview-cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
      let seen = null
      // 让插件的 origFetch 什么都不做，我们只关心预读阶段
      const nativeFetch = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        seen = new Headers(init && init.headers)
        // 干跑：不真正发送，但把 Request body 读掉模拟传输
        if (input instanceof Request && input.body) await input.arrayBuffer().catch(() => {})
        return new Response('')
      }
      try {
        await ctx.wrapper(req).catch(() => {})
      } finally {
        globalThis.fetch = nativeFetch
      }
      await new Promise((r) => setTimeout(r, 60))
      assert.deepEqual(unhandled, [], `不应有 unhandledRejection，实际 ${unhandled.join(' | ')}`)
      assert.equal(seen && seen.get('content-encoding'), null, '超限应透传且不压缩')
      return { unhandledCount: unhandled.length }
    } finally {
      ctx.restore()
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})

// ------------------------------------------------------------------ 12. 并发探测取消（P2）

await test('12a. 并发探测等待可取消，且释放被放弃的响应', async () => {
  const nativeFetch = globalThis.fetch
  const sends = []
  const canceledIds = []
  let releaseFirst
  const firstGate = new Promise((r) => {
    releaseFirst = r
  })
  let firstPlainStarted
  const firstStarted = new Promise((r) => {
    firstPlainStarted = r
  })
  let secondCompressedDone
  const second415 = new Promise((r) => {
    secondCompressedDone = r
  })
  let compressedCount = 0

  const ctx = await fresh(undefined, async (input, init) => {
    const ce = new Headers((init && init.headers) || null).get('content-encoding') || 'plain'
    sends.push(ce)
    if (ce === 'gzip') {
      const id = ++compressedCount
      if (id === 2) secondCompressedDone()
      return new Response(
        new ReadableStream({
          cancel() {
            canceledIds.push(id)
          },
        }),
        { status: 415 },
      )
    }
    // 明文：第一条挂住，第二条直接成功
    if (sends.filter((x) => x === 'plain').length === 1) {
      firstPlainStarted()
      await firstGate
    }
    return new Response('')
  })
  void nativeFetch
  try {
    const first = ctx.wrapper('https://probe.invalid/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonOf(60),
    })
    await firstStarted

    const ac = new AbortController()
    const second = ctx
      .wrapper('https://probe.invalid/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: jsonOf(60),
        signal: ac.signal,
      })
      .then(
        () => 'resolved',
        (e) => e.name,
      )
    await second415
    await new Promise((r) => setTimeout(r, 20))
    ac.abort()
    const afterAbort = await Promise.race([second, new Promise((r) => setTimeout(() => r('still pending'), 300))])
    releaseFirst()
    await first.catch(() => {})
    const final = await second
    assert.equal(afterAbort, 'AbortError', '第二个请求取消后必须立刻结束，而不是等第一个探测')
    assert.equal(final, 'AbortError')
    assert.ok(canceledIds.includes(1), `被放弃的 415 响应应被 cancel，实际 ${canceledIds.join(',')}`)
    return { afterAbort, final, canceledIds, sends }
  } finally {
    ctx.restore()
  }
})

// ------------------------------------------------------------------ 13. replayBytes 落盘（P2）

await test('13. replayBytes 写入 lifetime 与 day 增量', async () => {
  return withServer(
    (req, res, info) => {
      res.writeHead(info.headers['content-encoding'] === 'gzip' ? 415 : 200).end('')
    },
    async (base) => {
      const ctx = await fresh()
      try {
        const body = jsonOf(60)
        const bytes = Buffer.byteLength(body)
        await ctx.wrapper(`${base}/rbytes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        assert.equal(ctx.handle.stats.replayBytes, bytes, '内存里的 replayBytes 应为请求体字节数')
        await ctx.handle.flush()
        const state = JSON.parse(readFileSync(ctx.handle.stateFile, 'utf8'))
        assert.equal(state.lifetime.replayBytes, bytes, 'lifetime.replayBytes 必须落盘')
        assert.equal(state.lifetime.replay, 1)
        assert.equal(state.day.replayBytes, bytes, 'day.replayBytes 必须落盘')
        assert.equal(state.day.replay, 1)

        // 同一接口在 unsupported 期内会直接走明文、不再 replay —— 这是正确行为。
        // 换一个接口才能验证累加语义。
        await ctx.wrapper(`${base}/rbytes-2`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        await ctx.handle.flush()
        const again = JSON.parse(readFileSync(ctx.handle.stateFile, 'utf8'))
        assert.equal(again.lifetime.replayBytes, bytes * 2, '第二个接口的重发字节应累加')
        assert.equal(again.lifetime.replay, 2)

        // 同一接口再发：直接明文，不得再记 replay
        await ctx.wrapper(`${base}/rbytes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        assert.equal(ctx.handle.stats.replay, 2, 'unsupported 期内同接口不应再 replay')
        return { bytes, inMemory: ctx.handle.stats.replayBytes, persisted: again.lifetime.replayBytes }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 14. TTL 能区分过期与永久

await test('14. TTL 过期后能力缓存必须失效（能被区分出永久缓存）', async () => {
  return withServer(
    (req, res, info) => res.writeHead(info.headers['content-encoding'] === 'gzip' ? 200 : 200).end('ok'),
    async (base) => {
      const ctx = await fresh({ verifiedTtlMs: 40 })
      try {
        await ctx.wrapper(`${base}/ttl`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        assert.equal(ctx.handle.verified.size, 1, '首次成功应记入 verified')
        assert.equal(ctx.handle.capabilities().length, 1)
        await new Promise((r) => setTimeout(r, 80))
        // 过期后：capabilities 不再列出
        assert.equal(ctx.handle.capabilities().length, 0, '过期后不应再出现在能力列表')
        // 关键：再次请求应重新走压缩探测（若缓存永久，会直接命中 verified 而不重发）
        const before = ctx.handle.stats.attempted
        await ctx.wrapper(`${base}/ttl`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
        })
        assert.equal(ctx.handle.stats.attempted, before + 1, '过期后必须重新尝试压缩')
        assert.equal(ctx.handle.verified.size, 1, '重新成功后应再次 in verified')
        return { attemptedBefore: before, attemptedAfter: ctx.handle.stats.attempted }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 15. integrity 负例

await test('15. integrity 摘要错误必须被拒绝（负例）', async () => {
  const respBody = 'real-body'
  return withServer(
    (req, res) => res.writeHead(200, { 'content-length': String(Buffer.byteLength(respBody)) }).end(respBody),
    async (base) => {
      const ctx = await fresh()
      try {
        const wrong = createHash('sha256').update(Buffer.from('not-the-body')).digest('base64')
        const req = new Request(`${base}/bad-integrity`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: jsonOf(60),
          integrity: `sha256-${wrong}`,
        })
        let rejected = false
        let name = ''
        try {
          await ctx.wrapper(req)
        } catch (e) {
          rejected = true
          name = e.name
        }
        assert.equal(rejected, true, '错误摘要必须被拒绝，不能被插件吞掉')
        return { rejected, name }
      } finally {
        ctx.restore()
      }
    },
  )
})

// ------------------------------------------------------------------ 汇总

const failed = results.filter((r) => r.status !== 'pass')
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\n全部 ${results.length} 项通过`)
}
