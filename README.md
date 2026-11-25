# Foxyverse VTT

A self-hosted virtual tabletop for the **Foxyverse** ruleset. It runs as one small container, needs no database server and no npm
install, and the rules themselves (stats, formulas, roll types, rules text) are **data you edit inside the app**.

* Real-time shared map with tokens, walls (sight and / or movement), doors, lights and anti-lights, teleport cells, fog of war with exploration memory, darkness and darkvision
* Tabs on the left and chat on the right, both foldable; any tab can float in its own window
* Character sheets driven by your formulas, with the full 33-slot equipment system and silhouette
* Dice chat with the Foxyverse roll language, nat 1 / nat max grading, favors and one-click damage/heal application
* Journal and image handouts, synchronized soundboard, compendium of items / spells / talents / NPC templates
* Several **tables** (each one is a separate game, like a save file: its own scenes, sheets, chat, rules...), a map library outside tables
* Players pick their player at the table's address, no password; the GM area sits behind your reverse proxy's login (Authelia). English and French interface

Contents: [Install](#install) · [Docker, Dockge and reverse proxies](#docker-dockge-and-reverse-proxies) · [Where your data lives](#where-your-data-lives) ·
[GM access](#gm-access-caddy--authelia) · [Guided tour](#guided-tour) · [Reference](#reference) · [Troubleshooting](#troubleshooting) · [Development](#development)

---

## Install

### Option A: the published image (recommended)

The GitHub workflow in `.github/workflows/docker.yml` runs the tests, builds the image, **starts the container and smoke-tests it**, and only then
publishes `ghcr.io/<your-user>/<repo>:latest` for amd64 and arm64. On your server:

    docker run -d --name foxyverse-vtt --init --restart unless-stopped \
      -p 127.0.0.1:3000:3000 -v foxyverse-data:/data \
      ghcr.io/<your-user>/foxyverse-vtt:latest

(use the repository name in lowercase). If the package is private, make it public in GitHub (Packages, Package settings) or `docker login ghcr.io`.

### Option B: build it yourself

    docker compose up -d --build

### Option C: no Docker

    node server/index.js        # Node 22.13 or newer, nothing to install

Open `http://localhost:3000/admin` to create a table, then share `http://localhost:3000/<table address>` with the players.
Without `ADMIN_SECRET` (see [GM access](#gm-access-caddy--authelia)) `/admin` is open to anyone who can reach the port: fine on your machine, not on the Internet.

---

## Docker, Dockge and reverse proxies

### A ready stack for Dockge (or any compose file)

Caddy reaches the app over a shared Docker network, so **no port is published on the Internet** (the GM area must only be reachable through Caddy and Authelia):

    services:
      foxyverse-vtt:
        image: ghcr.io/<your-user>/foxyverse-vtt:latest
        container_name: foxyverse-vtt
        init: true
        restart: unless-stopped
        volumes:
          - ./data:/data           # see "Where your data lives" (run: mkdir data && chown 1000:1000 data)
        environment:
          TZ: Europe/Zurich
          ADMIN_SECRET: "paste a long random string here"   # openssl rand -hex 32; the same value goes in the Caddyfile
        networks: [default, caddy_net]
    networks:
      caddy_net:
        external: true
        name: <the exact name of Caddy's network>   # docker inspect caddy, or the Networks tab in Dockge

If Caddy is installed on the host rather than in Docker, publish the port on the loopback only: `ports: ["127.0.0.1:3010:3000"]` and use `reverse_proxy 127.0.0.1:3010`.
Inside Docker the app always listens on **3000**; a published port is `host:container`, so only the left number may change.

### GM access (Caddy + Authelia)

The app has no GM accounts. Everything for the GM lives under **`/admin`** (pages) and **`/admin/api`** (its API); players use `/` and `/<table>`.
The lock is your reverse proxy: Caddy asks **Authelia** before letting anyone into `/admin`, and whoever Authelia lets through is a GM (as many as you like).
So that nobody can walk around Caddy, Caddy adds a secret header that the app checks:

    vtt.example.com {
        @gm path /admin /admin/*
        handle @gm {
            forward_auth authelia:9091 {
                uri /api/authz/forward-auth
                copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
            }
            reverse_proxy foxyverse-vtt:3000 {
                header_up X-Admin-Secret "the same value as ADMIN_SECRET"
            }
        }
        handle {
            reverse_proxy foxyverse-vtt:3000 {
                header_up -X-Admin-Secret
            }
        }
    }

In Authelia's `configuration.yml`, give the hostname a rule (only `/admin` is ever sent to Authelia):

    access_control:
      rules:
        - domain: vtt.example.com
          policy: one_factor        # or two_factor

`authelia:9091` is the Authelia container on the same Docker network (adapt the name). With a recent Authelia (4.38+) the endpoint is `/api/authz/forward-auth`.
Check it: `https://vtt.example.com/admin` must show the Authelia login, and the app answers *403 GM area: missing or wrong X-Admin-Secret* if you reach `/admin` any other way.
If `ADMIN_SECRET` is empty the app runs in **development mode**: `/admin` is open, the GM home shows a warning and the log says so at startup.

Caddy streams the live-update connection (Server-Sent Events) fine; if updates ever lag, add `flush_interval -1` inside the `reverse_proxy` blocks.
Nginx: set `proxy_buffering off;` for the location. Traefik works with its default settings.

### Updating

Push to GitHub, wait for the green workflow, then in Dockge click **Update** on the stack (or `docker compose pull && docker compose up -d`). The database upgrades itself.
Coming from v1 (one global game with accounts): everything moves into a first table called **`test`** (with your edited rules); the old accounts are removed, so create the player slots again in its *Table* tab.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | listen address (inside the container) |
| `DATA_DIR` | `/data` (Docker) | database and uploads |
| `ADMIN_SECRET` | empty | the reverse proxy must send it as `X-Admin-Secret` for every `/admin` request. Empty: development mode, `/admin` open to all |
| `SLOT_GRACE_MS` | `60000` | how long a player slot stays taken after its page closed (reload, network blip) |
| `UPLOAD_MAX_MB` | `25` | map and image upload limit for the GM (players: 5 MB images) |
| `AUDIO_MAX_MB` | `60` | audio upload limit (GM only) |

---

## Where your data lives

Everything is saved: tables, player slots, character sheets, scenes, walls, tokens, journals, compendium, sounds and **all uploaded images and audio**. It is a SQLite
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

### 1. Tables and players
Open **`/admin`** (the GM home). Create a **table**: a name and an address (`vtt.example.com/<address>`; lowercase letters, digits and `-`; words such as `admin`, `api`, `icons`, `uploads` are reserved).
A **listed** table appears on the players' home page `/`; an unlisted one is only reachable through its link (handy so that one table cannot peek at another of the same campaign).
At the table, **Table** tab, *Players*: add one **player slot** per player (name and colour) and send them the link. A player opens it, answers *Who are you?* by picking their slot, and plays. No password.
A slot is held by one browser at a time; closing the page frees it after **60 seconds** (a reload or a network blip keeps it). *Disconnect* frees it at once (ghost connections), *Switch player* at the bottom lets a player pick again.
The GM home also holds the **map library**: maps prepared outside any table (walls, lights, grid), copied into a table with *Copy to…*. A table scene can be copied back into the library with `⇪`.

### 2. Build a scene (GM, Table tab)
Create a scene with a map image (PNG, JPEG, WebP or GIF). Set the **grid size** in pixels so it matches your map, and the offset if the grid does not start at the corner.
The dropdown at the top right of the map lets you **prepare any scene** while players keep seeing the active one; *Show to players* switches everybody over.
Mouse wheel zooms, right/middle-drag pans, two-finger pinch works on touch screens, the arrows button fits the map.

### 3. Characters and tokens
**Sheets** tab, *New character* (GM only). Click the round picture to set a **portrait** (the whole character) and frame its round **token** (drag and zoom; or send a ready-made token): the token is what the map, the chat and the NPC list show. Fill stats, level and equipment. In *Player rights* at the bottom of the sheet, give each player **Edit**, **View only** or **None** (the sheet is then invisible to them); then **Place token**.
Double-click a token to open its sheet. Players move the tokens of the sheets they can edit. Tokens snap to the grid.
Select a token (GM) to edit its name, size, linked character, **vision** (cells, 100 by default, 0 = no vision), **light**, its **state**, whether it **shares its sight with all players**, colour, image, or hide it.
A token whose sheet is at 0 HP or less turns **black and white** (50 % opacity) for everyone and **sees nothing**; the state can force *dead* or *alive*.
The sheet's **Darkvision** box (next to *Elemental*) lets its tokens see without light (see [Fog, vision and darkness](#fog-vision-and-darkness)). The GM also sets each sheet's **`@` alias** there (see below).

### 4. Layout and rolling
Tabs and panels sit on the **left**, the map in the middle, the **chat on the right**. Tabs never scroll (two rows for the GM). Each side can stay open or be **dynamic**:
a thin strip that opens on hover or when typing (the button at the bottom of the tabs, and at the top of the chat). While the chat is folded, each new message shows alone as a **bubble** for 5 seconds; hovering a bubble opens the whole chat.
The `⧉` button on the active tab **pops it out** into a window you can drag (by its title) and resize (bottom-right corner); `⇲` puts it back. Windows come back where they were after a reload (remembered in this browser).

Shift+Enter makes a new line in the chat. Each message shows the speaker's token next to the name; the *As* selector chooses who speaks.
**GM narration:** each sheet has an **`@` alias** (its name without spaces, e.g. `GwenDoline`; a number is added if two sheets would share it; only the GM sees and edits it; `mj` and `gm` are reserved).
Type `@` for the list (typing part of a name finds it too): `@GwenDoline Hello` makes Gwen speak, `@mj The door creaks` narrates in italics, the speaker stays until the next `@`, and the whole text is one message.
Type in the chat or click buttons on the sheet. `/int`, `/str +2` (a stat check: d20 roll-under with a modifier), `/pdmg 2d6+str`, `/pdmg 10 2d4|label`, `/gm /pdmg 1d8` (GM-only). Long rolls wrap onto several lines.
The card shows each die, the total, the formula with your stats filled in, and the grade. Select tokens on the map and press **Apply** on a damage / heal / mana card: the GM on any token,
a player on the tokens of sheets they can edit (the server refuses the others). The result reads *took 25 damage (20−5 + 15−5)*: armor comes off **each roll** separately.
An application can be repeated, and each one has its own `↶` undo (players: on their own sheets). **Reroll** costs the rolling character one favor, GM included (a GM roll with no character is free).

**Talents** are pills with a tier shown as it acts on the d20 (T0 -0, T1 -1, T2 -3, T3 -5, T4 -10) and a description that unfolds. A **ticked** talent applies to every stat check (T2 takes 3 off the d20, an easier roll-under); ticked talents add up; damage and other rolls are untouched. A spell's description can be saved (locked) and unlocked.

### 5. Equipment
Each item says where it can be worn with a **slot expression**, and is placed with the slot picker or by clicking the silhouette. See [Equipment slots](#equipment-slots).
The **+** of a section opens a small window: **New**, or pick an entry of that category **from the compendium** (with a search box).
A **weapon** has a **Damage** line of roll buttons, e.g. `[pdmg 2d30 | physical][mdmg 2d30 | magical]` (the text after `|` is the label): closed, the weapon shows the buttons, which roll in the chat like any other.

### 6. Walls, doors, lights, teleports and fog (GM)
Turn on **Fog** (and **Darkness** for a dark map). Draw walls with the tools at the bottom left of the map (see [Map tools](#map-tools)). Players only see what their tokens can see.

### 7. Journal, sound, compendium
*Journal*: write notes and handouts, choose who sees them, press **Show to players** to pop one open on every screen. *Sound*: upload audio and start sounds for everyone at once.
*Compendium*: every item and spell named on a sheet enters the table's compendium by itself. Players see the entries on the sheets they can see, plus the ones you tick `👁`,
and the NPCs you list (name and picture only). The *Global* view shows every table and the entries outside tables, with filters on tables and campaigns; *Add to this table* makes a copy.

### 8. Campaigns and saved systems (GM home)
A **campaign** ties tables of one story together: pick it in a table's *Table settings* (or when creating a table); what the table creates carries it, which the global compendium can filter on.
A table's rules can be **saved** under a name (*System* tab, *System library*) and applied to another table after a **preview of the differences**. A campaign can have a **linked system**:
new tables of the campaign start with it, and choosing the campaign for an existing table offers to apply it.

### 9. Make the rules yours
**System** tab (GM): edit stats, derived formulas, roll types, knowledge tiers and the rules text of **this table** (each table has its own copy); changes apply to its sheets instantly. Export / import the whole system as a JSON file.

---

## Reference

### Roles and permissions
| | GM | Player |
|---|---|---|
| Tables, player slots, scenes, walls, lights, journal, sound, compendium, system | yes | no |
| Create / delete characters | yes | no |
| See a character | all | the ones they have *Edit* or *View only* on |
| Edit a character, roll and speak as it | all | *Edit* only |
| Move tokens | all, through any wall | tokens of characters they can edit; not through tangible walls or closed doors |
| Open / close doors | all | unlocked doors of the active scene |
| Upload | images, maps, audio | images up to 5 MB |
| Reroll a roll | costs a favor of the rolling character (free without one) | own rolls, costs a favor |
| Apply / undo damage, heals, mana | any token | tokens of characters they can edit |
| `@` aliases | see and edit | never see them |

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
| Select | click/shift-click tokens, drag to move (or the **arrow keys / WASD**, ZQSD on a French keyboard: one cell per press), double-click for the sheet; click a wall, door, light or TP cell to set it up in the inspector (right of the map); drag a light or TP cell to move it |
| Wall | blocks sight and light. Click points to chain walls; right-click or Esc finishes |
| Tangible wall | blocks players' movement (not sight); the GM walks through |
| Rectangle / Circle | drag; rectangle is 4 walls, circle is a polygon sized to its radius (the kind of wall is chosen in the list next to the tools) |
| Curve | click start, click end, move to bend (quadratic Bézier), click to confirm; Esc cancels |
| Door | click twice to place; a door icon sits in its middle: anyone clicks it to open or close (closed: blocks sight, light and movement; open: nothing). *Locked* in the inspector: only the GM |
| Edit | drag a node: every wall attached to it follows; click a segment to add a node there; two nodes merge only when you let go on top of another |
| Light | click to place a light (a small GM-only icon); with Select, drag it, and resize it with the handle on its circle (steps of half a cell); tokens can also carry light |
| Anti-light | like a light, but removes light under its area. It beats every light, unless *Players' light wins* is ticked: then the lights carried by players' tokens still shine |
| TP cell | click a cell to place a teleport cell; cells of the same **group** are linked (2 or more; group set in the inspector; a new cell joins the picked cell's group) |
| Reveal | drag a rectangle to reveal it permanently |
| Erase | click a wall, light, TP cell or revealed area to delete it |

Every wall has two independent properties, **blocks movement** and **blocks sight and light**; the tools are presets, the inspector changes them afterwards.
**Teleport cells:** a token standing on a TP cell shows as a see-through **ghost** on every linked cell. The ghost gives the vision seen from there, and the player can **drag the ghost**: the token teleports to that cell and keeps moving (the server checks that it starts from a linked cell, and checks walls from there). Ghosts are never saved, they follow the token.

**Snapping** (selector appears with the drawing tools): *Grid* (cell corners), *Half cell*, *Free*. Hold **Shift or Alt** to place freely for one click, ignoring both the grid and magnetism to existing corners.
Wall ends are magnetic by default so corners close cleanly. **Undo** with the button or Ctrl+Z (60 steps, per scene).

### Fog, vision and darkness
* **Light (L):** every placed light and every token's `light`, stopped by walls that block light, minus anti-lights. A scene that is not dark is all light.
* **Vision (V):** what the viewing tokens see, each within its `vision` radius (cells; **0 = no vision**, 100 by default) and stopped by walls that block sight. Lights do not extend vision, and vision does not light anything.
* **What a player sees:** in a dark scene, **V ∩ L**; in a lit scene, V. A token with **darkvision** (sheet toggle) sees its whole V without light, but what lies outside L is shown in **black and white**.
* **Whose eyes:** the player's tokens in *Edit* (alive). Tokens they can only *View* count too when the scene has **Shared vision** (box next to *Darkness*), or automatically while the player has no living token in *Edit* on the scene.
  A token with **Shares its sight** gives its vision to everyone (the GM's override). Dead tokens see nothing. A player always sees their own tokens, even in the dark (not the map around them).
* **Exploration memory** (*Table* tab, scene section, on by default): places a player has seen stay **dimmed** instead of going black again, without the tokens; places seen only through darkvision stay black and white.
  It is kept on the server per player and per scene (it survives a reload and follows the player to another device). *Reset exploration…* clears it for one player or everyone.
* **Player view** (GM, next to the Fog switch): shows exactly what players see, with a selector: *All players*, one player (with that player's exploration memory), or the *Selected token* (handy to test with a GM-owned character).
  If no token gives sight, a red notice explains why the map is black.
* Fog is enforced in the browser: the full map image is delivered to every player (as in other virtual tabletops), so do not rely on it to hide secrets from a determined player who reads the network traffic.

### Journal and handouts
Markdown subset: `# heading`, `- list`, `**bold**`, `[str +2|label]` roll buttons, an optional image. Visible to the GM only, everyone, or chosen players.

### Sound
Upload MP3, OGG, WAV, M4A, FLAC or WebM. Sounds start for every connected client in sync (late joiners jump to the right position). Loop and volume per sound; each person has a volume slider and mute.
Browsers block sound until the page has been clicked once, so an *Enable sound* button appears when needed.

### Compendium
* **Per table:** items (by category) and spells, plus an NPC list. An item or spell named on a sheet creates an *auto* entry (matched by kind and name, case-insensitive) that follows the last saved sheet until the GM edits it,
  and disappears when no sheet carries it any more (unless it is visible). The GM edits entries in place and creates new ones; talents stay on sheets.
* **Players** see an entry if it is on a sheet they can edit or view, or if the GM ticked it visible. NPCs listed by the GM show their name and picture only, never the sheet.
* **Global (GM):** all tables and entries outside any table, filtered by table and campaign. *Add to this table* copies an entry (or an NPC sheet); the copy remembers its original,
  and if that original lives outside tables and changes later, the copy shows **↻ Update**.

### System editor
Forms for stats (id, label, aliases), character creation values, derived formulas (with a live result against the selected character), quick rolls, roll types, knowledge tiers and rules text, plus a raw JSON view.
The derived values `maxhp`, `maxmp`, `maxfav` and `act` are required. Names are letters and underscores only. Defaults: max HP `con*(lvl+1)`, max mana `((int+foc)*3+lvl^2)/4`, favors `(lvl+1)%3`, actions `max(1, lvl\5 + agi\10) + bonact`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `port is already allocated` | another container uses the host port: change the left number of `ports` |
| Caddy cannot reach the app | use container port 3000 on a shared Docker network, or the host IP with the published port (see above) |
| `403 GM area: missing or wrong X-Admin-Secret` | the request did not come through Caddy, or the `header_up X-Admin-Secret` value differs from `ADMIN_SECRET` |
| A player's slot says *already playing* | someone holds it, or the page closed less than 60 s ago; the GM can press *Disconnect* in the Table tab |
| Container exits, log says it cannot write to the data folder | bind mount owned by root: `sudo chown -R 1000:1000 <folder>` or use a named volume |
| `denied` / `unauthorized` when pulling the image | the GitHub package is private: make it public or `docker login ghcr.io` |
| Map is completely black in player view | no token gives sight: link a token to a player's character, tick *Shares its sight*, or choose *Selected token*; check the token's `vision` is not 0 and it is not dead |
| Dark scene is black for players | add a light, give the token `light`, or tick *Darkvision* on its sheet |
| A player sees through another character's token | they have *View only* on it and either the scene has *Shared vision*, or none of their own *Edit* tokens on the scene is alive |
| A player cannot move their token somewhere | a tangible wall or a closed door is in the way (the GM can pass) |
| No sound | click anywhere on the page (browser autoplay rule) or press *Enable sound*; check the mute switch |
| Cannot find my data | see [Where your data lives](#where-your-data-lives) |

---

## Development

    node --test test/*.test.js        # engine, rules, vision geometry, server API, access, migration (no dependencies needed)
    node scripts/smoke.mjs http://localhost:3000    # end-to-end check of a running server (SMOKE_ADMIN_SECRET=... if it has one)
    ./scripts/docker-smoke.sh          # build the image, run it, check stop time and persistence

    server/engine.js    formula language       server/rules.js   system validation, rolls, equipment, damage
    server/index.js     HTTP, live updates, API   server/db.js   SQLite schema and migrations
    public/             the client (vanilla JS, no build step); the pure modules vision.js, walls.js, tp.js, slots.js,
                        format.js and layout.js are shared with the server and the tests
    public/icons/       your icon set (door.svg, light.svg, antilight.svg and tp.svg are placeholders: replace them, same names, square)
    system/             the default Foxyverse system

Credits: the slot grammar, dice rules and icons come from the Foxyverse Owlbear plugin by the same author.
