import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ raw: vi.fn() }))
vi.mock('factorio-rcon-api-client', () => ({ v2FactorioConsoleCommandRawPost: mocks.raw }))

import { agentTools } from './tool-set'
import { getTransportCapacityTool, renderTransportCapacityRequest, transportCapacitySchema } from './transport-capacity-tool'

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('getTransportCapacity ordinary-agent tool', () => {
  it('is part of the ordinary agent tool surface', () => {
    expect(agentTools.some(tool => tool.name === 'getTransportCapacity')).toBe(true)
  })

  it('renders a lane validation request through autorio_planning capacity', async () => {
    const parameters = {
      kind: 'belt' as const, prototype_name: 'transport-belt', scope: 'lane' as const, required_rate_per_second: 7.5,
    }
    expect(renderTransportCapacityRequest(parameters)).toBe("{kind='belt',prototype_name='transport-belt',scope='lane',required_rate_per_second=7.5}")
    await getTransportCapacityTool.fn({ parameters })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\", \"capacity\", {kind='belt',prototype_name='transport-belt',scope='lane',required_rate_per_second=7.5})))",
    } })
  })

  it('renders an exact placed inserter request by unit number', () => {
    expect(renderTransportCapacityRequest({ kind: 'inserter_instance', unit_number: 42 }))
      .toBe("{kind='inserter_instance',unit_number=42}")
  })

  it('keeps inserter requests separate from belt rate validation', () => {
    expect(renderTransportCapacityRequest({ kind: 'inserter', prototype_name: 'bulk-inserter', item_name: 'iron-plate' }))
      .toBe("{kind='inserter',prototype_name='bulk-inserter',item_name='iron-plate'}")
    expect(() => transportCapacitySchema.parse({ kind: 'inserter', prototype_name: 'bulk-inserter', required_rate_per_second: 10 })).toThrow()
    expect(() => transportCapacitySchema.parse({ kind: 'belt', prototype_name: 'transport-belt', item_name: 'iron-plate' })).toThrow()
    expect(() => transportCapacitySchema.parse({ kind: 'inserter_instance', unit_number: 0 })).toThrow()
    expect(() => transportCapacitySchema.parse({ kind: 'inserter_instance', unit_number: 42, prototype_name: 'fast-inserter' })).toThrow()
  })

  it('rejects unsafe, extra, zero, and over-limit requests before RCON', async () => {
    expect(() => transportCapacitySchema.parse({ kind: 'belt', prototype_name: 'transport-belt\n/c game.clear()' })).toThrow()
    expect(() => transportCapacitySchema.parse({ kind: 'belt', prototype_name: 'transport-belt', required_rate_per_second: 0 })).toThrow()
    expect(() => transportCapacitySchema.parse({ kind: 'belt', prototype_name: 'transport-belt', required_rate_per_second: 1_000_000_001 })).toThrow()
    expect(() => transportCapacitySchema.parse({ kind: 'belt', prototype_name: 'transport-belt', extra: true })).toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})
