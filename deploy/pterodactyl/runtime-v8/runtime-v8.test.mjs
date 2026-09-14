import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { providerEndpoint } from './provider.mjs'
import { configuration, installedAppRoot, Session } from './supervisor.mjs'

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-v8-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

const baseEnv = {
  AIRI_ACTOR_MODE: 'npc',
  AIRI_CHAT_PLAYER: 'Louis',
  OPENAI_API_KEY: 'test-key-1234',
  OPENAI_MODEL: 'test-model',
  OPENAI_API_BASEURL: 'https://api.example.test/v1',
  SERVER_PORT: '34197',
}

test('configuration defaults to standalone NPC and keeps chat authorization separate', () => {
  const config = configuration({}, baseEnv)
  assert.equal(config.actorMode, 'npc')
  assert.equal(config.chatPlayer, 'Louis')
  assert.equal(config.gamePort, 34197)
  const explicitBlank = configuration({}, { ...baseEnv, AIRI_CHAT_PLAYER: '', AIRI_PLAYER: 'LegacyName' })
  assert.equal(explicitBlank.chatPlayer, '')
  const aliasEnv = { ...baseEnv, AIRI_PLAYER: 'LegacyName' }
  delete aliasEnv.AIRI_CHAT_PLAYER
  const alias = configuration({}, aliasEnv)
  assert.equal(alias.chatPlayer, 'LegacyName')
  assert.throws(() => configuration({}, { ...baseEnv, AIRI_ACTOR_MODE: 'player' }))
})

test('installed supervisor resolves the release root above src/runtime-v8', () => {
  const moduleUrl = pathToFileURL('/srv/.airi/releases/v8/src/runtime-v8/supervisor.mjs').href
  assert.equal(installedAppRoot(moduleUrl), path.resolve('/srv/.airi/releases/v8'))
})

