# Shadow design system

This covers the public site and participant app in `app/src`. It records the system as it is and the rules every change must keep. Tokens live in `:root` in `app/src/styles.css`. The site is dark only.

## Colour

### Surfaces

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#07111f` | Page background |
| `--bg-2` | `#0b1728` | Inputs and inset areas |
| `--surface` | `#0f1d31` | Panels |
| `--surface-2` | `#14243a` | Raised panels, secondary buttons |
| `--surface-3` | `#1b2c47` | The lightest surface; text must pass on it |

Borders use `--border` and `--border-strong`, both translucent.

### Text and state

| Token | Value | Role |
| --- | --- | --- |
| `--ink` | `#f3f7ff` | Primary text |
| `--ink-soft` | `#aebbd0` | Secondary text, body copy on panels |
| `--ink-faint` | `#8895a9` | Labels, captions, counts |
| `--accent` / `--signal` | `#34e5ff` | Brand colour: links, focus rings, emphasis. Not a state |
| `--copy` | `#4df0a8` | Paid, confirmed, success |
| `--block` | `#ff5f7e` | Refused, blocked, failed |
| `--warn` | `#ffd166` | Needs attention: pending, expiring, unresolved |

The primary button uses `--cta-bg` with `--cta-fg` text (12.55:1).

Some older rules use `--accent` for a settled or successful state; new work uses the state tokens.

**Colour never carries meaning alone.** A state colour always comes with the word or icon that names the state.

### Contrast

Contrast is computed, never estimated, against every surface the text can sit on. Body text needs 4.5:1. Large text (24px, or 18.66px bold) and information carrying UI boundaries need 3:1.

| Token | `--bg` | `--bg-2` | `--surface` | `--surface-2` | `--surface-3` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `--ink` `#f3f7ff` | 17.64 | 16.75 | 15.77 | 14.56 | 13.06 |
| `--ink-soft` `#aebbd0` | 9.76 | 9.27 | 8.72 | 8.05 | 7.22 |
| `--ink-faint` `#8895a9` | 6.24 | 5.93 | 5.58 | 5.15 | 4.62 |
| `--accent` `#34e5ff` | 12.44 | 11.82 | 11.12 | 10.27 | 9.21 |
| `--copy` `#4df0a8` | 12.94 | 12.29 | 11.56 | 10.68 | 9.58 |
| `--block` `#ff5f7e` | 6.48 | 6.16 | 5.80 | 5.35 | 4.80 |
| `--warn` `#ffd166` | 13.13 | 12.48 | 11.74 | 10.84 | 9.72 |

Ratios use WCAG relative luminance on linearised sRGB: `L = 0.2126R + 0.7152G + 0.0722B`, and `(L1 + 0.05) / (L2 + 0.05)` with `L1` the lighter. Translucent backgrounds are composited over the surface beneath before measuring. A new text colour, or a new surface, needs its row or column added here before it ships.

## Type

| Family | Job |
| --- | --- |
| Bricolage Grotesque | Display and body text |
| IBM Plex Mono (`--mono`) | Data, labels, addresses, hashes, amounts and code |

Mono is for data and labels, not prose. Older pages use it more widely than that; new and rebuilt screens follow the rule, and pages are brought in line as they are rebuilt. Two families is the limit; a third needs a role neither of these can do.

## Motion

1. Nothing on the site loops.
2. Hover and state transitions are short, mostly 140 to 160ms. Any entrance animation is finite, and visibility never depends on an animation's end state: reduced motion removes the animation, so an element that starts hidden and relies on `forwards` would stay hidden.
3. Under `prefers-reduced-motion: reduce`, all animation and transition stops and smooth scrolling turns off. The global rule sits at the end of `styles.css`. Scripted scrolls never pass `behavior: "smooth"`; the default, `auto`, follows the rule.

## Layout

Every page works at 320 CSS pixels wide with no horizontal scrolling and no lost content or function. Check at 320px, not only at desktop widths.

Touch targets aim for 44px (WCAG 2.5.5). The funding desk (nav, buttons, inputs, checkbox rows) and the Builders action buttons are built to it. Elsewhere most controls fall short: nav links (15px), footer links (17px), the nav Wallet and Fund an agent buttons (34px), page call to action links (32 to 43px), standalone links inside panels, and the Builders text inputs (41px) and 16px confirm checkbox. They are brought up as pages are rebuilt. The floor every page must keep is WCAG 2.2 AA (2.5.8): a target is at least 24px, or its centre is at least 24px from its neighbours' centres. On phones the nav's 10px row gap is what keeps its 15px links above that floor.

## Participant screens

These rules protect money, so they outrank visual changes.

1. Show the real chain and service state. Never present a simulated or assumed success.
2. When an outcome is unknown, never offer a new payment. Offer recovery of the original.
3. State the limits and the repayment terms where the decision is made, not only in help text.
4. Each wallet action has its own review step, and a declined or failed prompt says what happened and what was not sent.
5. `/start` (the self service testnet contract) and `/funding` (the earlier candidate) stay distinct.
6. One wallet control per screen.

## Custom properties

Every `var(--name)` must be defined. Before shipping a style change, list the properties that are used but never defined, and the result must be empty:

```sh
python3 -c "import re,glob;s=''.join(open(f,encoding='utf-8').read() for f in glob.glob('app/src/*.css')+glob.glob('app/src/*.tsx'));print(sorted(set(re.findall(r'var\((--[\w-]+)',s))-set(re.findall(r'(--[\w-]+)\s*:',s))))"
```
