import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { Child } from './common.mjs'

function echoChild(expectedBytes, logs) {
  const fixture = `const expected=${expectedBytes};let input=Buffer.alloc(0);process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);if(input.length>=expected){process.stdout.write(input.toString('base64')+'\\n');process.exit(0)}})`
  return new Child(process.execPath, ['-e', fixture], { label: 'input fixture', log: line => logs.push(line) })
}

test('one console command is forwarded unchanged', async () => {
  const input = new PassThrough()
  const logs = []
  const command = Buffer.from('/c game.print("hello")\r\n')
  const child = echoChild(command.length, logs).attachInput(input)
  input.write(command)
  await child.closed
  assert.deepEqual(Buffer.from(logs[0], 'base64'), command)
})

test('multiple console commands are forwarded unchanged', async () => {
  const input = new PassThrough()
  const logs = []
  const first = Buffer.from('/help\n')
  const second = Buffer.from('/players\r\n')
  const expected = Buffer.concat([first, second])
  const child = echoChild(expected.length, logs).attachInput(input)
  input.write(first)
  input.write(second)
  await child.closed
  assert.deepEqual(Buffer.from(logs[0], 'base64'), expected)
})

test('child exit does not produce unhandled EPIPE and input listener is detached', async () => {
  const input = new PassThrough()
  const before = input.listenerCount('data')
  const logs = []
  const child = new Child(process.execPath, ['-e', 'process.stdin.destroy();setTimeout(()=>process.exit(0),25)'], {
    label: 'exit fixture',
    log: line => logs.push(line),
  }).attachInput(input)
  for (let i = 0; i < 100; i++) input.write(Buffer.alloc(4096, 65))
  await child.closed
  input.write('after-exit\n')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(input.listenerCount('data'), before)
  assert.equal(logs.some(line => line.includes('EPIPE')), false)
})

test('stopping detaches input without accumulating listeners', async () => {
  const input = new PassThrough()
  const before = input.listenerCount('data')
  const child = new Child(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { label: 'stop fixture' }).attachInput(input)
  assert.equal(input.listenerCount('data'), before + 1)
  await child.stop(1000, 'SIGTERM')
  assert.equal(input.listenerCount('data'), before)
})

test('existing stdout and stderr forwarding still works without duplication', async () => {
  const logs = []
  const child = new Child(process.execPath, ['-e', `console.log('stdout-line');console.error('stderr-line')`], {
    label: 'output fixture',
    log: line => logs.push(line),
  })
  await child.closed
  assert.equal(logs.filter(line => line === 'stdout-line').length, 1)
  assert.equal(logs.filter(line => line === 'stderr-line').length, 1)
})
