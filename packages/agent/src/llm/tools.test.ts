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
  if (!tool) throw new Error(`missing tool: ${name}`)
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
      'findLongRangeEntities',
      'getEntityStatus',
      'getNavigationStatus',
      'getFollowStatus',
      'getCraftingStatus',
      'getResearchStatus',
      'getTechnology',
      'getCombatStatus',
    ])
  })

  it('reads actor status through the read-only actor interface', async () => {
    const result = await getTool('getActorStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_actor", "status")))',
    } })
    expect(result).toBe('{"ok":true}')
  })

  it('reads task status through the existing Autorio status operation', async () => {
    await getTool('getTaskStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations", "status")))',
    } })
  })

  it('escapes recipe item names and rejects control characters', async () => {
    await getTool('getRecipe').fn({ parameters: { item: "mod's-item" } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/c remote.call("autorio_tools", "get_recipe", \'mod\\\'s-item\')',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getRecipe').fn({ parameters: { item: 'iron-plate\n/c game.clear()' } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders bounded nearby-entity filters and rejects oversized local queries', async () => {
    await getTool('getNearbyEntities').fn({ parameters: {
      radius: 32,
      name: 'iron-ore',
      type: 'resource',
      limit: 25,
    } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_nearby_entities", 32, \'iron-ore\', \'resource\', 25)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('getNearbyEntities').fn({ parameters: { radius: 65 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders exact-name long-range discovery and bounds it to 4096 tiles', async () => {
    await getTool('findLongRangeEntities').fn({ parameters: {
      name: 'copper-ore',
      max_radius: 2048,
      limit: 4,
    } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_discovery", "find_entities", \'copper-ore\', 2048, 4)))',
    } })

    mocks.raw.mockClear()
    await expect(getTool('findLongRangeEntities').fn({ parameters: { name: 'copper-ore', max_radius: 4097 } })).rejects.toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })

  it('renders a bounded exact-name entity-status lookup', async () => {
    await getTool('getEntityStatus').fn({ parameters: { name: 'wooden-chest' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools", "get_entity_status", \'wooden-chest\', 8)))',
    } })
  })
})

describe('navigation and follow observation tools', () => {
  it('reads navigation state', async () => {
    await getTool('getNavigationStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_navigation", "status")))',
    } })
  })

  it('reads persistent follow state', async () => {
    await getTool('getFollowStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_follow", "status")))',
    } })
  })
})

describe('crafting, research, and combat observation tools', () => {
  it('reads crafting state', async () => {
    await getTool('getCraftingStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_crafting", "status")))',
    } })
  })

  it('reads research and exact technology state', async () => {
    await getTool('getResearchStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "status")))',
    } })

    mocks.raw.mockClear()
    await getTool('getTechnology').fn({ parameters: { name: 'automation' } })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_research", "technology", \'automation\')))',
    } })
  })

  it('reads combat state', async () => {
    await getTool('getCombatStatus').fn({ parameters: {} })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_combat", "status")))',
    } })
  })
})

describe('prompt contract', () => {
  it('documents discovery, follow, navigation, crafting, research, and combat tools', () => {
    for (const name of ['findLongRangeEntities', 'getFollowStatus', 'getNavigationStatus', 'getCraftingStatus', 'getResearchStatus', 'getTechnology', 'getCombatStatus']) {
      expect(tools.some(tool => tool.name === name)).toBe(true)
      expect(prompt).toContain(name)
    }
    expect(prompt).toContain('follow_player')
    expect(prompt).toContain('stop_follow_player')
    expect(prompt).toContain('4096')
    expect(prompt).toContain('[CHAT] <username>: <message>')
  })

  it('retains explicit verification requirements', () => {
    expect(prompt).toContain('Navigation completion must be verified')
    expect(prompt).toContain('Hand-crafting completion must be verified')
    expect(prompt).toContain('does not mean the technology is unlocked')
    expect(prompt).toContain('Combat completion must be verified')
  })
})
