# AIRI Factorio — Pterodactyl egg

This directory holds the Pterodactyl egg used to deploy an AIRI-controlled
Factorio headless server, exactly as exported from the panel.

- [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) — the
  actual egg export (`PTDL_v2`). Import this directly via
  **Admin → Nests → Import Egg** — it already contains the install script.
- [`install.sh`](install.sh) — the same install script as a standalone file,
  extracted from the egg's `scripts.installation.script` field, for reading
  or pasting into the egg's *Install Script* field by hand. Keep it in sync
  with the egg JSON if either is regenerated from the panel.

Both files are a bootstrap wrapper: they verify and unpack an embedded,
checksummed payload (`AIRI_PAYLOAD`) into `/mnt/server` at install time,
which is the actual installer for the Node supervisor + Factorio headless
binary. Don't hand-edit the payload; regenerate it from the panel export if
the installer logic changes upstream.

**Docker image (both install and runtime):**
`ghcr.io/ptero-eggs/yolks:debian_bookworm`
**Startup command:** `bash ./start-airi.sh`

**Egg variables (exposed in the panel):**
| Variable | Env var | Notes |
|---|---|---|
| Factorio Version | `FACTORIO_VERSION` | `latest` or a pinned `2.0.x` |
| OpenAI API Key | `OPENAI_API_KEY` | required, not shown to non-admins |

## ⚠️ You must hand-edit `airi-config.json` after install

The egg only exposes two variables (above). Everything else — most
importantly **which in-game player the AI is allowed to control** — has no
egg variable and is *not* set automatically. After the server's first
install/boot, you must manually create or edit
**`/home/container/airi-config.json`** (edit it from the panel's file
manager, or `sftp`/shell into the container — `/home/container` is where
Pterodactyl mounts the server's persistent volume at runtime, as opposed to
the `/mnt/server` path used only during install).

Minimum required content:

```json
{
  "player": "YourInGameCharacterName"
}
```

Without a `player` name (either here, or via an `AIRI_PLAYER` environment
variable set on the server), AI control stays **disabled** — the server
still runs, but the installer's own log line says it plainly: *"AI control
is disabled until AIRI_PLAYER or airi-config.json player names the
authorized player."* The AI only ever acts as this one already-connected,
explicitly authorized player — it does not spawn or control a separate
autonomous character.

Optional fields you can only set here (no egg variable exists for them):

| Field | Default | Purpose |
|---|---|---|
| `save` | auto-detect (only if exactly one save exists) | which save to boot |
| `model` | `gpt-4o` | OpenAI-compatible model name |
| `providerUrl` | `https://api.openai.com/v1` | point at a different OpenAI-compatible endpoint |
| `factorioVersion` | `latest` | overridden by `FACTORIO_VERSION` env if both set |
| `gamePort` | `34197` | overridden by `SERVER_PORT` env if both set |
| `autoUpdate` / `watchUpdates` | `true` | overridden by `AUTO_UPDATE` / `TTL_UPDATER` env (`"0"`/`"1"`) |
| `updateMinutes` | `10` | overridden by `UPDATE_TTL_MIN` env |
| `maxProviderRequestsPerHour` | `30` | hourly cap on LLM calls |
| `shutdownTimeoutMs` | `60000` | graceful-stop timeout |
| `extraArgs` | `[]` | extra CLI args passed to the Factorio binary |

`OPENAI_API_KEY` can only come from the environment/egg variable — it is
never read out of `airi-config.json`, so it can't be accidentally committed
to a save/config backup.

## Why no Factorio account / API token is needed

This surprised us too — worth writing down. The server never needs a
Factorio.com account, login, or API token because it:

1. **Downloads the headless server binary from a public, unauthenticated
   URL** — `https://www.factorio.com/get-download/<version>/headless/linux64`.
   Unlike the Steam client, Factorio's headless server tarball has never
   required a logged-in account to download.
2. **Never joins Factorio's multiplayer matchmaking/auth service.** The
   installer explicitly creates the save with
   `visibility = { public: false, lan: false }` — it's a private, unlisted
   server. Account-based authentication (the "auth server" Factorio uses
   for public multiplayer, banning, etc.) only comes into play for servers
   that advertise themselves publicly or enforce online bans; this one does
   neither.
3. **All control happens over local RCON**, bound to `127.0.0.1` only, with
   a freshly generated password — not over the public game port. The
   externally exposed port is only the Factorio game port itself, for
   whoever connects directly by IP.

So the only credential this deployment actually needs is the
`OPENAI_API_KEY` for the LLM provider, plus (after install) the `player`
name in `airi-config.json` above.
