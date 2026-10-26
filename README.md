# Foxyverse VTT

A self-hosted virtual tabletop where the rules are **data**: the Foxyverse system lives in `system/foxyverse.json`
and the GM edits it from inside the app. No npm dependencies (Node 22 built-ins only), one folder of data, one container.

## Run it

### Option A: prebuilt image (nothing to build)

1. Push this folder to a GitHub repository (branch `main`). The workflow in `.github/workflows/docker.yml` runs the tests,
   builds the image, **starts the container and smoke-tests it**, then publishes `ghcr.io/<you>/<repo>:latest` (amd64 + arm64).
2. On your server, edit `docker-compose.ghcr.yml` (replace `OWNER/REPO`) and run:

       docker compose -f docker-compose.ghcr.yml up -d

   If the package is private, `docker login ghcr.io` first (or make the package public in GitHub: Packages, Package settings).

### Option B: build locally

    docker compose up -d --build

Then open `http://localhost:3000`. The **first account you register becomes the GM**; other players need the invite code
(GM: *Table* tab, or the container logs). Run `./scripts/docker-smoke.sh` to check the build yourself.

### Without Docker

    node server/index.js          # Node >= 22.13

### Data, backups, updates

Everything (database + uploaded maps, tokens, audio) is in the `/data` volume. The default compose file uses a named
volume (`foxyverse-data`), which avoids permission problems. Back it up with:

    docker run --rm -v foxyverse-data:/data -v "$PWD":/backup debian:bookworm-slim tar czf /backup/foxy-backup.tgz -C /data .

Update: `docker compose pull && docker compose up -d` (or `--build`). The database upgrades itself.

Prefer a bind mount (`./data:/data`)? The container runs as uid 1000, so run `sudo chown -R 1000:1000 ./data` first.
The server prints exactly this advice if it cannot write there. Avoid network shares (NFS/SMB) for `/data`: SQLite needs real file locking.

### HTTPS / reverse proxy

Put Caddy, nginx or Traefik in front and set `TRUST_PROXY=1`. Caddy example:

    vtt.example.com {
        reverse_proxy foxyverse-vtt:3000
    }

Server-Sent Events are used for live updates, so do not buffer responses (nginx: `proxy_buffering off;`, the server already sends `X-Accel-Buffering: no`).

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | listen address |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | database and uploads |
| `INVITE_CODE` | generated | fixed invite code for new players |
| `TRUST_PROXY` | off | `1` behind a reverse proxy |
| `UPLOAD_MAX_MB` / `AUDIO_MAX_MB` | `25` / `60` | GM upload limits (players: images up to 5 MB) |

## Using it

**Chat and rolls.** `/type [count] formula|label`: `/int`, `/str +3`, `/pdmg 2d6+str`, `/pdmg 10 2d4`, `/gm /pdmg 1d8` (GM-only).
Stat checks are roll-under d20 with nat 1 / nat 20 handling. `[str +2|label]` in notes, journals and rules becomes a clickable roll.
Players reroll by spending a favor; the GM rerolls for free. On damage/heal rolls the GM selects tokens and clicks *Appliquer*:
DP/DM reduce physical/magical hits, true damage ignores both, temp HP goes first, elementals have 1 HP, ignore physical damage and lose mana instead.

**Sheets.** Stats (base / items / passive), derived values, favors, talents (*Utiliser* loads the tier bonus into the modifier box),
spells (*Lancer* rolls INT or FOC, then pays mana, then HP at 0 mana), equipment with DP/DM and stat bonuses, portrait (also used for the token),
and a **compendium** picker to copy items, spells and talents prepared by the GM. GM: `⇪` saves an entry to the compendium, *Enregistrer comme modèle* saves an NPC template.

**Map and scenes (GM).** The scene dropdown on the map lets you prepare any scene; *Afficher aux joueurs* switches everyone over.
Tools: **Mur** (click points, right-click or Esc to finish, Alt = no snapping), **Porte** (click an existing door to open/close it),
**Lumière** (placed lights, plus any token can emit light), **Révéler** (permanently reveal an area), **Gomme** (delete).
Scene switches: **Brouillard** (fog), **Obscurité** (darkness: you need light or darkvision), **Vue joueurs** (preview exactly what players see).
Tokens: double-click opens the sheet; *vision* and *light* are in cells (vision 0 = unlimited in lit scenes). Only tokens linked to a player's character give that player vision.
Two-finger pinch zooms on touch screens; mouse wheel zooms; right/middle drag pans.

**Journal.** Markdown entries and image handouts, visible to the GM only / everyone / chosen players. *Montrer aux joueurs* pops it open on every screen.

**Sound.** The GM uploads audio and starts/stops sounds (with loop and volume); all clients play in sync. Players have a volume/mute control. Browsers block sound until
the page has been clicked once, so a *Activer le son* button appears if needed.

**Table (GM).** Scenes, map upload, grid size/offset, clear walls/lights/reveals, tokens, players and roles, invite code.

**Système (GM).** Forms for stats, character creation values, derived formulas (with live results against the selected character), quick rolls, roll types,
knowledge tiers and the rules text, plus a raw JSON view and export/import. Saving applies instantly to every sheet.

## Formula language (ported from the Owlbear plugin docs)

`XdY` (X, Y may be expressions), `+ - * ^ ( )`, `/` round to nearest, `\` round down, `%` round up (not modulo),
`a < b` means a <= b, `a > b` means a >= b, `expr !< n` / `!> n` clamp the total. Added: `min() max() floor() ceil() round() abs()`.
Variable names are letters/underscores; unknown names are 0. Built in: `lvl elemental bonact bonspe pdef mdef curhp temhp curmp curfav`
plus every stat and derived value (and their aliases) from the system file.

## Security notes

Accounts use scrypt-hashed passwords, HttpOnly SameSite cookies, a login throttle and an invite code. Uploads are checked by content, not just by name.
Fog of war is enforced in the browser: the full map image is delivered to every player (as in other VTTs), so do not rely on fog to hide secrets from a determined player.

## Layout

    server/engine.js   formula engine            server/rules.js   system validation, rolls, damage, spells
    server/index.js    HTTP + SSE + API          server/db.js      SQLite schema and migrations
    public/            vanilla JS client         public/vision.js  line-of-sight geometry (also unit-tested)
    system/            default rule system       scripts/          smoke tests (also used by CI)
    test/              node --test test/*.test.js

## Known limits

No journal rich-text editor (Markdown only), no per-light colours, fog edges are hard (not feathered), compendium entries are created from sheets and cannot be edited in place
(rename or delete and re-save). Tokens cannot be moved between scenes. Combat order is left to the GM, as in your rules.
