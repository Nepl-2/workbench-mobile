#!/usr/bin/env node
/**
 * 手机工作媒介 · 桥接服务
 * 零第三方依赖（Node ≥ 22，使用内置 fetch / http / fs）。
 *
 * 职责：
 *  1. 托管 mobile/ 静态前端
 *  2. 提供 REST + SSE 接口（文件/模型/会话/聊天）
 *  3. 对接 DeepSeek Harness 的 /api RPC（聊天 + 历史 + 模型）
 *
 * 环境变量（带 WORKBENCH_ 前缀，避免与 DSH 的 PORT/HOST 冲突）：
 *  WORKBENCH_DSH_BASE    DSH web 服务地址，默认取 $DSH_WEB_URL 或 http://127.0.0.1:3080
 *  WORKBENCH_PORT        桥接监听端口，默认 8090
 *  WORKBENCH_HOST        监听地址，默认 127.0.0.1（Zerotier 场景设为 0.0.0.0）
 *  WORKBENCH_WORK_DIRS   冒号分隔的文件根目录
 *  WORKBENCH_ACCESS_TOKEN 可选访问口令；设置后需 ?token= 或 Authorization 携带
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOBILE_DIR = path.join(__dirname, '..', 'mobile')

const DSH_BASE = process.env.WORKBENCH_DSH_BASE || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const PORT = Number(process.env.WORKBENCH_PORT || 8090)
const HOST = process.env.WORKBENCH_HOST || '127.0.0.1'
const ACCESS_TOKEN = process.env.WORKBENCH_ACCESS_TOKEN || ''
const WORK_DIRS = (process.env.WORKBENCH_WORK_DIRS || path.resolve(__dirname, '..', '..'))
  .split(':').filter(Boolean)

const UPLOAD_DIR = path.join(WORK_DIRS[0] || __dirname, 'uploads')

// ============================================================
// DSH RPC 客户端（unary）
// ============================================================
async function rpc(method, payload = {}) {
  const rpcId = randomUUID()
  const res = await fetch(`${DSH_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!res.ok) throw new Error(`DSH RPC ${method}: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > 8 * 1024 * 1024) {
    throw new Error(`DSH RPC ${method}: 响应过大(${(len / 1024 / 1024).toFixed(0)}MB)，已跳过`)
  }
  const full = await res.json()
  if (full.rpcId !== rpcId) throw new Error(`DSH RPC ${method}: rpcId 不匹配`)
  const result = full.result
  if (result && result.ok === false) {
    const err = result.error || {}
    throw new Error(`DSH RPC ${method}: ${err.code || ''} ${err.message || ''}`.trim())
  }
  return result ? result.value : undefined
}

// ============================================================
// 文本提取
// ============================================================
function extractText(msg) {
  const c = msg && msg.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (!b) return ''
      if (b.type === 'text') return (b.text ?? b.content ?? '')
      if (b.type === 'tool_call') return '\n『调用工具：' + (b.name || '') + '』'
      return ''
    }).join('').trim()
  }
  return ''
}

// ============================================================
// 会话/模型状态
// ============================================================
let defaultSessionId = null
async function getDefaultSession() {
  if (defaultSessionId) return defaultSessionId
  const r = await rpc('session.create', {})
  defaultSessionId = r.sessionId
  return defaultSessionId
}

// ============================================================
// HTTP 工具
// ============================================================
function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}
function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
}
function sseSend(res, obj) {
  try {
    if (res.destroyed || res.writableEnded) return
    res.write('data: ' + JSON.stringify(obj) + '\n\n')
  } catch {}
}
function authorize(req, res) {
  if (!ACCESS_TOKEN) return true
  const u = new URL(req.url, 'http://x')
  const token = u.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (token === ACCESS_TOKEN) return true
  json(res, 401, { error: '未授权：缺少访问口令' })
  return false
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ============================================================
// DSH mux 下行流订阅（问题确认环节）
// ------------------------------------------------------------
// 正式版（DSH 官方 Web）通过 /api/events.mux 的 WebSocket 下行流，
// 把"ask_user_question 等用户确认"的问题推给前端。31.9 桥接层此前
// 只做 unary RPC 轮询，从未订阅该流，所以智能体提问时前端完全看不到。
//
// 这里用 Node 内置 WebSocket 订阅同一条 mux 流：
//   1. 收到 question/requested 帧 → 转成 SSE 事件推给前端
//   2. 前端回答后 POST /api/chat/respond → 构造 client-response 回 DSH
// ============================================================
const dshWsBase = DSH_BASE.replace(/^http/, 'ws')

/** sessionId -> 活跃的 chat SSE 响应集合（问题推给同会话的前端） */
const sessionStreams = new Map()

