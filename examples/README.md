# Example mappings

**Check the env vars first:** for the common case — "only sync the cores I
use" — you don't need a JSON file at all. Set `RETROARCH_CORES` (and
optionally `SYSTEMS`) in your compose environment and the built-in mapping
is filtered for you. The files below are for setups the filters can't
express, or as references for writing a full custom mapping.

The default mapping syncs to every core folder it knows about, which is
thorough but creates a lot of duplicate saves. These examples are minimal
starting points — mount one at `/config/mapping.json` and edit the core
folder names to match the cores you actually use (names must match your
`saves/` subfolders exactly; the startup log prints what loaded).

| File | Covers |
|---|---|
| `mapping.one-core-per-system.json` | Every supported system, one RetroArch core each. Recommended starting point. |
| `mapping.cartridge-classics.json` | NES, SNES, GB/GBC, GBA, Genesis/SMS/Game Gear only. |
| `mapping.disc-era.json` | PC Engine (incl. CD), PS1, Saturn, Sega CD, N64 only. |

A custom file's `systems` object replaces the default wholesale (it is the
complete mapping, not a diff). Top-level `ignore` rules are inherited from
the defaults when omitted, as these examples do.
