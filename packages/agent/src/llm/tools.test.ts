import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  raw: vi.fn(),
}))

vi.mock('factorio-rcon-api-client', () => ({
  v2FactorioConsoleCommandRawPost: mocks.raw,
}))

import prompt from './prompt.md?raw'
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
  it('exposes the bounded observation tool set', () => {
    expect(tools.map(tool => tool.name)).toEqual([
      'getActorStatus',
      'getTaskStatus',
      'getInventoryItems',
      'getRecipe',
      'getNearbyEntities',
      'getEntityStatus',
      'getResearchStatus',
      'getTechnology',
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

  it('escapes recipe item names before placing them in Lua', async () => {
    await getTool('getRecipe').fn({ parameters: { item: "mod's-item" } })

    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/c remote.call("autorio_tools", "get_recipe", \'mod\\\'s-item\')',
      },
    })
  })

  it('rejects control characters in recipe tool input before RCON execution', async () => {
    await expect(getTool('getRecipe').fn({ parameters: { item: 'iron-plate\n/c game.clear()' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders bounded nearby-entity filters into a read-only remote call', async () => {
    await getTool('getNearbyEntities').fn({
      parameters: {
        radius: 32,
        name: 'iron-ore',
        type: 'resource',
        limit: 25,
      },
    })

    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_nearby_entities", 32, \'iron-ore\', \'resource\', 25)))',
      },
    })
  })

  it('applies safe defaults and rejects oversized nearby-entity queries', async () => {
    await getTool('getNearbyEntities').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_nearby_entities", 20, nil, nil, 50)))',
      },
    })

    mocks.raw.mockClear()
    await expect(getTool('getNearbyEntities').fn({ parameters: { radius: 65 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders a bounded exact-name entity-status lookup', async () => {
    await getTool('getEntityStatus').fn({
      parameters: {
        name: 'wooden-chest',
      },
    })

    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_entity_status", \'wooden-chest\', 8)))',
      },
    })
  })

  it('escapes entity-status names and rejects an oversized lookup radius', async () => {
    await getTool('getEntityStatus').fn({ parameters: { name: "mod's-chest", radius: 16 } })
    expect(mocks.raw).toHaveBeenCalledWith({
      body: {
        input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_entity_status", \'mod\\\'s-chest\', 16)))',
      },
    })

    mocks.raw.mockClear()
    await expect(getTool('getEntityStatus').fn({ parameters: { name: 'wooden-chest', radius: 33 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})

describe('research observation tools', () => {
  it('reads force research without treating the request result as completion', async () => {
    const output = '{"current":{"name":"automation"},"progress":0.1,"last_request_result":{"accepted":true}}'
    mocks.raw.mockResolvedValue({ data: { output } })
    expect(await getTool('getResearchStatus').fn({ parameters: {} })).toBe(output)
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "status")))',
    } })
  })

  it('escapes exact technology names', async () => {
    await getTool('getTechnology').fn({ parameters: { name: "mod's-tech" } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "technology", \'mod\\\'s-tech\')))',
    } })
  })

  it('rejects malformed and extra technology arguments before RCON', async () => {
    for (const parameters of [{}, { name: 'automation\n/c game.clear()' }, { name: 'automation', force: 'enemy' }]) {
      await expect(getTool('getTechnology').fn({ parameters })).rejects.toThrow()
    }
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})

describe('research prompt contract', () => {
  it('documents the actual observation tools', () => {
    for (const name of ['getResearchStatus', 'getTechnology']) {
      expect(tools.some(tool => tool.name === name)).toBe(true)
      expect(prompt).toContain(name)
    }
  })

  it('distinguishes submission from technology completion and shared research cancellation', () => {
    expect(prompt).toContain('A queued/accepted request is not completed research')
    expect(prompt).toContain('does not mean the technology is unlocked')
    expect(prompt).toContain('does not cancel already-started shared force research')
    expect(prompt).toContain('force_busy')
    expect(prompt).toContain('Gameplay-trigger technologies require their actual trigger')
  })
})
