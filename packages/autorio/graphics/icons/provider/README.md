# Provider avatars

The console's top-left button wears the avatar of whichever vendor is behind the
model AIRI is currently calling. The file name is the provider id that
`src/task_board_provider.ts` resolves from the configured model identifier, and
`data.lua` declares one `sprite` prototype per file.

| file | shown for models matching |
| --- | --- |
| `claude.png` | `claude`, `anthropic`, `sonnet`, `opus`, `haiku` |
| `deepseek.png` | `deepseek` |
| `qwen.png` | `qwen`, `qianwen`, `tongyi` |
| `gemini.png` | `gemini`, `google` |
| `openai.png` | `openai`, `chatgpt`, `gpt-`, `gpt4`, `gpt3`, `o1-`, `o3-`, `o4-` |

Matching is by substring, in that order, so a routed identifier like
`openai-compatible/deepseek-chat` resolves to the vendor that actually answers.
No key is a speed tier: every vendor ships a "flash", so the word says nothing
about who is answering.

A model that matches none of them keeps the button's default sprite. There is no
house avatar for that case on purpose.

## Format

Every file here is **128x128 RGBA**. `data.lua` draws them at `scale = 0.25`, so
the button shows 32 GUI units and the source still has pixels to spare at the
200% UI scale Factorio allows. All providers share one `size` in `data.lua`, so
a file of a different size would be drawn wrong - keep them all at 128.

32 GUI units is small. A detailed illustration reads as its color and silhouette
at that size rather than as its subject, which is why the button's tooltip names
the vendor and the exact model.

## Importing artwork

```bash
python packages/autorio/scripts/import_provider_icon.py <source-image> <provider-id> [options]
```

It accepts any size and keys a white background to transparent. `--check`
reports what it would produce without writing.

**Keep a set consistent.** Pass the same `--frame SIDE` to every figure of one
sheet. `--frame` crops a fixed box out of the *source*, centred on the widest
row of the head, so every head lands the same size no matter how tall or short
that figure's own artwork is. Without it each figure is squared by its own
bounding box, and a short drawing gets scaled up more than a tall one - that
produced heads ranging from 83px to 106px across five avatars drawn at the same
scale. The script prints the measured head width of each import so drift is
visible. The current set came from one sheet:

```bash
SRC="ChatGPT Image Sep 17, 2026, 11_46_25 AM.png"   # 2172x724, five figures
python packages/autorio/scripts/import_provider_icon.py "$SRC" openai   --slice 0:425     --frame 500
python packages/autorio/scripts/import_provider_icon.py "$SRC" claude   --slice 438:866   --frame 500
python packages/autorio/scripts/import_provider_icon.py "$SRC" deepseek --slice 878:1300  --frame 500
python packages/autorio/scripts/import_provider_icon.py "$SRC" gemini   --slice 1310:1735 --frame 500
python packages/autorio/scripts/import_provider_icon.py "$SRC" qwen     --slice 1748:2171 --frame 500
```

`--slice` column ranges are the gaps between figures; they are whatever the
sheet happens to use. For a single portrait with no sheet to match, use
`--keep-top 0.72` instead of `--frame`.

## Placeholders

`scripts/make_provider_placeholders.py <provider-id>` writes a flat brand-color
plate for an id that has no artwork yet. It exists because the data stage has no
file-exists test and treats a missing sprite file as a hard load failure. It
refuses to overwrite an existing file unless you pass `--force`, so it cannot
quietly replace real artwork.

## Adding a provider

1. Add the id and its match keys to `PROVIDERS` in `src/task_board_provider.ts`.
2. Add the id to the list in `data.lua`.
3. Commit a 128x128 PNG here under that id - imported artwork or a placeholder.

All three are required. An id in `data.lua` with no committed PNG stops the mod
from loading; a resolver id with no prototype silently leaves the button on its
default sprite.
