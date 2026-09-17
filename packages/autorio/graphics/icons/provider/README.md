# Provider avatars

The console's top-left button wears the avatar of whichever vendor is behind the
model AIRI is currently calling. The file name is the provider id that
`src/task_board_provider.ts` resolves from the configured model identifier, and
`data.lua` declares one `sprite` prototype per file.

| file | shown for models matching |
| --- | --- |
| `claude.png` | `claude`, `anthropic`, `sonnet`, `opus`, `haiku` |
| `openai.png` | `openai`, `chatgpt`, `gpt-`, `gpt4`, `gpt3`, `o1-`, `o3-`, `o4-` |
| `deepseek.png` | `deepseek` |

A model that matches none of them keeps the button's default sprite. There is no
house avatar for that case on purpose.

## Replacing a placeholder

The committed files are flat brand-color plates, not artwork. Drop the vendor's
own icon in over any of them and nothing else has to change:

- 64x64 PNG, RGBA, transparent where it should be transparent;
- same file name, same folder.

If you change the size, change `size` in `data.lua` to match and keep
`size * scale == 32` so the icon fills a `slot_button` without resampling.

Regenerate the placeholders with:

```bash
python packages/autorio/scripts/make_provider_placeholders.py
```

## Adding a provider

1. Add the id and its match keys to `PROVIDERS` in `src/task_board_provider.ts`.
2. Add the id to the list in `data.lua`.
3. Commit a PNG here under that id.

All three are required. `data.lua` runs before any file exists check is possible
and Factorio treats a missing sprite file as a hard load failure, so an id listed
in `data.lua` without a committed PNG stops the mod from loading.
