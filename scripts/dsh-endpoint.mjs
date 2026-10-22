#!/usr/bin/env node
/**
 * dsh-endpoint.mjs — 在桥接启动前，把 config.json 的 dsh.baseUrl 对准当前这次运行的 DSH。
 *
 * 为什么需要：DSH 桌面端每次启动会随机挑一个空闲端口（实测 4683 → 9759），而桥接的
 * 地址写在 config.json 里。端口一变，桥接就一直「DSH 不可用」，QQ 消息只能排队。
 *
 * 发现方式：从 netstat 取本机所有「外部端口为 0」的监听端口（这样不依赖系统语言的
 * LISTENING 字样），逐个用 HTTP 指纹确认——DSH 未认证时会返回 401 且正文是
 * 「dsh web authentication required…」；已认证/免鉴权时页面里有 __DSH_BOOT__。
 * 桥接自己的 3100 也是 401，但正文不同，所以不会被误认。
 *
 * 用法：
 *   node scripts/dsh-endpoint.mjs            # 启动引导：发现并写入，供 start.bat 调用
 *   node scripts/dsh-endpoint.mjs --watch    # 常驻看护：DSH 换端口后自动改写并重启桥接
 *   node scripts/dsh-endpoint.mjs --print    # 只打印发现的地址，不写文件
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = path.join(ROOT, 'config.json')
const CONSOLE_TOKEN_PATH = path.join(ROOT, 'state', 'console-token')
/** 控制台端口跟着 config.json 走（发行版里可能不是 3100）。 */
function consoleBaseUrl() {
  let port = 3100
  try {
    const value = Number(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))?.consolePort)
    if (Number.isInteger(value) && value > 0 && value < 65536) port = value
  } catch {}
  return `http://127.0.0.1:${port}`
}
const DSH_MARKER = 'dsh web authentication required'
const BOOT_MARKER = '__DSH_BOOT__'
const PROBE_TIMEOUT_MS = 700
const WATCH_INTERVAL_MS = 10_000
const RESTART_COOLDOWN_MS = 60_000

const jsonMode = new Set(process.argv.slice(2)).has('--json')
const log = (...args) => (jsonMode ? console.error : console.log)('[dsh-endpoint]', ...args)

/** 本机监听端口；外部端口为 0 是监听套接字的特征，和系统语言无关。 */
function listeningPorts() {
  let output
  try {
    output = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    log('跑不了 netstat，跳过发现：', error?.message ?? error)
    log('（在 DSH 自己的沙箱会话里跑会被拦，普通终端/cmd 不受影响）')
    return []
  }
  const ports = new Set()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+:0\s+/i.exec(line)
    if (!match) continue
    const address = match[1]
    const port = Number(match[2])
    if (!Number.isInteger(port) || port <= 0) continue
    if (!(address.startsWith('127.') || address === '0.0.0.0' || address.startsWith('[::'))) continue
    ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}

/** 这个端口是不是一个 DSH web（而不是桥接控制台、SnowLuma 或别的服务）。 */
async function looksLikeDsh(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (response.status === 401) {
      const body = await response.text()
      return body.toLowerCase().includes(DSH_MARKER)
    }
    if (response.status === 200) {
      const body = await response.text()
      return body.includes(BOOT_MARKER)
    }
    return false
  } catch {
    return false
  }
}

/** 扫一遍本机监听端口，返回 DSH 的 baseUrl；找不到返回 null。 */
async function discoverDshBaseUrl(ports = listeningPorts()) {
  const hits = []
  const batch = 16
  for (let index = 0; index < ports.length; index += batch) {
    const slice = ports.slice(index, index + batch)
    const results = await Promise.all(slice.map(async (port) => ((await looksLikeDsh(port)) ? port : null)))
    for (const port of results) if (port) hits.push(port)
  }
  if (!hits.length) return null
  const current = readBaseUrl()
  const stillThere = hits.find((port) => current?.endsWith(`:${port}`))
  return `http://127.0.0.1:${stillThere ?? hits[0]}`
}

function readBaseUrl() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const value = config?.dsh?.baseUrl
    return typeof value === 'string' && value ? value.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

/** 只改 baseUrl 这一处，保留文件其余格式与字段。 */
function writeBaseUrl(next) {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const pattern = /("baseUrl"\s*:\s*")([^"]*)(")/
  if (!pattern.test(raw)) {
    log('config.json 里找不到 baseUrl 字段，放弃写入')
    return false
  }
  const updated = raw.replace(pattern, (_match, head, _value, tail) => `${head}${next}${tail}`)
  JSON.parse(updated) // 写坏就抛，不落盘
  const temporary = `${CONFIG_PATH}.tmp-${process.pid}`
  fs.writeFileSync(temporary, updated, 'utf8')
  fs.renameSync(temporary, CONFIG_PATH)
  return true
}

/** 让桥接自己重启一次（它会重新读 config.json，start.bat 会把它拉起来）。 */
async function restartBridge() {
  let token = ''
  try {
    token = fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim()
  } catch {
    try {
      token = String(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))?.consoleToken ?? '').trim()
    } catch {}
  }
  if (!token) {
    log('没有控制台令牌，无法自动重启桥接；请手动重启一次')
    return false
  }
  try {
    const response = await fetch(`${consoleBaseUrl()}/api/restart`, {
      method: 'POST',
      headers: { 'x-console-token': token, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      log(`重启桥接失败：HTTP ${response.status}`)
      return false
    }
    log('已请求桥接重启')
    return true
  } catch (error) {
    log('重启桥接失败：', error?.message ?? error)
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function bootstrap() {
  const current = readBaseUrl()
  const found = await discoverDshBaseUrl()
  if (!found) {
    log(`没找到正在运行的 DSH（保留 config.json 里的 ${current ?? '(空)'}）`)
    return null
  }
  if (found === current) {
    log(`DSH 在 ${found}（与配置一致，无需改写）`)
    return found
  }
  if (writeBaseUrl(found)) {
    log(`DSH 在 ${found}，已改写 config.json（原值 ${current ?? '(空)'}）`)
  }
  return found
}

async function watch() {
  log('常驻看护已启动：DSH 换端口后会自动改写配置并重启桥接（Ctrl+C 退出）')
  let lastRestartAt = 0
  for (;;) {
    const current = readBaseUrl()
    if (current) {
      const port = Number(new URL(current).port || 80)
      if (await looksLikeDsh(port)) {
        await sleep(WATCH_INTERVAL_MS)
        continue
      }
    }
    const found = await discoverDshBaseUrl()
    if (found && found !== current && Date.now() - lastRestartAt > RESTART_COOLDOWN_MS) {
      if (writeBaseUrl(found)) {
        log(`DSH 换到了 ${found}（原值 ${current ?? '(空)'}），改写配置并重启桥接`)
        lastRestartAt = Date.now()
        await restartBridge()
      }
    } else if (!found) {
      log('DSH 暂时不可用，继续等待…')
    }
    await sleep(WATCH_INTERVAL_MS)
  }
}

const args = new Set(process.argv.slice(2))
if (args.has('--json')) {
  // 给面板用：单行 JSON 走 stdout，过程中的日志走 stderr，方便直接 JSON.parse。
  const found = await discoverDshBaseUrl()
  console.log(JSON.stringify({ ok: Boolean(found), baseUrl: found ?? '', current: readBaseUrl() ?? '' }))
} else if (args.has('--print')) {
  const found = await discoverDshBaseUrl()
  log(found ?? '没找到正在运行的 DSH')
} else if (args.has('--watch')) {
  await watch()
} else {
  await bootstrap()
}
