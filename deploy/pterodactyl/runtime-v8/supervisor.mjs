import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import {
  Child,
  Rcon,
  chatAuthorized,
  check,
  cleanString,
  describeChatPlayers,
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

  const factorioUsername = cleanString(env.FACTORIO_USERNAME ?? raw.factorioUsername ?? '', 'FACTORIO_USERNAME', 128)
  const factorioToken = cleanString(env.FACTORIO_TOKEN ?? '', 'FACTORIO_TOKEN', 128)
  check((factorioUsername === '') === (factorioToken === ''), 'FACTORIO_USERNAME and FACTORIO_TOKEN must both be set or both left blank')

  const config = {
    actorMode,
    chatPlayers: parseChatPlayers(cleanString(chatPlayersSource, 'AIRI_CHAT_PLAYERS', 512)),
    save: cleanString(env.SAVE_NAME ?? raw.save ?? '', 'SAVE_NAME', 160),
    model: cleanString(env.OPENAI_MODEL ?? raw.model ?? 'gpt-5.6', 'OPENAI_MODEL', 200),
    base: env.OPENAI_API_BASEURL ?? raw.providerUrl ?? 'https://api.openai.com/v1',
    key: env.OPENAI_API_KEY ?? '',
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

export function seedConfigFromEnv(env = process.env) {
  const config = { actorMode: env.AIRI_ACTOR_MODE ?? 'npc' }
  if (env.AIRI_CHAT_PLAYERS) config.chatPlayers = env.AIRI_CHAT_PLAYERS
  else if (env.AIRI_CHAT_PLAYER) config.chatPlayers = env.AIRI_CHAT_PLAYER
  else if (env.AIRI_PLAYER) config.chatPlayers = env.AIRI_PLAYER
  if (env.SAVE_NAME) config.save = env.SAVE_NAME
  if (env.OPENAI_MODEL) config.model = env.OPENAI_MODEL
  if (env.OPENAI_API_BASEURL) config.providerUrl = env.OPENAI_API_BASEURL
  if (env.MAX_PROVIDER_REQUESTS_PER_HOUR) config.maxProviderRequestsPerHour = Number(env.MAX_PROVIDER_REQUESTS_PER_HOUR)
  if (env.SHUTDOWN_TIMEOUT_MS) config.shutdownTimeoutMs = Number(env.SHUTDOWN_TIMEOUT_MS)
  if (env.FACTORIO_USERNAME) config.factorioUsername = env.FACTORIO_USERNAME
  return config
}

export function installedAppRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..')
}

function parseStatus(text) {
  let value
  try { value = JSON.parse(String(text).trim()) }
  catch { throw new DeploymentError('Invalid airi_deployment status JSON') }
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid airi_deployment status')
  return value
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
    this.lastStatus = null
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
    this.lastStatus = status
    return status
  }

  async ensureAuthorization() {
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
      this.lastStatus = current
      return current
    }

    if (this.agent?.active) {
      this.agent.cancel()
      this.log('NPC identity/session changed; active model turn cancelled before rebind')
    }
    return this.bindNpc()
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
    })

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
      provider: (messages, context) => this.provider({
        base: this.config.base,
        key: this.config.key,
        model: this.config.model,
        timeoutMs: 45000,
      }, messages, context),
      reserve: async () => {
        await this.ensureAuthorization()
        return reserveBudget(path.join(this.root, '.airi', 'provider-budget.json'), this.config.budget)
      },
      log: message => this.log(`[AIRI agent] ${redact(secrets, message)}`),
    })

    this.ready = true
    this.poll = setInterval(() => {
      if (!this.stopping) this.ensureAuthorization().catch(error => this.log(`NPC authorization health check failed: ${error.message}`))
    }, 2000)
    this.log(`AIRI Factorio ready; standalone NPC actor_id=${this.lastStatus.actor_id}, chat=${describeChatPlayers(this.config.chatPlayers)}`)
    return this.lastStatus
  }

  queueEvent(fn) {
    this.eventQueue = this.eventQueue.then(fn).catch(error => {
      this.log(error instanceof Error ? error.message : String(error))
    })
    return this.eventQueue
  }

  async printChat(message) {
    if (!message || !this.rcon || this.stopping) return
    const clean = String(message).replace(/[\r\n]+/g, ' ').slice(0, 2000)
    await this.rcon.command(`/silent-command game.print(${luaString(`[AIRI] ${clean}`)})`)
  }

  onGameLine(line) {
    if (!this.ready || this.stopping || !this.agent) return
    const chat = line.match(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CHAT\] ([^:\r\n]+): !airi (.{1,4000})$/)
    if (chat && chatAuthorized(this.config.chatPlayers, chat[1])) {
      const text = chat[2].trim()
      this.queueEvent(async () => {
        await this.ensureAuthorization()
        if (text.toLowerCase() === 'stop') {
          this.agent.cancel()
          await this.rcon.command('/silent-command remote.call("airi_deployment","cancel")')
          await this.printChat('Cancelled AIRI work.')
          return
        }
        const result = await this.agent.request(text)
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      })
      return
    }

    if (line.includes('[AUTORIO] All operations completed') && Date.now() - this.lastCompletionAt > 250) {
      this.lastCompletionAt = Date.now()
      this.queueEvent(async () => {
        if (!this.agent.active) return
        await this.ensureAuthorization()
        const result = await this.agent.completed()
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      })
      return
    }

    if (line.includes('[AUTORIO] [ERROR]')) {
      this.agent.cancel()
      this.log('[AIRI agent] Autorio reported an error; active model turn cancelled')
    }
  }

  stop(reason = 'requested') {
    if (this.stopPromise) return this.stopPromise
    this.expectedStop = ['requested', 'signal', 'console'].includes(reason)
    this.stopping = true
    this.ready = false
    if (this.poll) clearInterval(this.poll)
    this.agent?.cancel()
    this.stopPromise = (async () => {
      let clean = true
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
  await verifyManifest(app)
  await directory(path.join(root, '.airi'))
  await directory(path.join(root, '.airi', 'tmp'))
  const raw = await readJson(path.join(root, 'airi-config.json'), {})
  const config = configuration(raw)
  const game = path.join(app, 'factorio')
  await regularFile(path.join(game, 'bin', 'x64', 'factorio'))
  const work = await fsp.mkdtemp(path.join(root, '.airi', 'run-'))
  let session
  let requestedStop = false
  const log = message => console.log(`[${new Date().toISOString()}] [AIRI Factorio] ${message}`)

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
