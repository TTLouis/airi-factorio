import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ raw: vi.fn() }))
vi.mock('factorio-rcon-api-client', () => ({
  v2FactorioConsoleCommandRawPost: mocks.raw,
}))

import { renderProductionSolveRequest, solveProductionSchema, solveProductionTool } from './production-planning-tool'
import { agentTools } from './tool-set'

beforeEach(() => {
  mocks.raw.mockReset()
  mocks.raw.mockResolvedValue({ data: { output: '{"ok":true}' } })
})

describe('solveProduction ordinary-agent tool', () => {
  it('is part of the ordinary agent tool surface', () => {
    expect(agentTools.some(tool => tool.name === 'solveProduction')).toBe(true)
  })

  it('renders only validated bounded fields into the autorio_planning call', async () => {
    const parameters = {
      calculation_id: "green-circuit's-line",
      target: { type: 'item' as const, name: 'electronic-circuit', rate_per_second: 5 },
      included_recipe_names: ['electronic-circuit', 'copper-cable'],
      machine_selections: [
        { recipe_name: 'electronic-circuit', machine_name: 'assembling-machine-2' },
        { recipe_name: 'copper-cable', machine_name: 'assembling-machine-2' },
      ],
    }

    expect(renderProductionSolveRequest(parameters)).toBe("{calculation_id='green-circuit\\'s-line',target={type='item',name='electronic-circuit',rate_per_second=5},included_recipe_names={'electronic-circuit','copper-cable'},machine_selections={{recipe_name='electronic-circuit',machine_name='assembling-machine-2'},{recipe_name='copper-cable',machine_name='assembling-machine-2'}}}")

    await solveProductionTool.fn({ parameters })
    expect(mocks.raw).toHaveBeenCalledWith({ body: {
      input: "/silent-command rcon.print(helpers.table_to_json(remote.call(\"autorio_planning\", \"solve\", {calculation_id='green-circuit\\'s-line',target={type='item',name='electronic-circuit',rate_per_second=5},included_recipe_names={'electronic-circuit','copper-cable'},machine_selections={{recipe_name='electronic-circuit',machine_name='assembling-machine-2'},{recipe_name='copper-cable',machine_name='assembling-machine-2'}}})))",
    } })
  })

  it('rejects unsafe, extra, oversized, and non-positive requests before RCON', async () => {
    expect(() => solveProductionSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate', rate_per_second: 0 } })).toThrow()
    expect(() => solveProductionSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate\n/c game.clear()', rate_per_second: 1 } })).toThrow()
    expect(() => solveProductionSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate', rate_per_second: 1 }, extra: true })).toThrow()
    expect(() => solveProductionSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate', rate_per_second: 1 }, included_recipe_names: Array.from({ length: 65 }, (_, i) => `recipe-${i}`) })).toThrow()
    expect(() => solveProductionSchema.parse({ calculation_id: 'x', target: { type: 'item', name: 'iron-plate', rate_per_second: 1 }, machine_selections: Array.from({ length: 65 }, (_, i) => ({ recipe_name: `recipe-${i}`, machine_name: 'assembling-machine-1' })) })).toThrow()
    expect(mocks.raw).not.toHaveBeenCalled()
  })
})
