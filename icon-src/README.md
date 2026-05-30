# Icon sources

Design sources for the Frost app & tray icons. These files are the *only*
copies of the original artwork — the PNGs / `.icns` / `.ico` under
`src-tauri/icons/` are generated from them.

| File | What it is |
| --- | --- |
| `AppIcon.afdesign` | Affinity Designer source for the app icon (Dock + Finder, the icon you see in the bundle). |
| `AppIcon.svg` | SVG export of the app icon — feed this to `cargo tauri icon` to regenerate the `.icns` / `.ico` / PNG sizes. |
| `TrayIconFull.afdesign` | Affinity Designer source for the menu-bar tray icon shown when credentials are fresh. |
| `TrayIconEmpty.afdesign` | Affinity Designer source for the menu-bar tray icon shown while a refresh is in progress. |

## Regenerating `src-tauri/icons/`

The desktop bundle needs five files (referenced in `src-tauri/tauri.conf.json`):

```
src-tauri/icons/32x32.png
src-tauri/icons/128x128.png
src-tauri/icons/128x128@2x.png
src-tauri/icons/icon.icns
src-tauri/icons/icon.ico
```

Plus the two template tray icons (referenced in `src-tauri/src/lib.rs` via
`include_bytes!`):

```
src-tauri/icons/TrayIconFull.png   + @2x.png
src-tauri/icons/TrayIconEmpty.png  + @2x.png
```

To rebuild the bundle icons from a 1024×1024 master PNG (export it from
`AppIcon.afdesign` first):

```sh
cargo tauri icon icon-src/AppIcon.png
```

`cargo tauri icon` writes into `src-tauri/icons/`. It generates extra
platform variants (Android, iOS, Windows tiles) we don't ship — feel free to
delete those after regenerating; the desktop bundle doesn't need them and
the Tauri config doesn't reference them.

The tray PNGs are 1× / 2× exports of the corresponding `.afdesign` files
(monochrome templates, so the macOS menu bar can theme them light/dark).
There's no tooling that re-generates these from the `.afdesign`; export them
from Affinity Designer when you change the artwork.
