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
| Variable | Env var | Default | Notes |
|---|---|---|---|
| AIRI Controlled Player | `AIRI_PLAYER` | *(none)* | the one connected player AI is allowed to control — see below |
| OpenAI API Key | `OPENAI_API_KEY` | *(none)* | required, not shown to non-admins, never read from `airi-config.json` |
| AI Model | `OPENAI_MODEL` | `gpt-4o` | OpenAI-compatible model name |
| Provider Base URL | `OPENAI_API_BASEURL` | `https://api.openai.com/v1` | point at a different OpenAI-compatible endpoint |
| Save File Name | `SAVE_NAME` | *(auto-detect, only if exactly one save exists)* | which save to boot |
| Auto Update AIRI Release | `AUTO_UPDATE` | `1` | `0`/`1` |
| Watch For Updates | `TTL_UPDATER` | `1` | `0`/`1` |
| Update Check Interval (Minutes) | `UPDATE_TTL_MIN` | `10` | |
| Max AI Requests Per Hour | `MAX_PROVIDER_REQUESTS_PER_HOUR` | `30` | hourly cap on LLM calls |
| Shutdown Timeout (ms) | `SHUTDOWN_TIMEOUT_MS` | `60000` | graceful-stop timeout |
| Extra Factorio Arguments | `FACTORIO_EXTRA_ARGS` | `[]` | extra CLI args passed to the Factorio binary |
| Factorio Version | `FACTORIO_VERSION` | `latest` | `latest` or a pinned `2.0.x` |

`gamePort` has no dedicated egg variable — Pterodactyl's own auto-injected
`SERVER_PORT` covers it (`configuration()` reads `env.SERVER_PORT` directly).

## `airi-config.json` is optional

Every field above is read by `configuration()` (`payload-src/installer.sh`,
the `configuration` function) as `env.X ?? raw.Y ?? default` — **the egg
variable always wins when both are set**, and `airi-config.json` is only
consulted as a fallback. Setting the egg variables above at
creation/reinstall time is enough; you do not need to hand-edit
`/home/container/airi-config.json` unless you want to override something
outside the panel (e.g. templating multiple servers from one exported
config) or prefer editing the file directly.

**Most important: `AIRI_PLAYER`.** Without it (or a `player` key in
`airi-config.json`), AI control stays **disabled** — the server still runs,
but the installer's own log line says it plainly: *"Set AIRI_PLAYER or
airi-config.json player before using `!airi` requests in game."* The AI only
ever acts as this one already-connected, explicitly authorized player — it
does not spawn or control a separate autonomous character.

If you do want to hand-edit the file instead of using the egg variables,
it lives at `/home/container/airi-config.json` (edit it from the panel's
file manager, or `sftp`/shell into the container — `/home/container` is
where Pterodactyl mounts the server's persistent volume at runtime, as
opposed to the `/mnt/server` path used only during install):

```json
{
  "player": "YourInGameCharacterName"
}
```

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
