import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import {
  atomicWrite,
  Child,
  Rcon,
  chatAuthorized,
  check,
  cleanString,
  describeChatPlayers,
  describeRelease,
  DeploymentError,
  directory,
  freeTcpPort,
  hashFile,
  nonce,
  parseChatPlayers,
  readJson,
  redact,
  regularFile,
  reserveBudget,
  safeInteger,
} from './common.mjs'
import { createSave, prepareGameConfig, prepareMods, prepareServerSettings, selectSave } from './game-files.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerEndpoint, providerRequest } from './provider.mjs'
import { configureNpcSession } from './supervisor-adapter.mjs'
import { luaString } from './structured-policy.mjs'

export function configuration(raw = {}, env = process.env) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'airi-config.json must be an object')
  const actorMode = env.AIRI_ACTOR_MODE ?? raw.actorMode ?? 'npc'
  check(actorMode === 'npc', 'This v8 egg currently supports AIRI_ACTOR_MODE=npc only')

  const legacyChat = env.AIRI_PLAYER ?? raw.player ?? ''
  const legacySingleChatPlayer = env.AIRI_CHAT_PLAYER ?? raw.chatPlayer ?? legacyChat
  const chatPlayersSource = env.AIRI_CHAT_PLAYERS ?? raw.chatPlayers ?? legacySingleChatPlayer

  const factorioUsername = cleanString(env.FACTORIO_USERNAME ?? '', 'FACTORIO_USERNAME', 128)
  const factorioToken = cleanString(env.FACTORIO_TOKEN ?? '', 'FACTORIO_TOKEN', 128)
  check((factorioUsername === '') === (factorioToken === ''), 'FACTORIO_USERNAME and FACTORIO_TOKEN must both be set or both left blank')

  const config = {
    actorMode,
    chatPlayers: parseChatPlayers(cleanString(chatPlayersSource, 'AIRI_CHAT_PLAYERS', 512)),
    save: cleanString(env.SAVE_NAME ?? raw.save ?? '', 'SAVE_NAME', 160),
    model: cleanString(env.OPENAI_MODEL ?? raw.model ?? 'replace-me', 'OPENAI_MODEL', 200),
    base: env.OPENAI_API_BASEURL ?? raw.providerUrl ?? 'https://provider.invalid/v1',
    key: env.OPENAI_API_KEY ?? '',
    providerTimeoutMs: safeInteger(env.PROVIDER_TIMEOUT_MS ?? raw.providerTimeoutMs ?? 120000, 'PROVIDER_TIMEOUT_MS', 1000, 600000),
    gamePort: safeInteger(env.SERVER_PORT ?? raw.gamePort ?? 34197, 'SERVER_PORT', 1024, 65535),
    budget: safeInteger(env.MAX_PROVIDER_REQUESTS_PER_HOUR ?? raw.maxProviderRequestsPerHour ?? 30, 'MAX_PROVIDER_REQUESTS_PER_HOUR', 1, 1200),
    stopMs: safeInteger(env.SHUTDOWN_TIMEOUT_MS ?? raw.shutdownTimeoutMs ?? 60000, 'SHUTDOWN_TIMEOUT_MS', 1000, 300000),
    factorio: {
      username: factorioUsername,
      token: factorioToken,
      public: factorioUsername !== '' && factorioToken !== '',
    },
  }
  check(typeof config.key === 'string' && config.key.trim().length > 0 && !/[\r\n\0]/.test(config.key), 'OPENAI_API_KEY is missing or malformed')
  providerEndpoint(config.base)
  return config
}

export const AIRI_CONFIG_DEFAULTS = {
  actorMode: 'npc',
  chatPlayers: '',
  providerUrl: 'https://provider.invalid/v1',
  model: 'replace-me',
  save: '',
  providerTimeoutMs: 120000,
  gamePort: 34197,
  maxProviderRequestsPerHour: 30,
  shutdownTimeoutMs: 60000,
}

export function migrateConfig(raw = {}, env = process.env) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'airi-config.json must be an object')
  const next = { ...AIRI_CONFIG_DEFAULTS, ...raw }
  next.providerUrl = env.OPENAI_API_BASEURL ?? raw.providerUrl ?? AIRI_CONFIG_DEFAULTS.providerUrl
  next.model = env.OPENAI_MODEL ?? raw.model ?? AIRI_CONFIG_DEFAULTS.model
  delete next.factorioUsername
  return next
}

