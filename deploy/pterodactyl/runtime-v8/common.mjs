import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

export class DeploymentError extends Error {}
export function check(ok, message) { if (!ok) throw new DeploymentError(message) }
export const nonce = () => crypto.randomBytes(16).toString('hex')

export async function stat(filename) {
  try { return await fsp.lstat(filename) }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

export async function directory(filename) {
  const current = await stat(filename)
  if (!current) await fsp.mkdir(filename, { recursive: true })
  else check(current.isDirectory() && !current.isSymbolicLink(), `Expected directory: ${filename}`)
  return filename
}

export async function regularFile(filename, { nonempty = true } = {}) {
  const current = await stat(filename)
  check(current?.isFile() && !current.isSymbolicLink(), `Expected regular file: ${filename}`)
  if (nonempty) check(current.size > 0, `Expected non-empty file: ${filename}`)
  return current
}

export async function atomicWrite(filename, contents, mode) {
  await directory(path.dirname(filename))
  const temp = `${filename}.tmp-${nonce()}`
  await fsp.writeFile(temp, contents, mode === undefined ? undefined : { mode })
  await fsp.rename(temp, filename)
}

export async function readJson(filename, fallback) {
  try { return JSON.parse(await fsp.readFile(filename, 'utf8')) }
  catch (error) {
    if (fallback !== undefined && error?.code === 'ENOENT') return fallback
    throw error
  }
}

export function safeInteger(value, label, min, max) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  check(Number.isSafeInteger(number) && number >= min && number <= max, `${label} must be an integer from ${min} to ${max}`)
  return number
}

export function cleanString(value, label, max = 256) {
  check(typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `Invalid ${label}`)
  return value
}

export function redact(values, text) {
  let output = String(text)
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) output = output.split(value).join('[REDACTED]')
  }
  return output
}

export async function freeTcpPort(excluded = []) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = net.createServer()
    server.unref()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise(resolve => server.close(resolve))
    if (port > 0 && !excluded.includes(port)) return port
  }
  throw new DeploymentError('Unable to reserve a local RCON port')
}

export async function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeploymentError(message)), timeoutMs)
  })
  try { return await Promise.race([promise, timeout]) }
  finally { clearTimeout(timer) }
}

export class Child {
  constructor(command, args, { cwd, env = process.env, log = () => {}, label = path.basename(command) } = {}) {
    this.label = label
    this.log = log
    this.proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.result = null
    this.closed = new Promise(resolve => {
      this.proc.once('exit', (code, signal) => {
        this.result = { code, signal }
        resolve(this.result)
      })
    })
    const consume = stream => {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line) this.log(line)
        if (pending.length > 65536) { this.log(pending.slice(0, 65536)); pending = '' }
      })
      stream.on('end', () => { if (pending) this.log(pending) })
    }
    consume(this.proc.stdout)
    consume(this.proc.stderr)
  }

  alive() { return this.result === null && this.proc.exitCode === null && !this.proc.killed }

  signal(signal) {
    if (!this.alive()) return false
    try {
      if (process.platform !== 'win32') process.kill(-this.proc.pid, signal)
      else this.proc.kill(signal)
      return true
    }
    catch { return false }
  }

  async stop(timeoutMs = 30000, signal = 'SIGTERM') {
    if (!this.alive()) return { forced: false, result: await this.closed }
    this.signal(signal)
    try {
      const result = await withTimeout(this.closed, timeoutMs, `${this.label} stop timed out`)
      return { forced: false, result }
    }
    catch (error) {
      if (!(error instanceof DeploymentError) || error.message !== `${this.label} stop timed out`) throw error
      this.signal('SIGKILL')
      return { forced: true, result: await this.closed }
    }
  }
}

function encodePacket(id, type, text) {
  const payload = Buffer.from(String(text), 'utf8')
  const packet = Buffer.alloc(payload.length + 14)
  packet.writeInt32LE(payload.length + 10, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  payload.copy(packet, 12)
  packet.writeInt16LE(0, 12 + payload.length)
  return packet
}

export class Rcon {
  constructor(port, password, timeout = 5000) {
    this.port = port
    this.password = password
    this.timeout = timeout
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.sequence = 10
    this.pending = new Map()
    this.queue = Promise.resolve()
  }

  async connect() {
    check(!this.socket, 'RCON is already connected')
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port })
    this.socket = socket
    socket.on('data', chunk => this.receive(chunk))
    socket.on('error', error => this.failAll(error))
    socket.on('close', () => this.failAll(new DeploymentError('RCON socket closed')))
    await withTimeout(once(socket, 'connect'), this.timeout, 'Timed out connecting to RCON')
    const id = ++this.sequence
    const auth = this.request(id, 3, this.password, 2)
    socket.write(encodePacket(id, 3, this.password))
    await auth
    return this
  }

  close() {
    const socket = this.socket
    this.socket = null
    if (socket) socket.destroy()
    this.failAll(new DeploymentError('RCON connection closed'))
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error instanceof Error ? error : new DeploymentError(String(error)))
    }
    this.pending.clear()
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0)
      if (size < 10 || size > 1024 * 1024) { this.close(); return }
      if (this.buffer.length < size + 4) return
      const packet = this.buffer.subarray(4, size + 4)
      this.buffer = this.buffer.subarray(size + 4)
      const id = packet.readInt32LE(0)
      const type = packet.readInt32LE(4)
      const body = packet.subarray(8, -2).toString('utf8')
      const pending = this.pending.get(id)
      if (!pending) continue
      if (id === -1 || (pending.expectedType !== undefined && type !== pending.expectedType)) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new DeploymentError('RCON authentication or packet validation failed'))
        continue
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(body)
    }
  }

  request(id, type, text, expectedType) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DeploymentError('RCON request timed out'))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer, expectedType, type, text })
    })
  }

  command(text) {
    this.queue = this.queue.then(async () => {
      check(this.socket && !this.socket.destroyed, 'RCON is not connected')
      const id = ++this.sequence
      const response = this.request(id, 2, text, 0)
      this.socket.write(encodePacket(id, 2, text))
      return response
    })
    return this.queue
  }
}

export async function reserveBudget(filename, maximum, now = Date.now()) {
  const budget = await readJson(filename, { since: now, count: 0 })
  check(Number.isSafeInteger(budget.since) && Number.isSafeInteger(budget.count) && budget.count >= 0, 'Invalid persisted provider budget')
  if (now - budget.since >= 3600000) { budget.since = now; budget.count = 0 }
  check(budget.count < maximum, 'Hourly provider request budget reached')
  budget.count++
  await atomicWrite(filename, `${JSON.stringify(budget)}\n`)
  return budget.count
}

export async function hashFile(filename) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

export async function runProcess(command, args, { cwd, env = process.env, timeoutMs = 300000, label = path.basename(command), log = () => {} } = {}) {
  const child = new Child(command, args, { cwd, env, label, log })
  let result
  try { result = await withTimeout(child.closed, timeoutMs, `${label} timed out`) }
  catch (error) {
    await child.stop(5000, 'SIGTERM')
    throw error
  }
  check(result.code === 0, `${label} failed with exit code ${result.code ?? 'signal'}`)
  return result
}
