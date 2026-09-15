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
  withTimeout,
} from './common.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { createSave, prepareGameConfig, prepareMods, prepareServerSettings, selectSave } from './game-files.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerEndpoint, providerRequest } from './provider.mjs'
import { configureNpcSession } from './supervisor-adapter.mjs'
import { luaString } from './structured-policy.mjs'

const UI_CONTROL_MARKER = '[AIRI_UI_CONTROL]'
const UI_CONTROL_ACTIONS = new Set(['pause', 'terminate', 'follow', 'stop_follow'])
const UI_PROMPT_MARKER = '[AIRI_UI_PROMPT]'
const UI_PROMPT_MAX_CHARS = 4000

const RUNTIME_RELIABILITY_GUIDANCE = `
## Runtime reliability additions

getTechnology returns an exact research_trigger object for gameplay-trigger technologies when Factorio exposes one. Use the returned trigger fields such as item/count, entity, or fluid/amount; do not guess a trigger from remembered Factorio knowledge. After performing an exact gameplay trigger, re-read getTechnology. If it is still incomplete, re-observe the trigger/state or report a blocker instead of repeatedly waiting and hoping the trigger registers.

Natural navigation obstacle clearing is controlled deterministically by the runtime. It is enabled by default for trees and natural rocks only, and is disabled for a request when the human explicitly asks AIRI not to cut trees, mine rocks, or auto-clear obstacles. Never reinterpret this as permission to remove player-built structures.
`.trim()

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
  const actorMode = cleanString(env.AIRI_ACTOR_MODE ?? raw.actorMode ?? AIRI_CONFIG_DEFAULTS.actorMode, 'AIRI_ACTOR_MODE', 32)
  check(actorMode === 'npc', 'This v8 egg currently supports AIRI_ACTOR_MODE=npc only')
  const chatPlayers = cleanString(
    env.AIRI_CHAT_PLAYERS
      ?? env.AIRI_CHAT_PLAYER
      ?? env.AIRI_PLAYER
      ?? raw.chatPlayers
      ?? raw.chatPlayer
      ?? raw.player
      ?? AIRI_CONFIG_DEFAULTS.chatPlayers,
    'AIRI_CHAT_PLAYERS',
    512,
  )
  const next = {
    actorMode,
    chatPlayers,
    providerUrl: env.OPENAI_API_BASEURL ?? raw.providerUrl ?? AIRI_CONFIG_DEFAULTS.providerUrl,
    model: cleanString(env.OPENAI_MODEL ?? raw.model ?? AIRI_CONFIG_DEFAULTS.model, 'OPENAI_MODEL', 200),
    save: cleanString(env.SAVE_NAME ?? raw.save ?? AIRI_CONFIG_DEFAULTS.save, 'SAVE_NAME', 160),
    providerTimeoutMs: safeInteger(
      env.PROVIDER_TIMEOUT_MS ?? raw.providerTimeoutMs ?? AIRI_CONFIG_DEFAULTS.providerTimeoutMs,
      'PROVIDER_TIMEOUT_MS',
      1000,
      600000,
    ),
    gamePort: safeInteger(env.SERVER_PORT ?? raw.gamePort ?? AIRI_CONFIG_DEFAULTS.gamePort, 'SERVER_PORT', 1024, 65535),
    maxProviderRequestsPerHour: safeInteger(
      env.MAX_PROVIDER_REQUESTS_PER_HOUR ?? raw.maxProviderRequestsPerHour ?? AIRI_CONFIG_DEFAULTS.maxProviderRequestsPerHour,
      'MAX_PROVIDER_REQUESTS_PER_HOUR',
      1,
      1200,
    ),
    shutdownTimeoutMs: safeInteger(
      env.SHUTDOWN_TIMEOUT_MS ?? raw.shutdownTimeoutMs ?? AIRI_CONFIG_DEFAULTS.shutdownTimeoutMs,
      'SHUTDOWN_TIMEOUT_MS',
      1000,
      300000,
    ),
  }
  providerEndpoint(next.providerUrl)
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

