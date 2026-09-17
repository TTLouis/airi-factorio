import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { liveAgentEvent } from './supervisor.mjs'

test('plan.accepted retains each non-empty public decision in the current task conversation', () => {
  const initial = liveAgentEvent('plan.accepted', { chat_message: 'I will bootstrap coal first.', trigger_source: 'request' })
  assert.deepEqual(initial.activity, { kind: 'decision', text: 'I will bootstrap coal first.' })
  const replan = liveAgentEvent('plan.accepted', { chat_message: 'I will use the east patch.', trigger_source: 'failure' })
  assert.deepEqual(replan.activity, { kind: 'decision', text: 'I will use the east patch.' })
  assert.deepEqual(
    liveAgentEvent('plan.accepted', { chat_message: 'Continuing.', trigger_source: 'continuation' }).activity,
    { kind: 'decision', text: 'Continuing.' },
  )
  assert.deepEqual(
    liveAgentEvent('plan.accepted', { chat_message: 'Checking.', trigger_source: 'completion' }).activity,
    { kind: 'decision', text: 'Checking.' },
  )
})

test('NpcAgentLoop carries the trigger source on plan.accepted', () => {
  const source = readFileSync(new URL('./npc-agent-loop.mjs', import.meta.url), 'utf8')
  const accepted = source.split("await this.traceEvent('plan.accepted'")[1]?.split('})')[0] ?? ''
  assert.match(accepted, /trigger_source: this\.planUpdateReason/)
  assert.match(accepted, /chat_message: plan\.chatMessage/)
})
