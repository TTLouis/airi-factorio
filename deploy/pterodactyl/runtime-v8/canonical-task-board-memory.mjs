import { NpcDialogueMemory } from './npc-agent-loop.mjs'

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function canonicalContinuationPlan(previousBoard, plan, { allowReplan = false } = {}) {
  if (allowReplan || !previousBoard || previousBoard.kind !== 'task_board_lite' || !Array.isArray(previousBoard.steps)) return plan
  const canonical = previousBoard.steps.map(step => String(step?.description ?? '')).filter(Boolean)
  if (canonical.length === 0) return plan

  const currentIndex = Number.isSafeInteger(previousBoard.active_index)
    ? Math.min(Math.max(previousBoard.active_index, 0), canonical.length - 1)
    : 0
  const incoming = Array.isArray(plan?.plan) ? plan.plan : []
  const incomingIndex = Number.isSafeInteger(plan?.currentStep)
    ? Math.min(Math.max(plan.currentStep, 0), Math.max(0, incoming.length - 1))
    : 0
  const incomingActive = incoming[incomingIndex]
  const matched = incomingActive === undefined
    ? -1
    : canonical.findIndex(description => clean(description) === clean(incomingActive))
  const nextIndex = matched >= currentIndex ? matched : currentIndex

  return {
    ...plan,
    plan: canonical,
    currentStep: nextIndex,
  }
}

export class CanonicalTaskBoardMemory extends NpcDialogueMemory {
  reconcileTaskBoard(key, previousBoard, plan, stateResult, options = {}) {
    const guarded = canonicalContinuationPlan(previousBoard, plan, options)
    return super.reconcileTaskBoard(key, previousBoard, guarded, stateResult, options)
  }

  terminatePlan(key) {
    const previous = key ? this.planByNpc.get(key) : undefined
    if (!previous) return undefined
    this.planByNpc.delete(key)
    return previous
  }
}
