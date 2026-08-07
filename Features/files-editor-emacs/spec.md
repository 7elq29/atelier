# Files editor — basic Emacs keys

## User flow

With focus in the Files tab Monaco editor, standard Emacs navigation works using **Control** (not Command) and **Option (Meta)**:

| Chord | Action |
|-------|--------|
| C-v | Page down |
| M-v (Opt+v) | Page up |
| M-< (Opt+Shift+,) | Beginning of buffer |
| M-> (Opt+Shift+.) | End of buffer |
| C-a / C-e | Beginning / end of line |
| C-n / C-p / C-f / C-b | Next / previous line, forward / back char |
| C-k | Kill to end of line (basic) |
| C-Shift+- (C-_) | Undo |

Cmd+S remains save.

## Done criteria

- Bindings registered when Monaco mounts in `FilesPanel.tsx`.
- `npm run build` / renderer build clean.
