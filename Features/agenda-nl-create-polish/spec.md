# Agenda NL create — Proposal A

## Chosen direction

**Single surface + slate focus** (approved from
`Features/UI-Design/mocks/agenda-nl-create-proposals.html`).

## User-visible change

1. Right-click agenda → floating create card.
2. Card is one surface: sentence flush (no nested green-bordered field).
3. Focus ring is cool slate, not theme `--accent` green.
4. Typed `#tag` / time / duration use quiet underlines:
   steel (time), amber (duration), violet (tag).
5. Foot: hairline divider + `↵ Add` hint (unchanged affordance).

## Done

- [x] CSS `.dn-nl-*` matches Proposal A (no green focus/caret/time)
- [x] Foot markup for hint layout
- [x] `npm run build` + `npm run test:e2e:affected -- --base main` (6/6)
- [x] Screenshots viewed (`nl-walk-02/03`) against proposals mock A
