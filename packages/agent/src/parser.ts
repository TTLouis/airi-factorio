import type { StructuredOperation } from './llm/operations'
import { z } from 'zod'
import { legacyOperationCommandSchema, renderStructuredOperations, structuredOperationsSchema } from './llm/operations'

export interface ChatMessage {
  type: 'chat'
  username: string
  message: string
  isServer: boolean
  date: string
}

export interface CommandMessage {
  type: 'command'
  username: string
  command: string
  isServer: boolean
  date: string
}

export interface ModErrorMessage {
  type: 'modError'
  serverTimestamp: string
  error: string
}

export interface OperationCompletedMessage {
  type: 'operationsCompleted'
  serverTimestamp: string
  details?: string
}

export type StdoutMessage = ChatMessage | CommandMessage | ModErrorMessage | OperationCompletedMessage

export interface LLMMessage {
  chatMessage: string
  operationCommands: string[]
  operations?: StructuredOperation[]
  plan: string[]
  currentStep: number
}

const llmMessageSchema = z.object({
  chatMessage: z.string().max(2000),
  operationCommands: z.array(legacyOperationCommandSchema).max(16).optional(),
  operations: structuredOperationsSchema.optional(),
  plan: z.array(z.string().max(500)).max(30),
  currentStep: z.number().int().min(0).max(30),
}).strict().superRefine((value, ctx) => {
  const actionFormats = Number(value.operationCommands !== undefined) + Number(value.operations !== undefined)
  if (actionFormats !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Response must contain exactly one of operationCommands or operations',
    })
  }

  if (value.plan.length > 0 && value.currentStep >= value.plan.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['currentStep'],
      message: 'currentStep must index an existing plan step',
    })
  }

  if (value.plan.length === 0 && value.currentStep !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['currentStep'],
      message: 'currentStep must be 0 when the plan is empty',
    })
  }
})

export function parseLLMMessage(message: string): LLMMessage {
  const value = llmMessageSchema.parse(JSON.parse(message))
  const operationCommands = value.operations
    ? renderStructuredOperations(value.operations)
    : value.operationCommands ?? []

  return {
    ...value,
    operationCommands,
  }
}

export function parseCommandMessage(log: string): CommandMessage | null {
  // example: 2025-02-02 12:08:24 [COMMAND] <server> (command): remote.call(\"autorio_tools\", \"get_recipe\", \"iron-chest\", 1)
  const serverRegex = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[COMMAND\] <server> \(command\): (.+)/
  const serverMatch = log.match(serverRegex)

  if (serverMatch) {
    const [, date, , command] = serverMatch
    return { username: 'server', command, isServer: true, date, type: 'command' }
  }

  // example: 2000-01-02 12:34:56 [COMMAND] username (command): log('hello world')
  const playerRegex = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[COMMAND\] (.+?) \(command\): (.+)/
  const playerMatch = log.match(playerRegex)

  if (playerMatch) {
    const [, date, , username, command] = playerMatch
    return { username, command, isServer: false, date, type: 'command' }
  }

  return null
}

export function parseChatMessage(log: string): ChatMessage | null {
  // example: 2000-01-02 12:34:56 [CHAT] <server>: message
  const serverChatRegex = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[CHAT\] <server>: (.+)/
  const serverMatch = log.match(serverChatRegex)

  if (serverMatch) {
    const [, date, , message] = serverMatch
    return { username: 'server', message, isServer: true, date, type: 'chat' }
  }

  // example: 2000-01-02 12:34:56 [CHAT] username: message
  const playerChatRegex = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \[CHAT\] (.+?): (.+)/
  const playerMatch = log.match(playerChatRegex)

  if (playerMatch) {
    const [, date, , username, message] = playerMatch
    return { username, message, isServer: false, date, type: 'chat' }
  }

  return null
}

export function parseModErrorMessage(log: string): ModErrorMessage | null {
  // example: 42.535 Script @__autorio__/control.lua:661: [AUTORIO] [ERROR] No iron-ore found in 50m radius, reverting to IDLE state
  const modErrorRegex = /(\d+\.\d{3}) Script @__autorio__\/control\.lua:(\d+): \[AUTORIO\] \[ERROR\] (.+)/
  const modErrorMatch = log.match(modErrorRegex)

  if (modErrorMatch) {
    const [,serverTimestamp, , error] = modErrorMatch
    return { serverTimestamp, error, type: 'modError' }
  }

  return null
}

export function parseOperationCompletedMessage(log: string): OperationCompletedMessage | null {
  // examples:
  // 51.889 Script @__autorio__/control.lua:920: [AUTORIO] All operations completed
  // 51.889 Script @__autorio__/control.lua:920: [AUTORIO] All operations completed: batch=7, task_count=2, tasks=walking_direct,waiting, tick=12345
  const operationCompletedRegex = /(\d+\.\d{3}) Script @__autorio__\/control\.lua:(\d+): \[AUTORIO\] All operations completed(?:: (.+))?$/
  const operationCompletedMatch = log.match(operationCompletedRegex)

  if (operationCompletedMatch) {
    const [, serverTimestamp, , details] = operationCompletedMatch
    return {
      serverTimestamp,
      type: 'operationsCompleted',
      ...(details ? { details } : {}),
    }
  }

  return null
}