/** 每个会话最近的问题：sessionId -> { rpcId, questions }（用于重连恢复/前端轮询补拉） */
const recentQuestions = new Map()

let muxSocket = null
let muxRetryTimer = null

function pushToSession(sessionId, obj) {
  const set = sessionStreams.get(sessionId)
  if (set) for (const res of set) sseSend(res, obj)
}

function startMux() {
  if (typeof WebSocket !== 'function') {
    console.log('[mux] 当前 Node 不支持 WebSocket，问题确认环节不可用')
    return
  }
  let ws
  try {
    ws = new WebSocket(`${dshWsBase}/api/events.mux`)
  } catch (e) {
    console.log('[mux] 连接失败:', e.message)
    scheduleMuxRetry()
    return
  }
  muxSocket = ws
  ws.onopen = () => console.log('[mux] 已连接 DSH mux 流')
  ws.onmessage = (ev) => {
    let frame
    try { frame = JSON.parse(String(ev.data)) } catch { return }
    const payload = frame && frame.payload
    if (!payload) return
    if (payload.type === 'question/requested') {
      // 智能体提问了：把问题 + rpcId 推给对应会话的前端
      const { sessionId, questions } = payload
      const rpcId = frame.rpcId
      recentQuestions.set(sessionId, { rpcId, questions: questions || [], time: Date.now() })
      pushToSession(sessionId, { type: 'question', rpcId, sessionId, questions: questions || [] })
    } else if (payload.type === 'question/resolved') {
      // 问题已回答/取消：清理缓存，并通知前端收起卡片
      if (recentQuestions.has(payload.sessionId)) {
        recentQuestions.delete(payload.sessionId)
      }
      pushToSession(payload.sessionId, {
        type: 'question-resolved', sessionId: payload.sessionId,
        questionRpcId: payload.questionRpcId, outcome: payload.outcome,
      })
    }
  }
  ws.onclose = () => {
    console.log('[mux] 连接断开，稍后重连')
    muxSocket = null
    scheduleMuxRetry()
  }
  ws.onerror = () => { try { ws.close() } catch {} }
}

function scheduleMuxRetry() {
  if (muxRetryTimer) return
  muxRetryTimer = setTimeout(() => {
    muxRetryTimer = null
    startMux()
  }, 3000)
}

