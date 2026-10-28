# Agenda delete × duration overlap

## Bug
On agenda rows, hover shows the delete `×` absolutely over the trailing duration
(`30m`). Duration used to fade out on hover; after NL editable duration it stays
visible, so the two controls collide.

## Fix
Give delete its own trailing grid column so duration and `×` never share pixels.
Both remain usable on hover.

## Done
- [x] Hovering an agenda task: delete and duration bounding boxes do not intersect
- [x] Duration click still opens the duration popover
- [x] `npm run build` + `npm run test:e2e:affected -- --base main`
- [x] Screenshot `e2e-artifacts/bug-agenda-delete-duration-overlap.png` viewed
