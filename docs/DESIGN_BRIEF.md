# Rate Beacon — Design Brief

This document briefs a design pass over Rate Beacon. The functional app lives
in this repository; the design deliverable should restyle it without changing
its information architecture or data contracts.

See the prompt in the project README / handed to the designer for full
context. Key hard constraints:

- No emojis anywhere in the product.
- Keep the CSS custom-property role names defined in `src/app/globals.css`
  (`--page`, `--surface`, `--surface-2`, `--text-primary`, `--text-secondary`,
  `--text-muted`, `--gridline`, `--baseline`, `--border`, `--shadow`,
  `--accent`, `--accent-soft`, `--accent-ink`, `--series-1`, `--div-low`,
  `--div-mid`, `--div-high`, `--status-*`, `--delta-good-text`) — redefine
  their values, add new roles if needed, but do not rename, so the design
  drops into the existing components.
- Semantic color rules are fixed: diverging blue↔red = price vs market
  median (blue cheaper / red pricier, neutral midpoint); one sequential hue =
  demand magnitude; status colors reserved for advice states and always
  paired with a text label, never color alone. Numbers stay printed in cells.
- Light and dark mode are both first-class.

Screens and components to cover: dashboard (header w/ profile switcher, six
stat tiles, three view tabs — Rate grid, Trends, Rate ladder — context chips,
cell tooltip, history drawer with sparklines), profile setup wizard, empty
states, loading states, error states.

Data shapes come from `src/lib/types.ts` (`GridResponse`, `GridRow`,
`RowSignals`, `RateCell`, `Profile`, `Hotel`).
