# herdr-mods

Custom herdr-app mods. They are copies of the files in `~/.config/herdr-app`, taken on 2026-11-06.
The type files (`gpui-kit.d.ts`) are not included: herdr-app writes them again.

| Feature | Mod | Notes |
|---|---|---|
| Changes panel (GitHub-style review, Viewed, `x`, comments, discard) | `mods/my-changes` | clone of the shipped `changes` |
| Run panel (pick an app and a simulator, `flutter run`) | `mods/run-menu` | opened from the "▶ Run" button in `my-tabs` |
| Tab bar buttons Run / Changes / Pull requests | `mods/my-tabs` | clone of `tabs` |
| CPU and memory indicators, keep-awake | `mods/my-status` | clone of `workspace-status` |
| Spaces and worktrees: PR colours, CI spinner, reviewers, simulator runs with build timer, drag and drop | `mods/my-spaces` | clone of `spaces` |

`layouts/mine.json` is the layout that places these mods. `keys.json` holds only the shortcuts for them.

## Install on a new Mac

1. Install herdr-app and open it once, so that `~/.config/herdr-app` exists.
2. Copy each folder in `mods/` to `~/.config/herdr-app/mods/`.
3. Copy `layouts/mine.json` to `~/.config/herdr-app/layouts/`. Then run `herdr-app do layout.switch --name mine`.
4. Merge the keys from `keys.json` into the `global` section of `~/.config/herdr-app/keys.json`.
5. Run `herdr-app check mods/<name>` from `~/.config/herdr-app` for each mod.

## Dependencies

- Shipped mods: `my-spaces` and `my-changes` use icons from `workspace-chrome`, `files` and `changes`. The layout also
  uses `pane`, `files`, `changes`, `workspace-chrome` and `worktree-hooks`. A herdr-app install has all of them.
- Programs: `git`, `gh` (logged in), `xcrun simctl`, `hc` (herdr-core), `top`, `vm_stat`, `ps`.
- `my-status` keep-awake also reads `data/claude-tasks/`. The Claude hook `~/.claude/hooks/herdr-app-tasks.py` writes
  this data. That hook is not in this folder.
- The run lines and the Run panel expect the flutter-front repo (`apps/<app>/ios`).

The change log is `~/.config/herdr/herdr-app-migration.md`.
