// Backing store for the stubbed `script.on_event` in test-setup.ts: control.ts
// registers its real event handlers here at module load, and tests pull them
// back out to invoke directly with synthetic events.
export const event_handlers = new Map<unknown, (event: any) => void>()

export function get_handler(event_key: unknown) {
  const handler = event_handlers.get(event_key)
  if (!handler) {
    throw new Error(`No handler registered for event key: ${String(event_key)}`)
  }
  return handler
}
