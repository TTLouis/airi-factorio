import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
}))

vi.mock('factorio-rcon-api-client', () => ({
  v2FactorioConsoleCommandRawPost: mocks.raw,
}))

import { tools } from './tools'

function getTool(name: string) {
  const tool = tools.find(tool => tool.name === name)
  if (!tool) {
    throw new Error(`missing tool: ${name}`)
  }
  return tool
}

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('agent observation tools', () => {
  it('exposes the Stage A observation tool set', () => {
    expect(tools.map(tool => tool.name)).toEqual([
      'getActorStatus',
      'getTaskStatus',
      'getInventoryItems',
      'getRecipe',
    ])
  })

  it('reads actor status through the read-only actor interface', async () => {
    const result = await getTool('getActorStatus').fn({ parameters: {} })

    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor", "status")))',
      },
    })
    expect(result).toBe('{"ok":true}')
  })

  it('reads task status through the existing Autorio status operation', async () => {
    const result = await getTool('getTaskStatus').fn({ parameters: {} })

    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations", "status")))',
      },
    })
    expect(result).toBe('{"ok":true}')
  })
})