export async function migrateConfigFile(filename, env = process.env) {
  const raw = await readJson(filename, {})
  const next = migrateConfig(raw, env)
  if (JSON.stringify(next) !== JSON.stringify(raw)) await atomicWrite(filename, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export function installedAppRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..')
}

export function routeNpcRequest(text, npcName = '') {
  const trimmed = String(text ?? '').trim()
  if (!trimmed || !npcName) return trimmed
  const separator = trimmed.indexOf(' ')
  if (separator < 0) return trimmed
  const candidate = trimmed.slice(0, separator)
  if (candidate.localeCompare(npcName, undefined, { sensitivity: 'accent' }) !== 0) return trimmed
  return trimmed.slice(separator + 1).trim()
}

function parseStatus(text) {
  let value
  try { value = JSON.parse(String(text).trim()) }
  catch { throw new DeploymentError('Invalid airi_deployment status JSON') }
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid airi_deployment status')
  return value
}

function expectedCancellation(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'Provider request cancelled'
    || message === 'Model turn was cancelled or superseded'
    || message === 'NPC actor epoch changed; stale model turn cancelled'
}

export class Session {
  constructor({ root, app, game, config, save, settingsFile, modDir, ini, log = console.log, provider = providerRequest, startupMs = 120000 }) {
    Object.assign(this, { root, app, game, config, save, settingsFile, modDir, ini, log, provider, startupMs })
    this.session = nonce() + nonce()
    this.rconPassword = nonce() + nonce()
    this.rcon = null
    this.gameChild = null
    this.agent = null
    this.stopping = false
    this.stopPromise = null
    this.ready = false
    this.expectedStop = false
    this.eventQueue = Promise.resolve()
    this.lastCompletionAt = 0
    this.lastErrorAt = 0
    this.lastStatus = null
    this.authorizationPromise = null
    this.npcName = 'AIRI'
    this.npcId = 'airi'
  }

  updateNpcIdentity(status) {
    if (typeof status?.actor_name === 'string' && status.actor_name.length > 0 && status.actor_name.length <= 200) {
      this.npcName = status.actor_name
    }
    if (typeof status?.npc_id === 'string' && status.npc_id.length > 0 && status.npc_id.length <= 200) {
      this.npcId = status.npc_id
    }
  }

  cleanEnv() {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/(?:OPENAI|API_KEY|TOKEN|PASSWORD|RCON)/i.test(key)) delete env[key]
    env.HOME = this.root
    env.TMPDIR = path.join(this.root, '.airi', 'tmp')
    return env
  }

  gameArgs(rconPort) {
    return [
      '--config', this.ini,
      '--mod-directory', this.modDir,
      '--start-server', this.save,
      '--server-settings', this.settingsFile,
      '--bind', `0.0.0.0:${this.config.gamePort}`,
      '--rcon-bind', `127.0.0.1:${rconPort}`,
      '--rcon-password', this.rconPassword,
    ]
  }

  async rawStatus() {
    check(this.rcon, 'RCON is not connected')
    return parseStatus(await this.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("airi_deployment","status")))'))
  }

  async bindNpc() {
    const status = await configureNpcSession(this.rcon, this.session)
    this.updateNpcIdentity(status)
    this.lastStatus = status
    return status
  }

  async ensureAuthorization() {
    if (this.authorizationPromise) return this.authorizationPromise
    this.authorizationPromise = (async () => {
      const current = await this.rawStatus()
      const stable = current.revision === 'airi-deploy-v8-npc-staging'
        && current.session === this.session
        && current.mode === 'npc'
        && current.allowed === true
        && current.actor_kind === 'standalone_character'
        && Number.isSafeInteger(current.actor_id)
        && current.actor_id > 0
        && Number.isSafeInteger(current.epoch)
        && current.epoch > 0
      if (stable) {
        this.updateNpcIdentity(current)
        this.lastStatus = current
        return current
      }

      if (this.agent?.active) {
        if (typeof this.agent.pausePersistentPlan === 'function') await this.agent.pausePersistentPlan('npc_identity_or_session_changed')
        else this.agent.cancel()
        this.log('NPC identity/session changed; active model turn paused before rebind')
      }
      return this.bindNpc()
    })()

    try {
      return await this.authorizationPromise
    }
    finally {
      this.authorizationPromise = null
    }
  }

  async start() {
    const rconPort = await freeTcpPort([this.config.gamePort])
    const secrets = [this.config.key, this.rconPassword, this.session, this.config.factorio.token]
    const gameLog = line => {
      this.log(redact(secrets, line))
      this.onGameLine(line)
    }
    this.gameChild = new Child(path.join(this.game, 'bin', 'x64', 'factorio'), this.gameArgs(rconPort), {
      cwd: this.root,
      env: this.cleanEnv(),
      label: 'Factorio',
      log: gameLog,
    }).attachInput(process.stdin)

    const deadline = Date.now() + this.startupMs
    while (Date.now() < deadline) {
      check(this.gameChild.alive(), 'Factorio exited before RCON became ready')
      const rcon = new Rcon(rconPort, this.rconPassword, 2500)
      try {
        await rcon.connect()
        rcon.timeout = 10000
        this.rcon = rcon
        break
      }
      catch {
        rcon.close()
        await delay(200)
      }
    }
    check(this.rcon, 'Timed out waiting for authenticated Factorio RCON')
    const version = await this.rcon.command('/version')
    check(/2\.0\.\d+/.test(version), 'Authenticated Factorio RCON version probe failed')
    await this.bindNpc()

    const prompt = await fsp.readFile(path.join(this.app, 'src', 'prompt.md'), 'utf8')
    this.agent = new NpcAgentLoop({
      rcon: this.rcon,
      systemPrompt: prompt,
      npcId: this.npcId,
      stateFile: path.join(this.root, '.airi', 'npc-state.json'),
      provider: (messages, context) => this.provider({
        base: this.config.base,
        key: this.config.key,
        model: this.config.model,
        timeoutMs: this.config.providerTimeoutMs,
      }, messages, context),
      reserve: async () => reserveBudget(path.join(this.root, '.airi', 'provider-budget.json'), this.config.budget),
      log: message => this.log(`[AIRI agent] ${redact(secrets, message)}`),
    })
    await this.agent.loadPersistentState()

    this.ready = true
    this.poll = setInterval(() => {
      if (!this.stopping) this.ensureAuthorization().catch(error => this.log(`NPC authorization health check failed: ${error.message}`))
    }, 2000)
    this.log(`AIRI Factorio ready; npc=${this.npcName} (${this.npcId}), actor_id=${this.lastStatus.actor_id}, chat=${describeChatPlayers(this.config.chatPlayers)}`)
    return this.lastStatus
  }

  queueEvent(fn, { reportError = false } = {}) {
    this.eventQueue = this.eventQueue.then(fn).catch(async error => {
      const message = error instanceof Error ? error.message : String(error)
      this.log(message)
      if (reportError && !expectedCancellation(error)) {
        try { await this.printChat(`Request failed: ${message}`) }
        catch (printError) { this.log(`Unable to report AIRI error in chat: ${printError instanceof Error ? printError.message : printError}`) }
      }
    })
    return this.eventQueue
  }

  async printChat(message) {
    if (!message || !this.rcon || this.stopping) return
    const clean = String(message).replace(/[\r\n]+/g, ' ').slice(0, 2000)
    const label = this.npcName && this.npcName !== 'AIRI' ? `[AIRI/${this.npcName}]` : '[AIRI]'
    await this.rcon.command(`/silent-command game.print(${luaString(`${label} ${clean}`)})`)
  }

  onGameLine(line) {
    if (!this.ready || this.stopping || !this.agent) return
    const chat = line.match(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CHAT\] ([^:\r\n]+): !airi (.{1,4000})$/)
    if (chat && chatAuthorized(this.config.chatPlayers, chat[1])) {
      const text = routeNpcRequest(chat[2], this.npcName)
      if (!text) return
      const stop = text.toLowerCase() === 'stop'
      if (stop) this.agent.cancel('user_stop_immediate')
      this.queueEvent(async () => {
        if (stop) {
          if (typeof this.agent.pausePersistentPlan === 'function') await this.agent.pausePersistentPlan('user_stop')
          await this.ensureAuthorization()
          await this.rcon.command('/silent-command remote.call("airi_deployment","cancel")')
          await this.printChat('Paused the current AIRI plan and cancelled active Autorio work. Say continue/resume when you want me to pick it back up.')
          return
        }
        await this.ensureAuthorization()
        const result = await this.agent.request(text, { sender: chat[1] })
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      }, { reportError: true })
      return
    }

    const recovery = line.match(/\[AUTORIO\] Recovered standalone NPC actor_id=(\d+) -> (\d+) without inventory transfer/)
    if (recovery) {
      this.queueEvent(async () => {
        if (typeof this.agent.pausePersistentPlan === 'function') await this.agent.pausePersistentPlan('actor_replaced')
        else this.agent.cancel()
        await this.ensureAuthorization()
        await this.printChat(`I was killed or lost my body and respawned. Previous actor ${recovery[1]}, replacement actor ${recovery[2]}. The interrupted plan was paused and can be resumed after I re-observe the world.`)
      })
      return
    }

    if (line.includes('[AUTORIO] All operations completed') && Date.now() - this.lastCompletionAt > 250) {
      this.lastCompletionAt = Date.now()
      this.queueEvent(async () => {
        if (!this.agent.active) return
        await this.ensureAuthorization()
        if (!this.agent.active) return
        const result = await this.agent.completed()
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      }, { reportError: true })
      return
    }

    const autorioError = line.match(/\[AUTORIO\] \[ERROR\] (.+)$/)
    if (autorioError && Date.now() - this.lastErrorAt > 250) {
      this.lastErrorAt = Date.now()
      this.queueEvent(async () => {
        if (!this.agent.active) {
          this.log(`[AIRI agent] Autorio error with no active model goal: ${autorioError[1]}`)
          return
        }
        await this.ensureAuthorization()
        if (!this.agent.active) return
        const result = typeof this.agent.failed === 'function' ? await this.agent.failed(autorioError[1]) : null
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      }, { reportError: true })
    }
  }

  stop(reason = 'requested') {
    if (this.stopPromise) return this.stopPromise
    this.expectedStop = ['requested', 'signal', 'console'].includes(reason)
    this.stopping = true
    this.ready = false
    if (this.poll) clearInterval(this.poll)
    this.stopPromise = (async () => {
      let clean = true
      if (this.agent?.active) {
        try {
          if (typeof this.agent.pausePersistentPlan === 'function') await this.agent.pausePersistentPlan(`server_stop_${reason}`)
          else this.agent.cancel()
        }
        catch (error) {
          clean = false
          this.log(`Unable to persist active AIRI plan before shutdown: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (this.rcon && this.gameChild?.alive()) {
        this.rcon.timeout = Math.min(this.config.stopMs, 30000)
        try { await this.rcon.command('/silent-command remote.call("airi_deployment","cancel")') }
        catch (error) { clean = false; this.log(`Shutdown cancel command failed: ${error instanceof Error ? error.message : error}`) }
        try { await this.rcon.command('/server-save') }
        catch (error) { clean = false; this.log(`Shutdown server-save command failed: ${error instanceof Error ? error.message : error}`) }
      }
      if (this.gameChild) {
        const stopped = await this.gameChild.stop(this.config.stopMs, 'SIGINT')
        if (stopped.forced || stopped.result?.code !== 0) clean = false
      }
      this.rcon?.close()
      this.log(clean ? 'AIRI Factorio stopped cleanly' : 'AIRI Factorio shutdown required fallback handling')
      return clean
    })()
    return this.stopPromise
  }
}

export async function verifyManifest(app) {
  const manifest = await readJson(path.join(app, 'manifest.json'))
  check(manifest?.revision === 'airi-pterodactyl-v8' && manifest.files && typeof manifest.files === 'object', 'Missing v8 release manifest')
  for (const [name, expected] of Object.entries(manifest.files)) {
    check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), `Invalid manifest digest: ${name}`)
    const filename = path.join(app, name)
    await regularFile(filename)
    check(await hashFile(filename) === expected, `Release file integrity failed: ${name}`)
  }
  return manifest
}

async function main() {
  check(os.arch() === 'x64', 'AIRI Pterodactyl v8 requires amd64')
  const root = path.resolve(process.env.CONTAINER_ROOT || '/home/container')
  const app = installedAppRoot()
  const manifest = await verifyManifest(app)
  await directory(path.join(root, '.airi'))
  await directory(path.join(root, '.airi', 'tmp'))
  const raw = await migrateConfigFile(path.join(root, 'airi-config.json'))
  const config = configuration(raw)
  const game = path.join(app, 'factorio')
  await regularFile(path.join(game, 'bin', 'x64', 'factorio'))
  const work = await fsp.mkdtemp(path.join(root, '.airi', 'run-'))
  let session
  let requestedStop = false
  const log = message => console.log(`[${new Date().toISOString()}] [AIRI Factorio] ${message}`)
  log(describeRelease(manifest))

  const handleSignal = () => {
    requestedStop = true
    session?.stop('signal')
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, handleSignal)

  try {
    const modDir = await prepareMods(root, app, work)
    const settingsFile = await prepareServerSettings(root, game, config.factorio)
    const ini = await prepareGameConfig(work, game, root)
    const selected = await selectSave(root, config.save)
    if (selected.create) {
      log(`Creating initial save ${path.basename(selected.filename)}`)
      await createSave(selected.filename, game, modDir, ini, root, log)
    }
    session = new Session({ root, app, game, config, save: selected.filename, settingsFile, modDir, ini, log })
    try {
      await session.start()
    }
    catch (error) {
      log(`Startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      throw error
    }
    const result = await session.gameChild.closed
    if (!requestedStop) {
      log(`Factorio exited unexpectedly: ${JSON.stringify(result)}`)
      process.exitCode = 1
    }
  }
  finally {
    if (session && !session.stopping) await session.stop(requestedStop ? 'requested' : 'unexpected child exit')
    else if (session?.stopPromise) await session.stopPromise
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, handleSignal)
    await fsp.rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[AIRI Factorio] ${error instanceof Error ? error.message : 'Startup failed'}`)
    process.exitCode = 1
  })
}
