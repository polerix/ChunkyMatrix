# Chunky Matrix

A faithful browser port of a Commodore 64 Matrix rain screensaver, written in assembly by **Claude Fable 5.1** (ran on first try). The algorithm is ported line-for-line from the original 6502 design notes — the browser adds phosphor glow, CRT scanlines, and gyroscope tilt.

---

## How It Works

### The C64 Algorithm (unchanged in the browser)

The original assembly runs in the PAL lower border (raster line 250) to avoid screen tearing. The browser version throttles `requestAnimationFrame` to ~20 fps to match the chunky cadence.

Each of the N columns (dynamic; fills the viewport) maintains three bytes of state:

| Field | Range | Notes |
|-------|-------|-------|
| `row` | 0 → ROWS+len | Current head position |
| `speed` | 1–4 frames/step | How many frames between advances |
| `len` | 6–21 rows | Trail length |

**Per-column step** (only runs when the countdown expires — about half the columns fire each frame):

```
erase   tail cell          (row − len)      → space
dim     row above erase    (row − len + 1)  → dark grey-green   colour only
body    two behind head    (row − 2)        → green             colour only
trail   one behind head    (row − 1)        → light green       colour only
head    leading cell       (row)            → random glyph + white
```

The key insight from the ASM design notes: **only five cells are touched per active column per step**. Everything between the head-minus-2 and the tail is already green and is never written again. This is why the original uses 4 376 cycles on average out of the 19 656 available in a PAL frame (~22% CPU).

### Character Set

The C64 ASM uses `AND #$1F` on the SID noise oscillator, producing screen codes `$00–$1F`:

```
@ A B C D E F G H I J K L M N O P Q R S T U V W X Y Z # % & * =
```

`$20` (space) is explicitly excluded so a random glyph can never punch a hole in an existing trail.

### Colour Palette (C64 → browser)

| Role | C64 colour RAM | Browser hex |
|------|---------------|-------------|
| Head | `$01` white | `#ffffff` + `#00ff41` glow |
| Trail −1 | `$0d` light green | `#92f792` |
| Body | `$05` green | `#009900` |
| Dim | `$0b` dark grey | `#1b3a1b` |
| Erase | — | `#000000` |

### Respawn Logic

When `row − len ≥ ROWS` (the entire trail has scrolled off the bottom), the column resets to `row = 0` with freshly randomised speed and trail length. Negative row values naturally skip their bounds check — the same trick as the unsigned `CMP #ROWS; BCS skip` in the 6502.

---

## Browser Extras

### Phosphor Bloom
The head glyph is drawn with `ctx.shadowColor = '#00ff41'` and `ctx.shadowBlur = 12` — a green halo the C64 hardware couldn't produce.

### CRT Overlay
Two CSS pseudo-elements sit above the canvas (pointer-events: none):
- `::after` — repeating scanline gradient (4 px repeat, 10% black stripe)
- `::before` — radial vignette darkening the corners

### Gyroscope (Mobile)

`DeviceOrientationEvent.gamma` gives the left-right tilt angle (−90° to +90° in portrait hold). The canvas is sized to the **viewport diagonal** (a square), then CSS-rotated by a smoothed fraction of gamma:

```js
targetAngle  = (gamma / 75) * (Math.PI * 0.55);
currentAngle += (targetAngle - currentAngle) * 0.07; // exponential ease
cvs.style.transform = `rotate(${currentAngle}rad)`;
```

Because the canvas is a square that always exceeds the viewport diagonal, no black corners appear at any rotation. The rain algorithm runs unchanged in the canvas's own coordinate space — "down" in canvas space tracks physical gravity.

iOS 13+ requires `DeviceOrientationEvent.requestPermission()` from a user gesture; a tap hint is shown on load.

---

## Running

Open `chunky-matrix.html` directly in any browser — no build step, no server, no dependencies.

```bash
open chunky-matrix.html        # macOS
xdg-open chunky-matrix.html   # Linux
```

The file is ~230 lines of vanilla JS and CSS, entirely self-contained.

---

## Original C64 Assembly

Written by **Claude Fable 5.1** with the prompt:

> *Write me a Commodore 64 assembly language program that simulates the Matrix screen saver. Make it as fast and efficient as possible so it doesn't lag.*

It ran on the first try. Assembled with `acme -f cbm -o matrix.prg matrix.asm`.

---

*Browser port by Claude Sonnet 4.6*