/** 回答一个 DSH 问题：提交 client-response（rpcId 回传，正式版同款协议） */
async function respondToDsh(sessionId, rpcId, answer) {
  const body = {
    type: 'client-response',
    rpcId,
    result: {
      ok: true,
      value: { sessionId, answer },
    },
  }
  const res = await fetch(`${DSH_BASE}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`DSH respond: HTTP ${res.status}`)
  const receipt = await res.json()
  if (!receipt || receipt.accepted !== true) {
    throw new Error('DSH respond: ' + (receipt && receipt.reason || '未接受'))
  }
  return receipt
}

// ============================================================
// 文件树（列目录 + 大小/时间，跳过隐藏与 node_modules）
// ============================================================
function walkFiles(root, maxDepth = 4) {
  const out = []
  let count = 0
  function walk(dir, depth) {
    if (depth > maxDepth || count > 20000) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else {
        try {
          const st = fs.statSync(full)
          out.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs })
          count++
        } catch {}
      }
    }
  }
  walk(root, 0)
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

// ============================================================
// 文件树（带上下级目录结构，供前端折叠展示）
// ============================================================
function walkTree(root, maxDepth = 6) {
  let nodes = 0
  function walk(dir, depth) {
    if (depth > maxDepth || nodes > 8000) return []
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    const children = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      let st
      try { st = fs.statSync(full) } catch { continue }
      nodes++
      if (e.isDirectory()) {
        children.push({ name: e.name, path: full, type: 'dir', size: 0, mtime: st.mtimeMs, children: walk(full, depth + 1) })
      } else {
        children.push({ name: e.name, path: full, type: 'file', size: st.size, mtime: st.mtimeMs })
      }
    }
    children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.type === 'dir' ? a.name.localeCompare(b.name, 'zh-Hans-CN') : b.mtime - a.mtime
    })
    return children
  }
  return walk(root, 0)
}

// ============================================================
// 全量会话消息（session.history 分页抓取，beforeSeq 向前翻页）
// ============================================================
async function fetchAllMessages(sessionId, maxPages = 10) {
  const pages = []
  let beforeSeq
  for (let page = 0; page < maxPages; page++) {
    const v = await rpc('session.history', { sessionId, beforeSeq, maxMessages: 100 })
    const events = v.events || []
    const msgs = []
    let firstSeq
    for (const entry of events) {
      const ev = entry.event
      if (!ev) continue
      if (firstSeq === undefined) firstSeq = ev.seq
      if (ev.type === 'user/message') {
        const t = extractText(ev.data)
        if (t) msgs.push({ role: 'user', content: t, timestamp: ev.time })
      } else if (ev.type === 'assistant/message') {
        const t = extractText(ev.data && ev.data.message)
        if (t) msgs.push({ role: 'assistant', content: t, timestamp: ev.time })
      }
    }
    pages.push(msgs)
    if (!v.hasMore || !events.length || firstSeq === undefined) break
    beforeSeq = firstSeq
  }
  // 每页内部按 seq 升序；页与页之间是"新→旧"，整体反转页序得到时间正序
  const out = []
  for (let i = pages.length - 1; i >= 0; i--) out.push(...pages[i])
  return out
}

// ============================================================
// 路由处理
// ============================================================
async function handle(req, res) {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname

  // 访问口令：设置了 ACCESS_TOKEN 时，所有 /api/* 都需要口令（静态文件放行）
  if (p.startsWith('/api/') && !authorize(req, res)) return

  // 健康检查
  if (p === '/api/health') {
    try { await rpc('host.describe') } catch (e) { return json(res, 503, { ok: false, error: e.message }) }
    return json(res, 200, { ok: true, dsh: DSH_BASE })
  }

  // 会话列表
  if (p === '/api/sessions' && req.method === 'GET') {
    try {
      const v = await rpc('session.list', {})
      const items = (v.items || [])
        .filter((s) => !s.blank)
        .map((s) => ({ id: s.sessionId, title: s.title || s.projections?.values?.title || '会话 ' + String(s.sessionId).slice(0, 6), updatedAt: s.updatedAt, messageCount: s.projections?.values?.sessionStats?.turns || 0 }))
      return json(res, 200, items)
    } catch (e) { return json(res, 500, { error: e.message }) }
  }

  // 会话历史
  const sessionMatch = p.match(/^\/api\/sessions\/([^/]+)$/)
  if (sessionMatch && req.method === 'GET') {
    try {
      const messages = await fetchAllMessages(sessionMatch[1])
      return json(res, 200, { sessionId: sessionMatch[1], messages })
    } catch (e) { return json(res, 500, { error: e.message }) }
  }

  // 新建会话（丢弃缓存的 defaultSession，下次 chat 会创建新会话）
  if (p === '/api/sessions/new' && req.method === 'POST') {
    defaultSessionId = null
    return json(res, 200, { ok: true })
  }

  // 聊天（SSE 流式）
  if (p === '/api/chat' && req.method === 'POST') {
    let body
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { body = {} }
    const message = (body.message || '').toString()
    if (!message.trim()) return json(res, 400, { error: '消息为空' })

    let sessionId = body.sessionId
    try {
      if (!sessionId) { sessionId = await getDefaultSession(); defaultSessionId = sessionId }
      sse(res)
      sseSend(res, { type: 'session', sessionId })
      // 注册该会话的活跃流：mux 流收到 question/requested 时推到这里
      let set = sessionStreams.get(sessionId)
      if (!set) { set = new Set(); sessionStreams.set(sessionId, set) }
      set.add(res)
      res.on('close', () => {
        const s = sessionStreams.get(sessionId)
        if (s) { s.delete(res); if (s.size === 0) sessionStreams.delete(sessionId) }
      })
      // 若该会话正好有未答问题（如重连场景），立即补推
      const pending = recentQuestions.get(sessionId)
      if (pending) sseSend(res, { type: 'question', rpcId: pending.rpcId, sessionId, questions: pending.questions })
      const content = [{ type: 'text', text: message }]
      if (Array.isArray(body.attachments) && body.attachments.length) {
        content.push({ type: 'text', text: '\n\n[附件]：' + body.attachments.join('、') })
      }
      // 发送 prompt 前先记录会话当前尾部 seq，避免把历史消息重新推给前端
      let startSeq = -1
      try {
        const hist = await rpc('session.history', { sessionId, maxMessages: 20 })
        for (const entry of (hist.events || [])) {
          const ev = entry.event
          if (ev && ev.seq > startSeq) startSeq = ev.seq
        }
      } catch {}
      // 发送 prompt（unary，立即返回 accepted）
      await rpc('session.prompt', { sessionId, mode: 'queue', content, clientTimeZone: 'Asia/Shanghai' })
      // 轮询 history，只捕获 startSeq 之后的新事件
      await streamNewMessages(res, sessionId, startSeq)
    } catch (e) {
      try { sseSend(res, { type: 'error', message: e.message }) } catch {}
      res.end()
    }
    return
  }

  // 回答智能体的确认问题（复刻正式版 POST /api/respond）
  if (p === '/api/chat/respond' && req.method === 'POST') {
    let body
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { body = {} }
    const { sessionId, rpcId, answer } = body
    if (!sessionId || !rpcId || !answer) return json(res, 400, { error: '缺少 sessionId/rpcId/answer' })
    try {
      const receipt = await respondToDsh(sessionId, rpcId, answer)
      // 本地缓存同步清理
      recentQuestions.delete(sessionId)
      pushToSession(sessionId, { type: 'question-resolved', sessionId, questionRpcId: rpcId, outcome: 'answered' })
      return json(res, 200, { ok: true, receipt })
    } catch (e) {
      return json(res, 500, { error: e.message })
    }
  }

  // 文件列表
  if (p === '/api/files' && req.method === 'GET') {
    const files = []
    for (const d of WORK_DIRS) files.push(...walkFiles(d))
    // 去重
    const seen = new Set()
    const dedup = files.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true })
    return json(res, 200, dedup.slice(0, 500))
  }

  // 文件树（含目录层级）
  if (p === '/api/files/tree' && req.method === 'GET') {
    const trees = WORK_DIRS.map((d) => {
      let st = { mtimeMs: 0 }
      try { st = fs.statSync(d) } catch {}
      return { name: path.basename(d) || d, path: d, type: 'dir', size: 0, mtime: st.mtimeMs, children: walkTree(d) }
    })
    return json(res, 200, trees)
  }

  // 文件下载
  if (p === '/api/files/download' && req.method === 'GET') {
    const fp = u.searchParams.get('path') || ''
    if (!fp || !WORK_DIRS.some((d) => fp.startsWith(d))) return json(res, 403, { error: '路径越界' })
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return json(res, 404, { error: '文件不存在' })
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="' + encodeURIComponent(path.basename(fp)) + '"',
    })
    fs.createReadStream(fp).pipe(res)
    return
  }

  // 上传
  if (p === '/api/upload' && req.method === 'POST') {
    const ct = req.headers['content-type'] || ''
    if (!ct.includes('multipart/form-data')) return json(res, 400, { error: '需要 multipart/form-data' })
    const buf = await readBody(req)
    const boundary = (ct.match(/boundary=(?:"([^"]+)"|([^;]+))/) || [])[1] || (ct.match(/boundary=([^;]+)/) || [])[1]
    if (!boundary) return json(res, 400, { error: '缺少 boundary' })
    const name = parseMultipart(buf, boundary)
    if (!name) return json(res, 400, { error: '未找到文件' })
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    const safeName = path.basename(name.filename)
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), name.data)
    return json(res, 200, { name: safeName, path: path.join(UPLOAD_DIR, safeName) })
  }

  // 模型列表
  if (p === '/api/models' && req.method === 'GET') {
    try {
      const sid = await getDefaultSession()
      const v = await rpc('session.models', { sessionId: sid })
      const groups = (v.groups || []).map((g) => ({
        id: g.id, name: g.name || g.id,
        models: (g.models || []).map((m) => ({
          id: m.id, name: m.name || m.id,
          current: v.current && v.current.model === m.id && v.current.provider === g.id,
        })),
      }))
      return json(res, 200, { current: v.current || null, groups })
    } catch (e) { return json(res, 500, { error: e.message }) }
  }

  // 模型切换（必须同时指定 provider，避免同名 model 跳错组）
  if (p === '/api/models/switch' && req.method === 'POST') {
    let body
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { body = {} }
    try {
      const sid = await getDefaultSession()
      const { provider, model } = body
      if (!provider || !model) return json(res, 400, { error: '缺少 provider 或 model' })
      const v = await rpc('session.models', { sessionId: sid })
      const group = (v.groups || []).find((g) => g.id === provider)
      if (!group) return json(res, 404, { error: '提供方不存在' })
      if (!group.models?.some((m) => m.id === model)) return json(res, 404, { error: '该提供方下无此模型' })
      const sel = await rpc('session.selectModel', { sessionId: sid, provider, model })
      return json(res, 200, { ok: true, selected: sel.selected })
    } catch (e) { return json(res, 500, { error: e.message }) }
  }

  // 静态文件
  if (req.method === 'GET') {
    let filePath = p === '/' ? '/index.html' : p
    let full = path.join(MOBILE_DIR, path.normalize(filePath))
    if (!full.startsWith(MOBILE_DIR)) { full = path.join(MOBILE_DIR, 'index.html') }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) full = path.join(MOBILE_DIR, 'index.html')
    const ext = path.extname(full).toLowerCase()
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' }
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' })
    fs.createReadStream(full).pipe(res)
    return
  }

  json(res, 404, { error: 'not found' })
}

// ============================================================
// 轮询捕获新 assistant 消息（增量 chunk 流式转发）
// 协议：delta=增量文本 / msg-end=一条消息完成(含全文) / done=整轮完成
//        error=整轮失败(含 message+code) / max-tokens=达到输出上限
//        aborted=被中止 / blocked=被阻塞
// ============================================================
async function streamNewMessages(res, sessionId, startSeq) {
  let lastSeq = startSeq || -1
  let sawTurnEnd = false
  let turnTerminal = null // 记录本轮终结原因（若非正常 completed）
  const deadline = Date.now() + 15 * 60 * 1000 // 15 分钟上限
  while (Date.now() < deadline) {
    if (res.writableEnded || res.destroyed) return
    await sleep(600)
    let v
    try { v = await rpc('session.history', { sessionId, maxMessages: 20 }) } catch (e) {
      sseSend(res, { type: 'error', message: e.message }); return
    }
    let maxSeq = lastSeq
    const fresh = []
    for (const entry of (v.events || [])) {
      const ev = entry.event
      if (!ev) continue
      if (ev.seq > lastSeq) fresh.push(ev)
      if (ev.seq > maxSeq) maxSeq = ev.seq
    }
    // 按 seq 升序处理，保证 chunk 顺序正确
    fresh.sort((a, b) => a.seq - b.seq)
    for (const ev of fresh) {
      if (ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && ev.data.chunk.type === 'text-delta') {
        const t = ev.data.chunk.text || ''
        if (t) sseSend(res, { type: 'delta', text: t })
      } else if (ev.type === 'assistant/message') {
        // 消息边界：携带权威全文，前端用它替换流式预览，避免重复/缺字
        const t = extractText(ev.data && ev.data.message)
        sseSend(res, { type: 'msg-end', text: t || '' })
      } else if (ev.type === 'turn/end') {
        // 关键：像正式版那样解析 turn/end 的 reason，失败原因必须透传给前端，
        // 否则出错时前端只能收到 done、整轮没有任何内容 → 回答区一片空白。
        sawTurnEnd = true
        const reason = ev.data && ev.data.reason
        if (reason && reason.kind === 'error') {
          const err = reason.error || {}
          turnTerminal = { type: 'error', message: err.message || '智能体执行出错', code: err.code }
        } else if (reason && reason.kind === 'max-tokens') {
          turnTerminal = { type: 'max-tokens' }
        } else if (reason && reason.kind === 'aborted') {
          turnTerminal = { type: 'aborted' }
        } else if (reason && reason.kind === 'blocked') {
          turnTerminal = { type: 'blocked' }
        } else if (reason && reason.kind === 'interrupted') {
          turnTerminal = { type: 'interrupted' }
        }
        // reason.kind === 'completed' → turnTerminal 保持 null，走正常 done
      }
    }
    lastSeq = maxSeq
    if (sawTurnEnd && lastSeq >= 0) {
      // 再等一小轮，确保最后一个 assistant/message 已落库
      await sleep(500)
      break
    }
  }
  if (turnTerminal) {
    // 本轮失败/异常：把终结原因发给前端（绝不能让前端空白）
    sseSend(res, turnTerminal)
  } else if (sawTurnEnd) {
    sseSend(res, { type: 'done' })
  } else {
    // 轮询超时且始终未见 turn/end：显式报超时，而不是静默 done
    sseSend(res, { type: 'error', message: '生成超时（15 分钟无结果），请重试' })
  }
  res.end()
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ============================================================
// multipart 解析（极简：单个 file 字段）
// ============================================================
function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary)
  const parts = []
  let idx = buf.indexOf(delim)
  while (idx >= 0) {
    const start = idx + delim.length
    const end = buf.indexOf(delim, start)
    if (end < 0) { parts.push(buf.slice(start)); break }
    parts.push(buf.slice(start, end))
    idx = end
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const header = part.slice(0, headerEnd).toString('utf-8')
    const m = header.match(/filename="([^"]+)"/)
    if (!m) continue
    let data = part.slice(headerEnd + 4)
    // Buffer 无 endsWith，手动去掉结尾的 \r\n
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.slice(0, -2)
    }
    return { filename: m[1], data }
  }
  return null
}

// ============================================================
// 启动
// ============================================================
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { json(res, 500, { error: e.message }) } catch { res.end() }
  })
})
server.listen(PORT, HOST, () => {
  console.log(`[工作台桥接] 监听 http://${HOST}:${PORT}`)
  console.log(`[工作台桥接] DSH: ${DSH_BASE}  文件根: ${WORK_DIRS.join(', ')}`)
  if (ACCESS_TOKEN) console.log(`[工作台桥接] 已启用访问口令`)
  startMux()
})
