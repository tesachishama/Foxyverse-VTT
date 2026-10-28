# Foxyverse VTT

A self-hosted virtual tabletop for the **Foxyverse** ruleset. It runs as one small container, needs no database server and no npm
install, and the rules themselves (stats, formulas, roll types, rules text) are **data you edit inside the app**.

* Real-time shared map with tokens, walls, doors, lights, fog of war and darkness
* Character sheets driven by your formulas, with the full 33-slot equipment system and silhouette
* Dice chat with the Foxyverse roll language, nat 1 / nat max grading, favors and one-click damage/heal application
* Journal and image handouts, synchronized soundboard, compendium of items / spells / talents / NPC templates
* GM and player accounts with an invite code. English and French interface (switch at the bottom of the side panel)

Contents: [Install](#install) · [Docker, Dockge and reverse proxies](#docker-dockge-and-reverse-proxies) · [Where your data lives](#where-your-data-lives) ·
[Guided tour](#guided-tour) · [Reference](#reference) · [Troubleshooting](#troubleshooting) · [Development](#development)

---

## Install

### Option A: the published image (recommended)

The GitHub workflow in `.github/workflows/docker.yml` runs the tests, builds the image, **starts the container and smoke-tests it**, and only then
publishes `ghcr.io/<your-user>/<repo>:latest` for amd64 and arm64. On your server:

    docker run -d --name foxyverse-vtt --init --restart unless-stopped \
      -p 3000:3000 -v foxyverse-data:/data \
      ghcr.io/<your-user>/foxyverse-vtt:latest

(use the repository name in lowercase). If the package is private, make it public in GitHub (Packages, Package settings) or `docker login ghcr.io`.

### Option B: build it yourself

    docker compose up -d --build

### Option C: no Docker

    node server/index.js        # Node 22.13 or newer, nothing to install

Open `http://localhost:3000`. **The first account registered becomes the GM.**

---

## Docker, Dockge and reverse proxies

### A ready stack for Dockge (or any compose file)

    services:
      foxyverse-vtt:
        image: ghcr.io/<your-user>/foxyverse-vtt:latest
        container_name: foxyverse-vtt
        init: true
        restart: unless-stopped
        ports:
          - "3010:3000"            # host port : container port. The right-hand 3000 never changes.
        volumes:
          - ./data:/data           # see "Where your data lives" (run: mkdir data && chown 1000:1000 data)
        environment:
          TZ: Europe/Zurich
          TRUST_PROXY: "1"         # when behind Caddy / nginx / Traefik
          # INVITE_CODE: "my-table"

**"port is already allocated"** means another container uses that host port. Change only the left number.

### Caddy

Two numbers get confused: `3010` is the port published **on the host**; inside Docker the app always listens on **3000**.
A Caddy container also cannot see another stack's container name unless both are on the same Docker network.

*Option 1, same network (cleanest).* Find Caddy's network (`docker inspect caddy` or the Networks tab in Dockge), attach the VTT stack to it, and use the container port:

    # in the Foxyverse VTT stack
    services:
      foxyverse-vtt:
        ...
        networks: [default, caddy_net]
    networks:
      caddy_net:
        external: true
        name: <the exact name of Caddy's network>

    # Caddyfile
    vtt.example.com {
        reverse_proxy foxyverse-vtt:3000
    }

*Option 2, go through the host.* No shared network needed, use the published port and the machine's address:

    vtt.example.com {
        reverse_proxy 192.168.1.50:3010      # the server's LAN IP and the published port
    }

(`localhost` would point at Caddy's own container, not the host.) Caddy streams the live-update connection (Server-Sent Events) fine;
if updates ever lag, add `flush_interval -1` inside the `reverse_proxy` block. Make sure the DNS record of the hostname points to your server.
`TRUST_PROXY=1` makes login throttling use the real client address, and cookies become `Secure` automatically behind HTTPS.

Nginx: set `proxy_buffering off;` for the location. Traefik works with its default settings.

### Updating

Push to GitHub, wait for the green workflow, then in Dockge click **Update** on the stack (or `docker compose pull && docker compose up -d`). The database upgrades itself.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | listen address (inside the container) |
| `DATA_DIR` | `/data` (Docker) | database and uploads |
| `INVITE_CODE` | generated | fixed invite code (then it cannot be changed in the app) |
| `TRUST_PROXY` | off | `1` behind a reverse proxy |
| `UPLOAD_MAX_MB` | `25` | map and image upload limit for the GM (players: 5 MB images) |
| `AUDIO_MAX_MB` | `60` | audio upload limit (GM only) |

---

## Where your data lives

Everything is saved: accounts, character sheets, scenes, walls, tokens, journals, compendium, sounds and **all uploaded images and audio**. It is a SQLite
database (`foxy.db`, plus `-wal` and `-shm` files) and an `uploads/` folder, all inside one directory: `/data` in the container.

* With a **named volume** (`foxyverse-data:/data`) Docker stores it in its own area, **not in your stack folder**. Dockge prefixes the stack name, so a stack called `vttest`
  makes `vttest_foxyverse-data`. Find it with `docker volume inspect vttest_foxyverse-data` (the `Mountpoint`, usually `/var/lib/docker/volumes/vttest_foxyverse-data/_data`).
* With a **bind mount** (`./data:/data`) it is a real `data/` folder next to your compose file (in Dockge: `/opt/stacks/<stack>/data`). The container runs as user 1000, so create
  it first: `mkdir data && sudo chown -R 1000:1000 data`. If the app cannot write there it stops and prints this advice.

**Move an existing named volume into the stack folder** (stack named `vttest` here):

    cd /opt/stacks/vttest
    docker compose down                       # or Stop in Dockge: copy while nothing is writing
    mkdir -p data && sudo chown 1000:1000 data
    docker run --rm -v vttest_foxyverse-data:/from -v /opt/stacks/vttest/data:/to debian:bookworm-slim cp -a /from/. /to/
    # edit the compose file: replace "- foxyverse-data:/data" by "- ./data:/data" and delete the "volumes:" block at the bottom
    docker compose up -d

**Backups:** stop the stack and copy the `data` folder (or the volume):

    docker run --rm -v vttest_foxyverse-data:/data -v "$PWD":/backup debian:bookworm-slim tar czf /backup/foxyverse-backup.tgz -C /data .

Avoid network shares (NFS/SMB) for the data folder: SQLite needs proper file locking.

---

## Guided tour

### 1. First launch
Register: the first account is the GM. Everyone else needs the **invite code**: GM, **Table** tab, *Players* section. It is generated for you; you can **regenerate** it or **type your own**
(4-40 letters, digits, `-`, `_`). With the `INVITE_CODE` variable it is fixed. Players open the address, choose *Create an account* and enter the code. The GM can promote another account to GM in the same section.

### 2. Build a scene (GM, Table tab)
Create a scene with a map image (PNG, JPEG, WebP or GIF). Set the **grid size** in pixels so it matches your map, and the offset if the grid does not start at the corner.
The dropdown at the top right of the map lets you **prepare any scene** while players keep seeing the active one; *Show to players* switches everybody over.
Mouse wheel zooms, right/middle-drag pans, two-finger pinch works on touch screens, the arrows button fits the map.

### 3. Characters and tokens
**Sheets** tab, *New character*. Fill stats, level and equipment. The GM can assign the character to a player (GM section at the bottom of the sheet) and press **Place token**.
Double-click a token to open its sheet. Players move their own tokens only. Tokens snap to the grid.
Select a token (GM) to edit its name, size, linked character, **vision**, **light**, whether it **shares its sight with all players**, colour, image, or hide it.

### 4. Rolling
Type in the chat or click buttons on the sheet. `/int`, `/str +2` (a stat check: d20 roll-under with a modifier), `/pdmg 2d6+str`, `/pdmg 10 2d4|label`, `/gm /pdmg 1d8` (GM-only).
The card shows each die, the total, the formula with your stats filled in, and the grade. The GM selects tokens on the map and presses **Apply** on a damage / heal / mana card;
players can apply heals and mana to themselves. **Reroll** costs a player one favor; the GM rerolls for free.

### 5. Equipment
Each item says where it can be worn with a **slot expression**, and is placed with the slot picker or by clicking the silhouette. See [Equipment slots](#equipment-slots).

### 6. Walls, doors, lights and fog (GM)
Turn on **Fog** (and **Darkness** for a dark map). Draw walls with the tools at the bottom left of the map (see [Map tools](#map-tools)). Players only see what their tokens can see.

### 7. Journal, sound, compendium
*Journal*: write notes and handouts, choose who sees them, press **Show to players** to pop one open on every screen. *Sound*: upload audio and start sounds for everyone at once.
*Compendium*: save items, spells, talents and NPC templates from sheets (the `⇪` button) and let players copy items, spells and talents onto their sheets.

### 8. Make the rules yours
**System** tab (GM): edit stats, derived formulas, roll types, knowledge tiers and the rules text; changes apply to every sheet instantly. Export / import the whole system as a JSON file.

---

## Reference

### Roles and permissions
| | GM | Player |
|---|---|---|
| Scenes, walls, lights, journal, sound, compendium, system, invite code | yes | no |
| All characters and tokens | yes | only their own |
| Move tokens | all | own tokens |
| Upload | images, maps, audio | images up to 5 MB |
| Reroll a roll | free | costs a favor |
| Apply damage to tokens | yes | no (heals / mana on self only) |

### Rolls
`/type [count] formula|label`. A type is a stat id or alias (`con str int per soc agi foc` and French names), a roll type (`pdmg mdmg tdmg heal theal mana roll`, aliases `dgtp dgtm dgtb soin`...) or a quick roll (`speed`).
A leading number is a repeat count: `/pdmg 10 2d4`. Clicking `[str +2|label]` in a journal, rules text or chat runs the same command.

*Stat checks:* if the formula has no dice, `1d20` is put in front (`+2` becomes `1d20+2`). Success when the total is **at most** the stat. The first die decides the grade: rolling its **minimum** raises the grade one step,
rolling its **maximum** lowers it (so nat 1 on a failure is a success, nat 1 on a success is a critical success, nat max on a success is a failure, on a failure a critical failure). Comparisons (`1d20 < 10`, `1d20 > 15`) grade the same way, reversed for `>`.

*Formula language:* `XdY` (X and Y can be expressions), `+ - * ^ ( )`, `/` divide rounding to nearest, `\` divide rounding down, `%` divide rounding **up** (not modulo), `<` means at most and `>` at least, `expr !< n` / `!> n` clamp the total,
`min() max() floor() ceil() round() abs()`. Variables: every stat and derived value with its aliases, plus `lvl elemental bonact bonspe pdef mdef curhp temhp curmp curfav`. Unknown names are 0. A `d` right after a number, a name or `)` is the dice
operator (`2dcon`, `lvld6`), so you can also write `d6` for one die.

### Defenses and damage
Only **equipped** items count (including items placed in *Other*). `DP` reduces each physical hit, `DM` each magical hit, true damage ignores both. Temporary HP goes first. At 0 mana spells cost HP.
**Elementals** have 1 HP, ignore physical damage and lose mana (after temp HP) from other damage.

### Equipment slots
33 slots: `weapon1-3`, `hat`, `face`, `pendant1-3`, `torso`, `rshoulder lshoulder`, `rarm larm`, `rwrist lwrist`, ten finger slots (`rthumb rindex rmiddle rring rpinky`, `lthumb ...`), `belt`, `rleg lleg`, `rankle lankle`, `rfoot lfoot`, and **`other`**
(carried but not in a slot: a magical tattoo, still gives its bonuses). One item per slot; the picker greys out occupied choices.

An item's **Usable slots** field is an expression (English or French names; accents and case ignored):

| Syntax | Meaning |
|---|---|
| `hat` / `chapeau` | that slot |
| `[weapons]` | one of the three weapon slots (default for weapons) |
| `a \| b` or `a or b` | either |
| `a + b`, `a & b`, `a and b` | both at once (a two-handed weapon: `weapon1 + weapon2`) |
| `[fingers]*2` | any two slots of the group; `[weapons]*all` takes the whole group |
| `[upper] - (rwrist \| lwrist)` | the group without these slots |
| `( ... )` | grouping |

Groups: `weapons head necklace upper shoulders arms wrists fingers rfingers lfingers lower legs ankles feet fullrarm fulllarm fullrleg fulllleg`
(French: `armes tete collier haut epaules bras poignets doigts doigtsd doigtsg bas jambes chevilles pieds`). The field shows how many choices an expression gives, or what is wrong with it.
On the silhouette: hover a slot for its name and item, click an equipped slot to open its item, click an empty slot for a list of items that can go there.

### Map tools
| Tool | How it works |
|---|---|
| Select | click/shift-click tokens, drag to move, double-click for the sheet |
| Wall | click points to chain walls; right-click or Esc finishes |
| Rectangle / Circle | drag; rectangle is 4 walls, circle is a polygon sized to its radius |
| Curve | click start, click end, move to bend (quadratic Bézier), click to confirm; Esc cancels |
| Door | click to place; click an existing door to open or close it (open doors do not block sight) |
| Edit | drag a wall corner; all walls attached to it follow |
| Light | click to place a light of the chosen radius (cells); tokens can also emit light |
| Reveal | drag a rectangle to reveal it permanently |
| Erase | click a wall, light or revealed area to delete it |

**Snapping** (selector appears with the drawing tools): *Grid* (cell corners), *Half cell*, *Free*. Hold **Shift or Alt** to place freely for one click, ignoring both the grid and magnetism to existing corners.
Wall ends are magnetic by default so corners close cleanly. **Undo** with the button or Ctrl+Z (60 steps, per scene).

### Fog, vision and darkness
* **Lit scene:** a player sees whatever is in line of sight of their tokens (limited to `vision` cells if set; 0 means unlimited).
* **Dark scene:** a player also needs light: a placed light, a token with `light`, or darkvision (`vision` cells). Light does not pass through walls either.
* **Whose eyes:** tokens linked to a player's character, plus any token with **Shares its sight** ticked. A player with no token on the scene sees nothing.
* **Player view** (GM, next to the Fog switch): shows exactly what players see, with a selector: *All players*, one player, or the *Selected token* (handy to test with a GM-owned character).
  If no token gives sight, a red notice explains why the map is black.
* Fog is enforced in the browser: the full map image is delivered to every player (as in other virtual tabletops), so do not rely on it to hide secrets from a determined player.

### Journal and handouts
Markdown subset: `# heading`, `- list`, `**bold**`, `[str +2|label]` roll buttons, an optional image. Visible to the GM only, everyone, or chosen players.

### Sound
Upload MP3, OGG, WAV, M4A, FLAC or WebM. Sounds start for every connected client in sync (late joiners jump to the right position). Loop and volume per sound; each person has a volume slider and mute.
Browsers block sound until the page has been clicked once, so an *Enable sound* button appears when needed.

### Compendium
Items, spells and talents are shared (players can copy them onto their sheets); NPC templates are GM-only and create a character plus a token in one click. Entries are created from sheets and can be renamed or deleted.

### System editor
Forms for stats (id, label, aliases), character creation values, derived formulas (with a live result against the selected character), quick rolls, roll types, knowledge tiers and rules text, plus a raw JSON view.
The derived values `maxhp`, `maxmp`, `maxfav` and `act` are required. Names are letters and underscores only. Defaults: max HP `con*(lvl+1)`, max mana `((int+foc)*3+lvl^2)/4`, favors `(lvl+1)%3`, actions `max(1, lvl\5 + agi\10) + bonact`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `port is already allocated` | another container uses the host port: change the left number of `ports` |
| Caddy cannot reach the app | use container port 3000 on a shared Docker network, or the host IP with the published port (see above) |
| Container exits, log says it cannot write to the data folder | bind mount owned by root: `sudo chown -R 1000:1000 <folder>` or use a named volume |
| `denied` / `unauthorized` when pulling the image | the GitHub package is private: make it public or `docker login ghcr.io` |
| Map is completely black in player view | no token gives sight: link a token to a player's character, tick *Shares its sight*, or choose *Selected token* |
| Dark scene is black for players | add a light, give the token `light`, or give the player token `vision` (darkvision) |
| No sound | click anywhere on the page (browser autoplay rule) or press *Enable sound*; check the mute switch |
| Cannot find my data | see [Where your data lives](#where-your-data-lives) |

---

## Development

    node --test test/*.test.js        # engine, rules, vision geometry, server API (no dependencies needed)
    node scripts/smoke.mjs http://localhost:3000    # end-to-end check of a running server or container
    ./scripts/docker-smoke.sh          # build the image, run it, check stop time and persistence

    server/engine.js    formula language       server/rules.js   system validation, rolls, equipment, damage
    server/index.js     HTTP, live updates, API   server/db.js   SQLite schema and migrations
    public/             the client (vanilla JS, no build step); vision.js and slots.js are shared with the server
    public/icons/       your icon set          system/           the default Foxyverse system

Credits: the slot grammar, dice rules and icons come from the Foxyverse Owlbear plugin by the same author.
