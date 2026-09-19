import { parseStrategicProjectProposal } from './strategic-project-board.mjs'

function sameMilestoneIntent(current, proposed) {
  return String(current?.title ?? '').trim() === String(proposed?.title ?? '').trim()
}

export function evaluateStrategicPlannerProposal(store, rawProposal) {
  if (!store || typeof store.current !== 'function') {
    throw new TypeError('Strategic planner proposal requires project store')
  }

  const proposal = parseStrategicProjectProposal(rawProposal)
  const board = store.current()

  if (board.status !== 'active') {
    return {
      accepted: false,
      reason: 'strategic_board_not_active',
      board,
      proposal,
    }
  }

  if (board.current_milestone) {
    if (!sameMilestoneIntent(board.current_milestone, proposal.current_milestone)) {
      return {
        accepted: false,
        reason: 'active_milestone_replacement_requires_runtime_transition',
        board,
        proposal,
      }
    }

    return {
      accepted: true,
      reason: 'refresh_existing_milestone_horizon',
      board,
      proposal,
      patch: {
        current_milestone: board.current_milestone,
        next_milestones: proposal.next_milestones,
        development_direction: proposal.development_direction,
      },
    }
  }

  if (board.transition_state === 'awaiting_next_milestone') {
    return {
      accepted: false,
      reason: 'awaiting_runtime_milestone_activation',
      board,
      proposal,
    }
  }

  return {
    accepted: true,
    reason: 'initialize_strategic_milestone',
    board,
    proposal,
    patch: {
      current_milestone: proposal.current_milestone,
      next_milestones: proposal.next_milestones,
      development_direction: proposal.development_direction,
    },
  }
}

export function applyStrategicPlannerProposal(store, rawProposal) {
  const admission = evaluateStrategicPlannerProposal(store, rawProposal)
  if (!admission.accepted) {
    return {
      ...admission,
      changed: false,
    }
  }

  const updated = store.update(admission.patch)
  return {
    ...admission,
    changed: true,
    board: updated,
  }
}
