import type { SpritePath } from 'factorio:runtime'

/**
 * Which provider AIRI is currently talking to, and the avatar the console's
 * mod-GUI button wears for it.
 *
 * This lives apart from task_board_ui because TSTL emits each module-scope
 * constant and helper as a Lua local, and that module is already close to
 * Factorio's 200-locals-per-function limit.
 */

interface TaskBoardProvider { id: string, label: string }

declare const storage: {
  // The last model identifier AIRI reported. A cleared board drops its debug
  // block, and the button must not fall back to the unknown-provider avatar
  // just because the current goal finished.
  airi_task_board_provider_model?: string
}

const AVATAR_PREFIX = 'airi-provider-'
const UNKNOWN: TaskBoardProvider = { id: 'airi', label: 'Unrecognized provider' }
// Matched against the model identifier in order, so a name carrying two vendor
// words - a proxy prefix, a router path - resolves to the vendor that actually
// answers. Substrings only: model identifiers are provider-defined and change
// faster than any list here can.
const PROVIDERS: Array<TaskBoardProvider & { keys: string[] }> = [
  { id: 'deepseek', label: 'DeepSeek', keys: ['deepseek'] },
  { id: 'claude', label: 'Claude', keys: ['claude', 'anthropic', 'sonnet', 'opus', 'haiku'] },
  { id: 'openai', label: 'OpenAI', keys: ['openai', 'chatgpt', 'gpt-', 'gpt4', 'gpt3', 'o1-', 'o3-', 'o4-'] },
]

/**
 * The provider a model identifier belongs to. Exported for the unit tests: the
 * mapping is a guess about vendor naming, so it is worth pinning down.
 */
export function task_board_provider_of(model: unknown): TaskBoardProvider {
  const name = String(model ?? '').toLowerCase()
  if (name.length === 0) return UNKNOWN
  for (const provider of PROVIDERS) {
    for (const key of provider.keys) {
      if (name.includes(key)) return { id: provider.id, label: provider.label }
    }
  }
  return UNKNOWN
}

/** Record the model a snapshot reported. Empty values keep the last known one. */
export function remember_provider_model(model: unknown) {
  const name = String(model ?? '').trim()
  if (name.length > 0) storage.airi_task_board_provider_model = name
}

export function current_provider_model() { return storage.airi_task_board_provider_model ?? '' }

/**
 * The avatar for the current provider. The avatars are declared as sprites in
 * data.lua; a build that somehow shipped without the graphics still gets a
 * working button from `fallback` rather than an empty one.
 */
export function provider_button_sprite(fallback: SpritePath): SpritePath {
  const avatar = `${AVATAR_PREFIX}${task_board_provider_of(current_provider_model()).id}` as SpritePath
  return helpers.is_valid_sprite_path(avatar) ? avatar : fallback
}

/** Button tooltip naming the provider and the exact model behind the avatar. */
export function provider_button_tooltip(base: string) {
  const model = current_provider_model()
  return model.length > 0 ? `${base}\n${task_board_provider_of(model).label} · ${model}` : base
}
