import type { ControlledActor } from './actors/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create_production_planning_remote_interface } from './production_planning_remote'

const originalRemote = (globalThis as any).remote

let planning: any

afterEach(() => {
  ;(globalThis as any).remote = originalRemote
  planning = undefined
})

describe('throughput measurement remote contract', () => {
  it('exposes start/status/cancel through the existing autorio_planning interface', () => {
    ;(globalThis as any).remote = {
      add_interface: vi.fn((_name: string, methods: any) => { planning = methods }),
    }
    const actor = { is_valid: true } as unknown as ControlledActor
    const measurement = {
      start: vi.fn(() => ({ ok: true, measurement_id: 3, state: 'running' })),
      status: vi.fn(() => ({ ok: true, measurement_id: 3, state: 'complete', items_per_second: 8 })),
      cancel: vi.fn(() => ({ ok: false, measurement_id: 3, state: 'cancelled' })),
      tick: vi.fn(),
    }

    create_production_planning_remote_interface(() => actor, measurement as any)

    const request = { kind: 'inserter_instance', unit_number: 42, window_ticks: 300 }
    expect(planning.throughput_measurement_start(request)).toMatchObject({ ok: true, measurement_id: 3 })
    expect(measurement.start).toHaveBeenCalledWith(request)
    expect(planning.throughput_measurement_status(3)).toMatchObject({ state: 'complete', items_per_second: 8 })
    expect(measurement.status).toHaveBeenCalledWith(3)
    expect(planning.throughput_measurement_cancel(3)).toMatchObject({ state: 'cancelled' })
    expect(measurement.cancel).toHaveBeenCalledWith(3)
  })

  it('fails closed through the real controller when the controlled actor is unavailable', () => {
    ;(globalThis as any).remote = { add_interface: (_name: string, methods: any) => { planning = methods } }
    create_production_planning_remote_interface(() => undefined)
    expect(planning.throughput_measurement_start({ kind: 'inserter_instance', unit_number: 42, window_ticks: 60 })).toEqual({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'controlled actor is unavailable' },
    })
  })
})
