# mister-retroarch-save-sync

A Docker container that keeps game saves **converted** between a MiSTer saves
tree and a RetroArch saves tree (typically the folder a WebDAV server exposes
to RetroArch's cloud sync). Change a save anywhere — on the MiSTer, or in any
RetroArch core's folder — and it is converted and copied to every other
compatible location, in the format that location needs.

Save format conversion logic comes from
[save-file-converter](https://github.com/euan-forrester/save-file-converter)
by Euan Forrester (GPL-3.0), vendored under `vendor/` and bundled at image
build time. This project is licensed GPL-3.0-or-later accordingly (see
[License](#license)).

## Scope: bring your own sync

This tool does exactly one thing: it watches two directory trees that are
both visible to the container and keeps the saves in them converted between
MiSTer and emulator formats.

**It does not move files to or from your machines.** How the MiSTer reads
and writes its side of the tree (SMB share, Syncthing, NFS, rsync, a script —
whatever works for you) is your setup, not this tool's. How RetroArch reads
and writes its side (a WebDAV server pointed at the RetroArch tree for cloud
sync, Syncthing, manual copies) is equally up to you. Whatever transport you
choose, this container sits on the box that can see both trees and makes sure
that when a save lands on one side, a correctly converted copy exists on the
other.

The one nod to a specific transport is `manifest.server`: RetroArch's cloud
sync expects the server to maintain a manifest of file hashes, and plain
WebDAV servers don't compute one. When `WRITE_MANIFEST=true` (the default),
the container regenerates `manifest.server` next to the `saves/` directory
after every change, and prunes it when files are deleted — so any standard
WebDAV server becomes a valid RetroArch cloud-sync backend with zero
server-side logic. If you don't use WebDAV cloud sync, set
`WRITE_MANIFEST=false` and ignore it.

## How it works

* One recursive `inotifywait` watcher per tree (`close_write`, `moved_to`,
  `create`, `modify`, plus `delete`/`moved_from` for manifest maintenance),
  with per-file settling so a core flushing a save in several writes triggers
  a single sync. `modify` matters because some SMB servers hold save files
  open across writes and never emit `close_write`.
* Each changed file is converted to a canonical "raw" (emulator) form using
  save-file-converter's MiSTer modules, then fanned out to every location in
  its system group in whatever form that location needs (padding, byte
  expansion/collapse, RTC stripping, splitting/joining multi-part saves).
* Loop-safe: a target is only written when it doesn't already hold equivalent
  data. Equivalence is byte-identical, identical up to uniform end padding, or
  round-trip identical (e.g. a MiSTer GBA file with appended RTC data is never
  clobbered by its RTC-less RetroArch twin). Events caused by the container's
  own writes are recognized by hash and ignored.
* On startup a full reconcile runs: for every game, the most recently modified
  copy wins and is propagated everywhere. An optional periodic reconcile
  (`RECONCILE_INTERVAL_MIN`) catches writes inotify can't see — essential when
  a network filesystem sits between the writer and the container.

## Why saves get duplicated

RetroArch stores saves **per core**, not per system (with "sort saves by
core" enabled, which this layout assumes). That creates two problems this
tool solves by duplication:

1. **RetroArch can't share a save between two cores.** If you play a Game Boy
   game in mGBA today and Gambatte tomorrow, RetroArch looks in two different
   folders. So every save is copied to *every* core folder in its system
   group — a Gambatte save also lands in mGBA, SameBoy, and so on.

2. **A save file often doesn't say which sub-system it belongs to.** mGBA's
   folder holds both GB and GBA saves, and at overlapping sizes the bytes
   genuinely can't be told apart, so its saves are duplicated to both the
   MiSTer GAMEBOY-family folders *and* the GBA folder. Likewise MiSTer splits
   GAMEBOY / GBC / SGB and Genesis / MegaDrive into separate folders that
   RetroArch knows nothing about, so saves are copied to all of them. Extra
   copies in folders a game doesn't belong to are harmless — the MiSTer core
   simply never loads them.

Where the bytes *do* reliably distinguish systems, content-based
discrimination is used instead of blind duplication: the multi-system Sega
cores (Genesis Plus GX, Genesis Plus GX Wide, PicoDrive) hold Genesis, Master
System, and Game Gear saves in one folder, and emulator Genesis SRAM is
byte-expanded while SMS/GG SRAM is raw — so a Genesis save is only routed to
the Genesis/MegaDrive folders, and an SMS/GG save only to SMS/GameGear. No
wrong-format save ever lands in the wrong MiSTer folder.

## Supported systems and default cores

Every location in a group is kept in sync with every other — including
RetroArch core → RetroArch core duplication.

| System | RetroArch core dirs (defaults) | RA ext | MiSTer dirs | Notes |
|---|---|---|---|---|
| NES | FCEUmm, Nestopia UE, Nestopia, QuickNES, Mesen, bnes/higan, Emux NES, fixNES, nes, RustyNES | .srm | NES | .sav padded to 32 KiB |
| SNES | bsnes-jg, bsnes-hd beta, bsnes, bsnes-mercury Accuracy/Balanced/Performance, bsnes 2014 Accuracy/Balanced/Performance, bsnes C++98 (v085), Snes9x, Snes9x 2002/2005/2005 Plus/2010, Mesen-S, Beetle bsnes, Beetle Supafaust, ChimeraSNES, nSide (Super Famicom Balanced/Accuracy) | .srm | SNES | |
| GB / GBC | Gambatte, mGBA, SameBoy, Gearboy, TGB Dual, VBA-M, DoubleCherryGB, Boytacean, Emux GB, fixGB, IroGB, Mesen-S | .srm | GAMEBOY, GBC, SGB | duplicated to all three MiSTer folders |
| GBA | mGBA, VBA-M, VBA Next, gpSP, Beetle GBA, Meteor, TempGBA, SkyEmu | .srm | GBA | EEPROM padded to 8 KiB; MiSTer RTC tail stripped for emulators |
| Genesis | Genesis Plus GX, Genesis Plus GX Wide, PicoDrive, BlastEm, ClownMDEmu | .srm | Genesis, MegaDrive | byte-collapsed, 0xFF-padded; content-discriminated |
| Master System | SMS Plus GX, Gearsystem, Emux SMS (+ the multi-system Sega cores) | .srm + .sav | SMS | padded to 32 KiB; content-discriminated |
| Game Gear | SMS Plus GX, Gearsystem (+ the multi-system Sega cores) | .srm + .sav | GameGear | content-discriminated |
| PC Engine / TurboGrafx-CD | Mednafen PCE, Mednafen PCE Fast, Beetle PCE, Beetle PCE Fast, Beetle SuperGrafx, Geargrafx | .srm + .sav | TGFX16 | BRAM verified; CD saves are the same BRAM and work as-is |
| PS1 | Beetle PSX, Beetle PSX HW, PCSX ReARMed, PCSX-ReARMed, PCSX ReARMed [NEON], PCSX ReARMed [Interpreter], PCSX1, DuckStation, SwanStation, Rustation | .srm + .mcr | PSX | raw 128 KiB memory card |
| N64 | Mupen64Plus-Next, mupen64plus_next_gles2, mupen64plus_next_gles3, ParaLLEl N64, ParaLLEl (Debug) | .srm + .eep/.sra/.fla | N64 | .eep/.sra/.fla by save chip + `_1`..`_4`.cpk Controller Paks |
| Saturn | Beetle Saturn, Mednafen Saturn | .bkr + .bcr | Saturn | byte-expanded internal [+ cart] |
| Sega CD | Genesis Plus GX, Genesis Plus GX Wide | .brm | MegaCD | requires per-game BRAM (see below) |

### N64 details

RetroArch's mupen64plus-next/ParaLLEl `.srm` is a combined image
(EEPROM 2 KiB + 4 Controller Paks + SRAM 32 KiB + FlashRAM 128 KiB
= 296960 bytes). The container splits and joins it:

* A MiSTer-side part change (`.eep`/`.sra`/`.fla`/`_N.cpk`) gathers *all* of
  that game's part files from the MiSTer folder in one merge over the
  freshest existing combined `.srm` (other regions preserved), which is then
  written to every RetroArch core folder. A part file older than the newest
  `.srm` is treated as superseded and never regresses newer data.
* A combined `.srm` change extracts whichever regions actually contain data
  and writes them as MiSTer save files. An existing 512-byte `.eep` stays
  512 bytes rather than growing to 2 KiB.
* Controller Pak files (`<game>_1.cpk` .. `<game>_4.cpk`) are raw 32 KiB
  memory card images and are treated as such — unformatted paks and homebrew
  layouts sync as-is, with no filesystem validation. Pak slots that were
  never touched are not written out.

### Saturn details

RetroArch (Beetle Saturn) keeps two per-game files: `<game>.bkr` (internal
backup RAM, 32 KiB) and `<game>.bcr` (backup cartridge, 512 KiB); the
`.smpc` clock file is ignored. The MiSTer file is both parts byte-expanded
and concatenated (64 KiB, or 64 KiB + 1 MiB with a cart). An empty
placeholder `.bcr` — Beetle creates one on boot — does not grow a cart-less
MiSTer save; the cart section appears once the cart actually holds data.
Kronos is not supported (it writes its own `.ram` format into a subfolder).

### Sega CD details

Set the Genesis Plus GX core option **CD System BRAM = per game** so saves
are named `<game>.brm` and can be matched across sides (the default per-BIOS
mode writes shared `scd_U/E/J.brm` files, which are ignored). The RAM cart
(`cart.brm`) is shared across games on the RetroArch side and therefore not
synced; a cart section found in a MiSTer save is preserved on every write,
never dropped. PicoDrive's combined `.csm` format is not supported.

## Customizing the mapping (`mapping.json`)

The core/folder mapping is data, not code. Mount a JSON file at
`/config/mapping.json` to override it:

```yaml
volumes:
  - ./mapping.json:/config/mapping.json:ro
```

The file has the same shape as `DEFAULT_MAPPING` in `src/mapping.js`:

```jsonc
{
  "systems": {
    "nes": {
      "retroarch": ["FCEUmm", "Nestopia UE"],   // core folder names under saves/
      "retroarchExts": ["srm"],                 // extensions read AND written on the RA side
      "mister": ["NES"],                        // folder names under the MiSTer saves root
      "misterExts": ["sav"]
    },
    "genesis": {
      "retroarch": ["Genesis Plus GX"],
      "retroarchExts": ["srm"],
      "mister": ["Genesis", "MegaDrive"],
      "misterExts": ["sav"],
      "discriminate": "genesisLike"             // content check for multi-system cores
    }
    // ... every system you want synced
  },
  "ignore": ["retroarch.cfg", "manifest.server"],
  "ignoreExtensions": ["rtc", "state", "tmp"],
  "ignoreSubstrings": ["_bak"]
}
```

Things to know:

* **The `systems` object replaces the default wholesale.** A custom file is
  the complete mapping, not a diff — start from `DEFAULT_MAPPING` in
  `src/mapping.js` and edit. The most common edit is trimming `retroarch`
  core lists down to the cores you actually use, which also stops saves from
  fanning out into dozens of folders.
* The same folder may appear in several systems (mGBA in `gb` and `gba`;
  the Sega cores in `genesis`, `sms`, `gg`, and `segacd`). Groups with a
  `discriminate` field route by content; groups without one duplicate
  blindly.
* `misterExts: ["*"]` (N64 only) means the MiSTer extension is derived from
  the save chip type.
* Names are matched case-insensitively. The startup log prints the loaded
  system list so you can confirm the file took effect.

## Quick start

No clone needed — a prebuilt multi-arch image (amd64/arm64) is published to
GitHub Container Registry by CI on every push:

```yaml
# docker-compose.yml
services:
  save-sync:
    image: ghcr.io/juaniwck/mister-retroarch-save-sync:latest
    restart: unless-stopped
    volumes:
      - /path/containing/saves-and-manifest:/retroarch   # holds saves/ + manifest.server
      - /path/to/mister/saves:/mister/saves              # MiSTer saves root (NES/, SNES/, ...)
      # optional:
      # - ./mapping.json:/config/mapping.json:ro
```

```bash
docker compose up -d
docker compose logs -f
```

Pin a version tag (`:v1.0.0`) instead of `:latest` if you prefer immutable
deploys. To build from source instead, clone the repo and replace the
`image:` line with `build: .`, then `docker compose up -d --build`.

Set `DRY_RUN=true` for a first run to see what would be written without
touching anything.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `RETROARCH_ROOT` | `/retroarch` | Directory containing `saves/`; `manifest.server` is written here |
| `MISTER_SAVES` | `/mister/saves` | MiSTer saves root (contains NES/, SNES/, PSX/, ...) |
| `SYNC_ON_START` | `true` | Full reconcile at startup |
| `WRITE_MANIFEST` | `true` | Maintain `manifest.server` for RetroArch WebDAV cloud sync |
| `CREATE_MISSING_DIRS` | `true` | Create target core/system folders that don't exist yet |
| `SETTLE_MS` | `1500` | Quiet time after the last inotify event before syncing a file |
| `MANIFEST_DEBOUNCE_MS` | `3000` | Debounce for manifest regeneration |
| `RECONCILE_INTERVAL_MIN` | `0` | Periodic full reconcile (minutes); see network mounts below |
| `MAPPING_FILE` | `/config/mapping.json` | Custom mapping override |
| `DRY_RUN` | `false` | Log intended writes without writing |

## The manifest

RetroArch's WebDAV cloud sync compares the client state against a
`manifest.server` file — a JSON array of `{ path, hash }` for every file
under `saves/` — that the server is expected to maintain. Standard WebDAV
servers don't do that, so this container does: the manifest is regenerated
(full fresh walk, debounced) after every RetroArch-side change, including
deletions — deleted saves and removed core folders drop out of the manifest
immediately via inotify delete events, with a periodic missing-file scan as
the fallback for deletions the watcher can't see.

## Caveats

* **Network filesystems:** inotify only reports writes made through the local
  mount. If either tree reaches the container over CIFS/NFS and the writes
  happen on the far side, set `RECONCILE_INTERVAL_MIN` (e.g. `1`–`5`) so
  remote changes are picked up by periodic reconciles.
* **Deletions are not propagated** — deleting a save in one place leaves the
  copies alone (and the next reconcile restores it from them). Delete a save
  everywhere if you really want it gone. Deletions *are* reflected in the
  manifest.
* **RTC sidecar files** (`.rtc`, `.rtch`) are not synced: Gambatte and mGBA
  use incompatible RTC formats, so translating them would corrupt clocks.
  In-file RTC data (MiSTer GBA tail) is handled.
* **Conflicts:** last writer wins. Don't play the same game on both machines
  at the same time and expect a merge.
* Back up your saves before first run. Seriously.

## Development

```bash
npm install
npm run build          # bundles vendor/ into dist/converter.cjs with esbuild
for t in test/*.test.js; do node "$t"; done
```

## License

GPL-3.0-or-later. See `LICENSE`.

This project incorporates and links with code from
[save-file-converter](https://github.com/euan-forrester/save-file-converter),
Copyright (C) Euan Forrester, licensed under the GNU General Public License
v3.0 (a copy is included at `vendor/save-file-converter/LICENSE` and shipped
in the image as `LICENSE.save-file-converter`). In accordance with the GPL,
the complete corresponding source of this project — including the vendored
converter code — is distributed alongside the container image definition.