export function navigationObstaclePolicy(text) {
  const normalized = String(text ?? '').trim().toLocaleLowerCase()
  const denyPhrases = [
    '不要自动清障', '不要清障', '别清障', '不要砍树', '别砍树', '不要自动砍树', '不要挖树',
    '不要挖石头', '别挖石头', '不要挖岩石', '不要破坏树', '不要破坏树木',
    "don't clear obstacles", 'do not clear obstacles', 'no automatic obstacle clearing',
    "don't cut trees", 'do not cut trees', "don't mine rocks", 'do not mine rocks',
    'preserve trees', 'leave the trees alone',
  ]
  const denied = denyPhrases.some(phrase => normalized.includes(phrase))
  if (denied) return { shouldUpdate: true, clearObstacles: false }

  const continuation = ['continue', 'resume', '继续', '继续吧', '继续做', '接着', '接着做']
    .some(prefix => normalized === prefix || normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}，`) || normalized.startsWith(`${prefix},`))
  if (continuation) return { shouldUpdate: false, clearObstacles: true }
  return { shouldUpdate: true, clearObstacles: true }
}

function uiText(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function exactUiObjectKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key))
}

export function parseUiControlLine(line) {
  const input = String(line ?? '')
  if (!input.includes(UI_CONTROL_MARKER) || input.includes('[CHAT]')) return undefined
  const marker = input.lastIndexOf(UI_CONTROL_MARKER)
  const raw = input.slice(marker + UI_CONTROL_MARKER.length).trim()
  if (!raw || raw.length > 1024) return undefined
  let value
  try { value = JSON.parse(raw) }
  catch { return undefined }
  if (!exactUiObjectKeys(value, ['version', 'action', 'player_index', 'player_name', 'tick'])) return undefined
  if (value.version !== 1 || !UI_CONTROL_ACTIONS.has(value.action)) return undefined
  if (!Number.isSafeInteger(value.player_index) || value.player_index < 1 || value.player_index > 1_000_000) return undefined
  if (!Number.isSafeInteger(value.tick) || value.tick < 0) return undefined
  if (typeof value.player_name !== 'string' || value.player_name.length < 1 || value.player_name.length > 128 || /[\x00-\x1f\x7f]/.test(value.player_name)) return undefined
  return {
    version: 1,
    action: value.action,
    player_index: value.player_index,
    player_name: value.player_name,
    tick: value.tick,
  }
}

export function parseUiPromptLine(line) {
  const input = String(line ?? '')
  if (!input.includes(UI_PROMPT_MARKER) || input.includes('[CHAT]')) return undefined
  const marker = input.lastIndexOf(UI_PROMPT_MARKER)
  const raw = input.slice(marker + UI_PROMPT_MARKER.length).trim()
  if (!raw || raw.length > 16384) return undefined
  let value
  try { value = JSON.parse(raw) }
  catch { return undefined }
  if (!exactUiObjectKeys(value, ['version', 'player_index', 'player_name', 'text', 'tick'])) return undefined
  if (value.version !== 1) return undefined
  if (!Number.isSafeInteger(value.player_index) || value.player_index < 1 || value.player_index > 1_000_000) return undefined
  if (!Number.isSafeInteger(value.tick) || value.tick < 0) return undefined
  if (typeof value.player_name !== 'string' || value.player_name.length < 1 || value.player_name.length > 128 || /[\x00-\x1f\x7f]/.test(value.player_name)) return undefined
  if (typeof value.text !== 'string') return undefined
  const text = value.text.trim()
  if (text.length < 1 || text.length > UI_PROMPT_MAX_CHARS || /[\x00-\x1f\x7f]/.test(text)) return undefined
  return {
    version: 1,
    player_index: value.player_index,
    player_name: value.player_name,
    text,
    tick: value.tick,
  }
}

function parseStoredOperation(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(' ')
  if (separator < 1) return undefined
  const name = value.slice(0, separator)
  let args
  try { args = JSON.parse(value.slice(separator + 1)) }
  catch { return undefined }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  return { name, args }
}

function wantedCandidate(operation) {
  const { name, args } = operation
  if (name === 'place_entity' && typeof args.entity_name === 'string') {
    return { name: args.entity_name, count: 1, reason: 'planned placement' }
  }
  if (name === 'craft_item' && typeof args.item_name === 'string') {
    return { name: args.item_name, count: Number.isSafeInteger(args.count) && args.count > 0 ? args.count : 1, reason: 'planned craft' }
  }
  if (['equip_weapon', 'equip_ammo', 'equip_armor'].includes(name) && typeof args.item_name === 'string') {
    return { name: args.item_name, count: 1, reason: 'planned equipment' }
  }
  if ((name === 'move_items' || name === 'move_items_exact') && args.to_entity === false && typeof args.item_name === 'string') {
    return { name: args.item_name, count: Number.isSafeInteger(args.max_count) && args.max_count > 0 ? args.max_count : 1, reason: 'planned pickup' }
  }
  if (name === 'move_items_with_player' && args.to_player === false && typeof args.item_name === 'string') {
    return { name: args.item_name, count: Number.isSafeInteger(args.max_count) && args.max_count > 0 ? args.max_count : 1, reason: 'requested from player' }
  }
  return undefined
}

export function deriveWantedItems(state) {
  const byName = new Map()
  for (const raw of Array.isArray(state?.last_operations) ? state.last_operations.slice(-16) : []) {
    const operation = parseStoredOperation(raw)
    const candidate = operation ? wantedCandidate(operation) : undefined
    if (!candidate) continue
    candidate.name = uiText(candidate.name, 200)
    if (!candidate.name) continue
    const previous = byName.get(candidate.name)
    if (!previous || candidate.count > previous.count) byName.set(candidate.name, candidate)
  }
  return [...byName.values()].slice(0, 16)
}

function activityKindFromEvidence(kind) {
  if (/error|failed|blocked/i.test(kind)) return 'blocker'
  if (/receipt|result|completed/i.test(kind)) return 'result'
  return 'observation'
}

export function deriveActivity(state) {
  if (!state || typeof state !== 'object') return []
  const entries = []
  const evidence = Array.isArray(state.task_board?.evidence) ? state.task_board.evidence.slice(-4) : []
  for (const item of evidence) {
    const summary = uiText(item?.summary, 1000)
    if (summary) entries.push({ kind: activityKindFromEvidence(uiText(item?.kind, 64)), text: summary })
  }
  const chat = uiText(state.last_chat_message, 1000)
  if (chat) entries.push({ kind: 'decision', text: chat })
  for (const operation of Array.isArray(state.last_operations) ? state.last_operations.slice(-6) : []) {
    const text = uiText(operation, 1000)
    if (text) entries.push({ kind: 'action', text })
  }
  const blocker = uiText(state.blocker, 500)
  if (blocker) entries.push({ kind: 'blocker', text: blocker })
  const pauseReason = uiText(state.pause_reason, 300)
  if (pauseReason) entries.push({ kind: 'system', text: `Paused: ${pauseReason}` })
  return entries.slice(-12)
}

export function taskBoardUiSnapshot(state) {
  const board = state?.task_board
  if (!board || board.kind !== 'task_board_lite' || !Array.isArray(board.steps)) return undefined
  return {
    goal_id: String(board.goal_id ?? state.goal_id ?? '').slice(0, 100),
    objective: String(state.objective ?? '').slice(0, 500),
    status: board.status,
    blocker: String(board.blocker ?? '').slice(0, 500),
    pause_reason: String(board.pause_reason ?? '').slice(0, 300),
    completed_count: board.completed_count,
    total_steps: board.total_steps,
    active_index: board.active_index,
    steps: board.steps.slice(0, 30).map(step => ({
      id: String(step?.id ?? '').slice(0, 80),
      description: String(step?.description ?? '').slice(0, 500),
      status: step?.status,
    })),
    activity: deriveActivity(state),
    wanted_items: deriveWantedItems(state),
  }
}

async function stopWorldWork(session) {
  await session.ensureAuthorization()
  await session.rcon.command('/silent-command remote.call("autorio_operations","stop_follow_player")')
  await session.rcon.command('/silent-command remote.call("airi_deployment","cancel")')
}

async function pausePlanIfPresent(session, reason) {
  const state = session.currentPlanState?.()
  if (!state || state.status === 'completed' || state.status === 'paused') return state
  if (typeof session.agent?.pausePersistentPlan !== 'function') {
    session.agent?.cancel?.(reason)
    return state
  }
  return session.agent.pausePersistentPlan(reason)
}

async function terminatePlan(session, reason) {
  const agent = session.agent
  if (!agent) return undefined
  await agent.loadPersistentState?.()
  const key = typeof agent.activePlanKey === 'function' ? agent.activePlanKey() : `npc:${session.npcId ?? 'airi'}`
  const previous = agent.memory?.terminatePlan?.(key, reason)
  agent.cancel?.(reason)
  await agent.persistState?.()
  return previous
}

export async function executeUiControl(session, event) {
  if (!session?.rcon || !session?.agent) return false

  if (event.action === 'pause') {
    const state = await pausePlanIfPresent(session, 'ui_pause')
    await stopWorldWork(session)
    if (state) await session.syncTaskBoardUi(state)
    await session.printChat('Paused the current AIRI plan and stopped active work. Use continue/resume when you want it to continue.')
    return true
  }

  if (event.action === 'terminate') {
    await terminatePlan(session, 'ui_terminate')
    await stopWorldWork(session)
    await session.clearTaskBoardUi()
    await session.printChat('Terminated the current AIRI goal. Its durable plan was discarded and will not resume.')
    return true
  }

  if (event.action === 'follow') {
    const state = await pausePlanIfPresent(session, 'ui_follow')
    await stopWorldWork(session)
    await session.ensureAuthorization()
    const response = await session.rcon.command(`/silent-command local ok,msg=remote.call("autorio_operations","follow_player",${luaString(event.player_name)},4); rcon.print(tostring(ok).."|"..tostring(msg))`)
    if (state) await session.syncTaskBoardUi(state)
    await session.printChat(`Follow mode requested for ${event.player_name} at about 4 tiles.${response ? ` ${String(response).slice(0, 240)}` : ''}`)
    return true
  }

  if (event.action === 'stop_follow') {
    await session.ensureAuthorization()
    await session.rcon.command('/silent-command remote.call("autorio_operations","stop_follow_player")')
    await session.printChat('Stopped following. Any previously paused plan remains paused until you explicitly continue/resume it.')
    return true
  }

  return false
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

function providerRecoveryExhausted(message) {
  return /^Provider response recovery exhausted after \d+ attempts:/.test(String(message))
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
        if (typeof this.agent.pausePersistentPlan === 'function') {
          const state = await this.agent.pausePersistentPlan('npc_identity_or_session_changed')
          await this.syncTaskBoardUi(state)
        }
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

  currentPlanState() {
    if (!this.agent?.memory?.currentPlan) return undefined
    const key = typeof this.agent.activePlanKey === 'function' ? this.agent.activePlanKey() : `npc:${this.npcId}`
    return this.agent.memory.currentPlan(key)
  }

  async clearTaskBoardUi() {
    if (!this.rcon) return false
    try {
      await this.rcon.command('/silent-command remote.call("autorio_task_board","clear")')
      return true
    }
    catch (error) {
      this.log(`Task Board UI clear failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  async syncTaskBoardUi(state = this.currentPlanState()) {
    if (!this.rcon) return false
    const snapshot = taskBoardUiSnapshot(state)
    if (!snapshot) return this.clearTaskBoardUi()
    try {
      const json = JSON.stringify(snapshot)
      await this.rcon.command(`/silent-command remote.call("autorio_task_board","set_snapshot",helpers.json_to_table(${luaString(json)}))`)
      return true
    }
    catch (error) {
      this.log(`Task Board UI sync failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  async applyNavigationObstaclePolicy(text) {
    if (!this.rcon) return
    const policy = navigationObstaclePolicy(text)
    if (!policy.shouldUpdate) return
    try {
      await this.rcon.command(`/silent-command remote.call("autorio_navigation","set_clear_obstacles",${policy.clearObstacles ? 'true' : 'false'})`)
      if (!policy.clearObstacles) this.log('Natural navigation obstacle clearing disabled by explicit user request')
    }
    catch (error) {
      this.log(`Navigation obstacle policy update failed: ${error instanceof Error ? error.message : error}`)
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
      systemPrompt: `${prompt}\n\n${RUNTIME_RELIABILITY_GUIDANCE}`,
      npcId: this.npcId,
      memory: new CanonicalTaskBoardMemory(),
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
    await this.syncTaskBoardUi()

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
      if (reportError && providerRecoveryExhausted(message) && this.agent) {
        try {
          const state = await this.agent.pausePersistentPlan(`provider_recovery_exhausted: ${message.slice(0, 240)}`)
          await this.syncTaskBoardUi(state)
          if (state) this.log('Canonical Task Board paused after provider response recovery exhaustion')
        }
        catch (pauseError) {
          this.log(`Unable to pause Task Board after provider recovery exhaustion: ${pauseError instanceof Error ? pauseError.message : pauseError}`)
        }
      }
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

  queuePlayerRequest(sender, rawText) {
    const text = routeNpcRequest(rawText, this.npcName)
    if (!text || !this.agent) return false
    const stop = text.toLowerCase() === 'stop'
    if (stop) this.agent.cancel('user_stop_immediate')
    this.queueEvent(async () => {
      if (stop) {
        const state = typeof this.agent.pausePersistentPlan === 'function'
          ? await this.agent.pausePersistentPlan('user_stop')
          : undefined
        if (state) await this.syncTaskBoardUi(state)
        await this.ensureAuthorization()
        await this.rcon.command('/silent-command remote.call("airi_deployment","cancel")')
        await this.printChat('Paused the current AIRI plan and cancelled active Autorio work. Say continue/resume when you want me to pick it back up.')
        return
      }
      await this.ensureAuthorization()
      await this.applyNavigationObstaclePolicy(text)
      const result = await this.agent.request(text, { sender })
      await this.syncTaskBoardUi()
      if (result?.chatMessage) await this.printChat(result.chatMessage)
    }, { reportError: true })
    return true
  }

  onGameLine(line) {
    if (!this.ready || this.stopping || !this.agent) return

    const uiControl = parseUiControlLine(line)
    if (uiControl) {
      if (!chatAuthorized(this.config.chatPlayers, uiControl.player_name)) {
        this.log(`[AIRI UI] Ignored unauthorized control action=${uiControl.action} player=${uiControl.player_name}`)
        return
      }
      this.queueEvent(async () => {
        await executeUiControl(this, uiControl)
      }, { reportError: true })
      return
    }

    const uiPrompt = parseUiPromptLine(line)
    if (uiPrompt) {
      if (!chatAuthorized(this.config.chatPlayers, uiPrompt.player_name)) {
        this.log(`[AIRI UI] Ignored unauthorized prompt player=${uiPrompt.player_name}`)
        return
      }
      this.queuePlayerRequest(uiPrompt.player_name, uiPrompt.text)
      return
    }

    const chat = line.match(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CHAT\] ([^:\r\n]+): !airi (.{1,4000})$/)
    if (chat && chatAuthorized(this.config.chatPlayers, chat[1])) {
      this.queuePlayerRequest(chat[1], chat[2])
      return
    }

    const recovery = line.match(/\[AUTORIO\] Recovered standalone NPC actor_id=(\d+) -> (\d+) without inventory transfer/)
    if (recovery) {
      this.queueEvent(async () => {
        if (typeof this.agent.pausePersistentPlan === 'function') {
          const state = await this.agent.pausePersistentPlan('actor_replaced')
          await this.syncTaskBoardUi(state)
        }
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
        await this.syncTaskBoardUi()
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
        await this.syncTaskBoardUi()
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
      let gracefulResult
      if (this.agent?.active) {
        try {
          if (typeof this.agent.pausePersistentPlan === 'function') {
            const state = await this.agent.pausePersistentPlan(`server_stop_${reason}`)
            await this.syncTaskBoardUi(state)
          }
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

        this.log('Requesting Factorio graceful /quit shutdown')
        this.rcon.command('/quit').catch(error => {
          if (this.gameChild?.alive()) {
            this.log(`Shutdown /quit acknowledgement failed: ${error instanceof Error ? error.message : error}`)
          }
        })
        try {
          gracefulResult = await withTimeout(this.gameChild.closed, this.config.stopMs, 'Factorio graceful /quit timed out')
        }
        catch (error) {
          clean = false
          this.log(`Factorio did not exit cleanly after /quit: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (this.gameChild?.alive()) {
        this.log('Falling back to SIGINT for Factorio shutdown')
        const stopped = await this.gameChild.stop(Math.min(this.config.stopMs, 15000), 'SIGINT')
        if (stopped.forced || stopped.result?.code !== 0) clean = false
      }
      else if (gracefulResult && gracefulResult.code !== 0) {
        clean = false
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
