import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeSource = new URL('./structured-policy.mjs', import.meta.url)
const stagingSource = new URL('../staging/structured-policy.mjs', import.meta.url)

test('runtime structured policy works with only files copied by the installer', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-policy-copy-'))
  try {
    await fsp.mkdir(path.join(root, 'runtime-v8'), { recursive: true })
    await fsp.mkdir(path.join(root, 'staging'), { recursive: true })
    await fsp.copyFile(runtimeSource, path.join(root, 'runtime-v8', 'structured-policy.mjs'))
    await fsp.copyFile(stagingSource, path.join(root, 'staging', 'structured-policy.mjs'))
    const policy = await import(`${pathToFileURL(path.join(root, 'runtime-v8', 'structured-policy.mjs')).href}?copy-contract=${Date.now()}`)
    assert.ok(policy.toolDefinitions.some(tool => tool.function.name === 'solveProduction'))
    assert.ok(policy.toolDefinitions.some(tool => tool.function.name === 'getTransportCapacity'))
    assert.ok(policy.toolDefinitions.some(tool => tool.function.name === 'getPlacementCandidates'))
    assert.equal(policy.toolCommand('getActorStatus', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor","status")))')
    assert.equal(
      policy.renderOperation({
        name: 'place_candidate',
        args: { candidate_set_id: 'placement-4', candidate_id: 'candidate-2' },
      }),
      "remote.call('autorio_operations','place_candidate','placement-4','candidate-2')",
    )
  }
  finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
