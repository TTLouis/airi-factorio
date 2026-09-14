import crypto from 'node:crypto'

export class StagingSessionError extends Error {}

function check(ok, message) {
  if (!ok) throw new StagingSessionError(message)
}

function luaString(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'Invalid Lua string')
  return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, c => c === '\\' ? '\\\\' : c === '"' ? '\\"' : `\\${String(c.charCodeAt(0)).padStart(3, '0')}`)}"`
}

function parseJson(text, context) {
  try {
    return JSON.parse(String(text).trim())
  }
  catch {
    throw new StagingSessionError(`Invalid JSON from ${context}`)
  }
}

export async function deploymentStatus(rcon) {
  const raw = await rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("airi_deployment","status")))')
  const status = parseJson(raw, 'airi_deployment.status')
  check(status.revision === 'airi-deploy-v8-npc-staging', 'Unexpected deployment guard revision')
  check(status.mode === 'npc', 'Deployment guard is not in npc mode')
  check(status.allowed === true, 'NPC deployment session is not authorized')
  check(status.actor_kind === 'standalone_character', 'Deployment guard is not bound to a standalone NPC')
  check(Number.isSafeInteger(status.actor_id) && status.actor_id > 0, 'Deployment guard has no stable NPC identity')
  check(Number.isSafeInteger(status.epoch) && status.epoch > 0, 'Deployment guard has no valid epoch')
  check(typeof status.idle === 'boolean', 'Deployment guard has no idle state')
  check(status.actor_interface === true && status.operations === true && status.tools === true, 'Required Autorio interfaces are missing')
  return status
}

export async function configureNpcSession(rcon, session) {
  check(typeof session === 'string' && session.length >= 16 && session.length <= 256 && !/[\x00-\x1f\x7f]/.test(session), 'Invalid deployment session token')
  const command = `/silent-command rcon.print(remote.call("airi_deployment","configure","npc",${luaString(session)}))`
  let configured = await rcon.command(command)
  // Factorio can ask that the first Lua command be repeated before achievements
  // are disabled. This configure call is intentionally idempotent enough for the
  // same single retry pattern used by the existing supervisor startup handshake.
  if (String(configured).trim() !== session) configured = await rcon.command(command)
  check(String(configured).trim() === session, 'NPC deployment configure handshake failed')
  const status = await deploymentStatus(rcon)
  check(status.session === session, 'Deployment status session does not match configure token')
  return status
}

export function validatedOperationCall(command) {
  check(typeof command === 'string' && command.length > 0 && command.length <= 4096, 'Invalid operation command')
  check(!/[\r\n\0]/.test(command), 'Operation command contains forbidden control characters')
  check(/^remote\.call\((?:"|')autorio_operations(?:"|'),/.test(command), 'Only validated autorio_operations calls may mutate the game')
  return command
}

export async function executeAuthorizedOperation(rcon, epoch, command, marker = `AIRI_RESULT_${crypto.randomBytes(12).toString('hex')}:`) {
  check(Number.isSafeInteger(epoch) && epoch > 0, 'Invalid deployment epoch')
  validatedOperationCall(command)
  check(/^AIRI_RESULT_[a-f0-9]{24}:$/.test(marker), 'Invalid operation acknowledgement marker')

  const wrapped = `/silent-command local ok,result=pcall(function() if not remote.call("airi_deployment","authorize",${epoch}) then error("stale npc actor epoch") end; return ${command} end); rcon.print(${luaString(marker)}..helpers.table_to_json({ok=ok,result=result}))`
  const raw = await rcon.command(wrapped)
  const text = String(raw)
  const position = text.lastIndexOf(marker)
  check(position >= 0, 'Game command acknowledgement missing; operation will not be retried')
  const data = parseJson(text.slice(position + marker.length), 'operation acknowledgement')
  check(data.ok === true, 'Game command failed; operation will not be retried')
  check(data.result !== false && !(Array.isArray(data.result) && data.result[0] === false), 'Autorio rejected operation')
  return {
    result: data.result,
    output: text.slice(0, position).trim(),
  }
}

export function actorChanged(previous, current) {
  if (!previous || !current) return true
  return previous.mode !== current.mode
    || previous.actor_id !== current.actor_id
    || previous.actor_kind !== current.actor_kind
    || previous.epoch !== current.epoch
}
