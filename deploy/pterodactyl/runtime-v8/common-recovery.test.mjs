import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { Child, DeploymentError, Rcon } from './common.mjs'

test('RCON command queue recovers after a rejected request', async () => {
  const rcon = new Rcon(1, 'test-password')
  rcon.socket = { destroyed: false, write() {} }
  let count = 0
  rcon.request = () => ++count === 1
    ? Promise.reject(new DeploymentError('first command failed'))
    : Promise.resolve('second command ok')

  await assert.rejects(() => rcon.command('first'), /first command failed/)
  assert.equal(await rcon.command('second'), 'second command ok')
})

test('detaching the final child input listener pauses the input stream', async () => {
  const input = new PassThrough()
  input.resume()
  const child = new Child(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { label: 'pause fixture' }).attachInput(input)
  await child.stop(1000, 'SIGTERM')
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(input.isPaused(), true)
})
