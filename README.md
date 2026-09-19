# Chunky Matrix

A browser port of a Commodore 64 Matrix rain screensaver, written in 6502 assembly by **Claude Fable 5.1** (ran on first try). The rain algorithm is ported line-for-line from the original assembly's design notes. On load, the browser fakes a C64 BASIC boot sequence — `LOAD`, a PETSCII-noise loading screen, `RUN` — before it drops into the rain.

Live: https://polerix.github.io/ChunkyMatrix/

---

## How It Works

### The C64 Algorithm (unchanged in the browser)

The original assembly runs in the PAL lower border (raster line 250) to avoid screen tearing. The browser version throttles `requestAnimationFrame` to 20 fps to match the chunky cadence.

Each of the N columns (dynamic; fills the viewport) maintains state:

| Field | Range | Notes |
|-------|-------|-------|
| `row` | 0 → ROWS+len | Current head position |
| `speed` | 1–4 frames/step | How many frames between advances |
| `len` | 6–21 rows | Trail length |
| `band` | 0–3 | Which of 4 wave-sync groups this column belongs to (browser-only, see below) |

**Per-column step** (only runs when the countdown expires):

```
erase   tail cell          (row − len)      → space
dim     row above erase    (row − len + 1)  → dark green        colour only
body    two behind head    (row − 2)        → green             colour only
trail   one behind head    (row − 1)        → light green       colour only
head    leading cell       (row)            → random glyph/sprite + head colour
```

The key insight from the ASM design notes: **only five cells are touched per active column per step**. Everything between the head-minus-2 and the tail is already green and is never written again.

### Character Set

Three glyph pools, independently toggleable from the on-screen controls:

- **ABC** — `@ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&*=`, the C64 ASM's actual output (`AND #$1F` on the SID noise oscillator masks to screen codes `$00–$1F`; `$20`/space is excluded so a random glyph can never punch a hole in an existing trail).
- **日 CJK** — katakana and a page of common kanji. A browser-only addition, not in the original ASM.
- **SIG** — three 8×8 Space Invader sprites (bitmap-drawn, not text glyphs), mixed in at low frequency alongside whichever character pool(s) are active.

At least one pool is always active; if both ABC and CJK are unchecked, ABC is used regardless (there always has to be something to draw).

### Colour Palette

The full 16-colour C64 "Pepto" palette (a widely-used accurate reproduction of the C64's actual video output) is available; head, background, and frame colours can each be cycled through it independently — see Controls below. Defaults:

| Role | C64 colour | Hex | Notes |
|------|-----------|-----|-------|
| Head | 1 (white) | `#FFFFFF` | user-cyclable |
| Trail −1 | 13 (light green) | `#94E089` | fixed |
| Body | 5 (green) | `#55A049` | fixed |
| Dim | — | `#1d381d` | fixed; a dark green tint, not literal C64 colour 11 (grey) — blends into the trail better |
| Background | 6 (blue) | `#40318D` | user-cyclable |
| Frame | 14 (light blue) | `#7869C4` | user-cyclable |

### Respawn Logic

When `row − len ≥ ROWS` (the entire trail has scrolled off the bottom), the column resets to `row = 0` with freshly randomised speed and trail length.

---

## Boot Sequence

Before the rain starts, a state machine (`init → waiting → typing → searching → found → loading → ready → rain`) draws an authentic-ish C64 BASIC boot screen into the *same* canvas/grid the rain uses — one unified renderer, not two:

1. `**** C64 BASIC V2 ****`, `64K RAM SYSTEM`, `READY.` — with a ~1Hz blinking cursor pause before typing starts.
2. `LOAD "CHUNKY-MATRIX",8,1` typed out character by character.
3. `SEARCHING FOR CHUNKY-MATRIX` → `LOADING` → a PETSCII-noise sweep (linear, top-left to bottom-right, in screen-memory address order — not random placement) while random characters and colours fill the screen.
4. `READY.` again, `RUN` typed, then the rain begins.

On a short (landscape phone) viewport the row spacing compresses proportionally instead of the fixed authentic layout, so nothing renders off-screen.

## Responsive Sizing & HiDPI

Cell size is derived from the actual drawable area (the on-screen canvas's own CSS pixel size, not `window.innerWidth`), clamped to a column-count range that keeps the boot text's 22-character header readable at any width down to 320px while staying visibly "chunky" rather than shrinking to normal terminal density on a large desktop window. Height is factored in too, so a short (landscape) viewport doesn't get a cell tall enough to starve the row count.

The canvas backing store is sized at `devicePixelRatio` for crisp text on Retina/HiDPI screens, independent of the CSS-pixel layout — one coordinate space (CSS pixels) for all layout math, one `ctx` transform for the DPR scale-up.

Re-sizing is driven by a `ResizeObserver` on the screen area, not a `window resize`/`orientationchange` listener — the observer fires strictly after layout settles, which matters on iOS Safari where the dynamic toolbar can still be animating when a `resize` event fires.

## Controls

- **日 CJK / ABC / SIG** checkboxes — toggle the character pools above.
- **SND** checkbox — toggles the looping soundtrack.
- **Tap** a falling glyph to cycle the head colour one step; tap empty space to cycle the background; tap the frame border (outside the screen area) to cycle the frame colour.
- **Hold** (>500ms) any of the above to fast-cycle at 150ms/step instead of one step per tap.
- A brief on-screen hint (`tap glyph · tap space · tap frame | hold = fast-cycle`) appears when the rain starts and fades after 5 seconds.

## Debug Mode

Load with `?debug=1` for an on-screen, semi-transparent readout of every width/height signal the layout math depends on: `devicePixelRatio`, `window.innerWidth/innerHeight`, `visualViewport`, the screen wrapper's rect and `clientWidth`, the canvas's CSS size vs. its backing-store size, computed cell size, `COLS`/`ROWS`, and the current boot state. It polls once a second. This is the tool that found and confirmed the fix for two real-device-only mobile layout bugs that emulated testing missed — trust it over a desktop browser's dev tools when diagnosing anything on an actual phone.

---

## Running

Open `index.html` directly in any browser — no build step, no server, no dependencies:

```bash
open index.html        # macOS
xdg-open index.html    # Linux
```

Or visit the deployed version: https://polerix.github.io/ChunkyMatrix/ (served via GitHub Pages from this repo's `main` branch).

---

## Original C64 Assembly

Written by **Claude Fable 5.1** with the prompt:

> *Write me a Commodore 64 assembly language program that simulates the Matrix screen saver. Make it as fast and efficient as possible so it doesn't lag.*

It ran on the first try. Assembled with `acme -f cbm -o matrix.prg matrix.asm`.

---

*Browser port and boot sequence by Claude Sonnet 5.*

## Licensing

The source code in this repository is released under the [MIT License](LICENSE).

Third-party material bundled in this repository (fonts, audio, video, artwork, saved web pages and similar files) is **not** covered by that license. It remains the property of its respective owners and is included under their own terms. If you are a rights holder and want something removed, please open an issue.
