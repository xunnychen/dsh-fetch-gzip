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
      const res = await globalThis.fetch(`${base}/s415`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: jsonOf(60),
      })
      assert.equal(res.status, 200, '415 后应明文重发并拿到 200')
      return { status: res.status }
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
      const pending = globalThis.fetch(req).then(
        () => 'resolved',
        (e) => e.name,
      )
      await new Promise((r) => setTimeout(r, 30))
      abort.abort()
      const state = await Promise.race([pending, new Promise((r) => setTimeout(() => r('pending'), 300))])
      try {
        controller.close()
      } catch {}
      assert.equal(state, 'AbortError', '取消后应立刻以 AbortError 结束，而不是一直 pending')
      return { state }
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
    (req, res, info) => res.writeHead(200).end(JSON.stringify({ ce: info.headers['content-encoding'] || null })),
    async (base) => {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(jsonOf(200)))
          c.close()
        },
      })
      const res = await globalThis.fetch(`${base}/s`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      })
      const body = await res.json()
      assert.equal(body.ce, null, '流式 init.body 必须保留原生传输语义')
      return { ce: body.ce }
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
    assert.equal(raw.plugin, '1.0.6')
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

// ------------------------------------------------------------------ 汇总

const failed = results.filter((r) => r.status !== 'pass')
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
if (failed.length) {
  console.error(`\n${failed.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\n全部 ${results.length} 项通过`)
}
