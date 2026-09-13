# AIRI Factorio — Pterodactyl egg

This directory holds the Pterodactyl egg used to deploy an AIRI-controlled
Factorio headless server, exactly as exported from the panel.

- [`egg-airi-factorio-server.json`](egg-airi-factorio-server.json) — the
  actual egg export (`PTDL_v2`). Import this directly via
  **Admin → Nests → Import Egg** — it already contains the install script.
- [`install.sh`](install.sh) — the same install script as a standalone file,
  extracted from the egg's `scripts.installation.script` field, for reading
  or pasting into the egg's *Install Script* field by hand.

Both files are a bootstrap wrapper: they verify and unpack an embedded,
checksummed payload (`AIRI_PAYLOAD`) into `/mnt/server` at install time,
which is the actual installer for the Node supervisor + Factorio headless
binary.

**The payload's real source of truth is [`payload-src/installer.sh`](payload-src/installer.sh)**,
a normal, diffable bash script — not the base64+gzip blob embedded in the
two files above. Never hand-edit that embedded blob, and never hand-edit the
`EXPECTED_SHA256` / `EXPECTED_BYTES` / `EXPECTED_BASE64_BYTES` constants near
the top of `install.sh`. Instead:

1. Edit [`payload-src/installer.sh`](payload-src/installer.sh).
2. Run [`build-payload.sh`](build-payload.sh) (or `node build-payload.mjs`
   directly). It compresses that file, splices the result into both
   `install.sh` and the egg JSON's `scripts.installation.script` field
   (they must always carry the identical script — this is enforced by the
   build, not just documented), and updates the three `EXPECTED_*`
   constants to match.
3. The build refuses to write anything unless decoding its own freshly
   built blob reproduces `payload-src/installer.sh` byte-for-byte — the
   thing that actually matters, since that's the content a server install
   would end up running. The *compressed* bytes are allowed to change
   between runs (gzip isn't a canonical encoding), so don't be surprised if
   `EXPECTED_BASE64_BYTES` moves even when `payload-src/installer.sh`
   didn't.
4. Commit `payload-src/installer.sh` together with the regenerated
   `install.sh` and `egg-airi-factorio-server.json`.

`payload-src/installer.sh` itself downloads a pinned AIRI source revision
from this fork (`TTLouis/airi-factorio`, `AIRI_REF` near its top) and Node
at install time — it's the
installer for the Node supervisor + Factorio headless binary, structured as
a transactional bootstrap: portable Node → pinned source → generated
supervisor/agent modules written out via heredocs → smoke tests → release
swap. Read it directly; it's no longer a blob you have to decode first.

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