test('provider URL is HTTPS remotely and may be loopback HTTP', () => {
  assert.equal(providerEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(providerEndpoint('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000/v1/chat/completions')
  assert.throws(() => providerEndpoint('http://example.com/v1'))
  assert.throws(() => providerEndpoint('https://user:pass@example.com/v1'))
})

const fakeFactorio = `#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
const args=process.argv.slice(2);const get=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined};
const binding=get('--rcon-bind');const password=get('--rcon-password');const save=get('--start-server');
let session='',mode='player',actorId=18,epoch=0,stopping=false,configureCommand='';const sockets=new Set();
function packet(id,type,text){const body=Buffer.from(String(text));const b=Buffer.alloc(body.length+14);b.writeInt32LE(body.length+10,0);b.writeInt32LE(id,4);b.writeInt32LE(type,8);body.copy(b,12);return b}
function status(){return {revision:'airi-deploy-v8-npc-staging',session,mode,actor_id:actorId,actor_kind:mode==='npc'?'standalone_character':'connected_player',connected_players:0,allowed:!!session&&mode==='npc',idle:true,epoch,tools:true,operations:true,actor_interface:true}}
const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0),auth=false;socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readInt32LE(0);if(buffer.length<size+4)break;const msg=buffer.subarray(4,size+4);buffer=buffer.subarray(size+4);const id=msg.readInt32LE(0),type=msg.readInt32LE(4),text=msg.subarray(8,-2).toString();if(type===3){auth=text===password;socket.write(packet(auth?id:-1,2,''));continue}if(!auth){socket.destroy();return}let response='';if(text==='/version')response='Version: 2.0.77 (fixture)';else if(text.includes('"configure","npc"')){if(!configureCommand){configureCommand=text;response='Player <server> tried using the command '+text+'. Lua console commands will disable achievements. Please repeat the command to proceed.'}else if(text!==configureCommand){response='configure command was not repeated exactly'}else{const m=text.match(/"configure","npc",("(?:[^"\\\\]|\\\\.)*")/);const marker=(text.match(/AIRI_CONFIG_[a-f0-9]{24}:/)||[])[0];if(!m||!marker){response='invalid configure fixture command'}else{session=JSON.parse(m[1]);mode='npc';epoch++;response=marker+JSON.stringify({ok:true,result:session})}}}else if(text.includes('"airi_deployment","status"'))response=JSON.stringify(status());else if(text.includes('"airi_deployment","cancel"')){epoch++;response='true'}else if(text==='/server-save'){if(save)fs.appendFileSync(save,'saved');response='Saving map'}else response='ok';const out=packet(id,0,response);socket.write(out.subarray(0,3));socket.write(out.subarray(3))}})});
server.listen(Number(binding.split(':').pop()),'127.0.0.1',()=>console.log('Fixture Factorio ready'));
function stop(){if(stopping)return;stopping=true;for(const s of sockets)s.destroy();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),100)};process.on('SIGINT',stop);process.on('SIGTERM',stop);setInterval(()=>{},1000);
`

test('session starts zero-player standalone NPC over authenticated loopback RCON, handles the first-Lua confirmation, and saves cleanly', async t => {
  const root = await temp(t)
  const app = path.join(root, 'app')
  const game = path.join(app, 'factorio')
  const bin = path.join(game, 'bin', 'x64')
  await fsp.mkdir(path.join(app, 'src'), { recursive: true })
  await fsp.mkdir(bin, { recursive: true })
  await fsp.writeFile(path.join(app, 'src', 'prompt.md'), 'NPC prompt')
  const executable = path.join(bin, 'factorio')
  await fsp.writeFile(executable, fakeFactorio, { mode: 0o755 })
  const save = path.join(root, 'world.zip')
  await fsp.writeFile(save, 'PKfixture')
  const settingsFile = path.join(root, 'server-settings.json')
  const ini = path.join(root, 'config.ini')
  const modDir = path.join(root, 'mods-run')
  await fsp.mkdir(modDir)
  await fsp.writeFile(settingsFile, '{}')
  await fsp.writeFile(ini, '[path]\n')
  const logs = []
  const config = configuration({}, { ...baseEnv, SERVER_PORT: '34198' })
  const session = new Session({ root, app, game, config, save, settingsFile, modDir, ini, log: line => logs.push(line), provider: async () => { throw new Error('provider should not be called') }, startupMs: 10000 })
  const status = await session.start()
  assert.equal(status.mode, 'npc')
  assert.equal(status.actor_kind, 'standalone_character')
  assert.equal(status.connected_players, 0)
  assert.equal(status.allowed, true)
  assert.match(logs.find(line => line.includes('AIRI Factorio ready')) ?? '', /standalone NPC actor_id=18/)
  const clean = await session.stop('requested')
  assert.equal(clean, true)
  const saved = await fsp.readFile(save, 'utf8')
  assert.match(saved, /saved/)
})

test('chat authorization triggers provider path only for configured requester', async t => {
  const root = await temp(t)
  const config = configuration({}, baseEnv)
  const session = new Session({ root, app: root, game: root, config, save: 'x', settingsFile: 'x', modDir: 'x', ini: 'x', log: () => {} })
  const requests = []
  const prints = []
  session.ready = true
  session.rcon = { command: async text => { prints.push(text); return 'ok' } }
  session.ensureAuthorization = async () => ({ actor_id: 18, epoch: 3 })
  session.agent = {
    active: false,
    request: async text => { requests.push(text); return { chatMessage: 'Accepted.' } },
    completed: async () => null,
    cancel: () => {},
  }
  session.onGameLine('2026-09-13 20:00:00 [CHAT] SomeoneElse: !airi wait')
  await session.eventQueue
  assert.deepEqual(requests, [])
  session.onGameLine('2026-09-13 20:00:01 [CHAT] Louis: !airi wait')
  await session.eventQueue
  assert.deepEqual(requests, ['wait'])
  assert.ok(prints.some(text => text.includes('[AIRI] Accepted.')))
})
