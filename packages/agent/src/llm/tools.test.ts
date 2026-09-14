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
      'getNavigationStatus',
      'getCraftingStatus',
      'getResearchStatus',
      'getTechnology',
      'getCombatStatus',
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

describe('navigation observation tool', () => {
  it('reads bounded navigation target/path and last-result state', async () => {
    const output = '{"task_active":false,"last_result":{"code":"unreachable","completed":false}}'
    mocks.raw.mockResolvedValue({ data: { output } })
    expect(await getTool('getNavigationStatus').fn({ parameters: {} })).toBe(output)
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_navigation", "status")))',
    } })
  })
})

describe('crafting observation tool', () => {
  it('reads native queue ownership and last-result state', async () => {
    const output = '{"task_active":false,"last_result":{"code":"completed","completed":true}}'
    mocks.raw.mockResolvedValue({ data: { output } })
    expect(await getTool('getCraftingStatus').fn({ parameters: {} })).toBe(output)
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting", "status")))',
    } })
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

describe('combat observation tool', () => {
  it('reads bounded combat target and last-result state', async () => {
    const output = '{"task_active":false,"last_result":{"code":"target_destroyed","completed":true}}'
    mocks.raw.mockResolvedValue({ data: { output } })
    expect(await getTool('getCombatStatus').fn({ parameters: {} })).toBe(output)
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_combat", "status")))',
    } })
  })
})

describe('navigation, crafting, research, and combat prompt contract', () => {
  it('documents the actual observation tools', () => {
    for (const name of ['getNavigationStatus', 'getCraftingStatus', 'getResearchStatus', 'getTechnology', 'getCombatStatus']) {
      expect(tools.some(tool => tool.name === name)).toBe(true)
      expect(prompt).toContain(name)
    }
  })

  it('distinguishes navigation idle from verified arrival and bounded failures', () => {
    expect(prompt).toContain('Navigation completion must be verified')
    expect(prompt).toContain('reached')
    expect(prompt).toContain('unreachable')
    expect(prompt).toContain('path_timeout')
  })

  it('requires crafting output verification and preserves a pre-existing native queue', () => {
    expect(prompt).toContain('Hand-crafting completion must be verified')
    expect(prompt).toContain('native_queue_busy')
    expect(prompt).toContain('output_missing')
    expect(prompt).toContain('preserves pre-existing native crafts')
  })

  it('distinguishes research submission from technology completion and shared research cancellation', () => {
    expect(prompt).toContain('A queued/accepted request is not completed research')
    expect(prompt).toContain('does not mean the technology is unlocked')
    expect(prompt).toContain('does not cancel already-started shared force research')
    expect(prompt).toContain('force_busy')
    expect(prompt).toContain('Gameplay-trigger technologies require their actual trigger')
  })

  it('requires combat result verification instead of treating idle as a kill', () => {
    expect(prompt).toContain('Combat completion must be verified')
    expect(prompt).toContain('target_destroyed')
    expect(prompt).toContain('no_weapon_or_ammo')
    expect(prompt).toContain('stuck')
    expect(prompt).toContain('timeout')
  })
})