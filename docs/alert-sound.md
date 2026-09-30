# The alert sound: a cha-ching! cash-register ring-up

The site has exactly **one** alert sound. Every tracked event plays it: new
challenges / reviews / boundary calls, official-scorer pending rulings, official
scoring changes, ABS pitch challenges, and the run-at-risk alert (which calls the
same function, see `playRunRiskAlertSound()` in `assets/js/reviews-feed.js`).

This document records what the sound is, where the design came from, and how the
shipped code was verified — because the alert is *synthesized* in the browser
(there is no audio file to listen to in the repository), so the only honest way
to check it is to render the real graph and measure the result.

---

## 1. What a cash-register "cha-ching" actually is

Research (below) converges on the same three physical layers:

| Layer | What it is | What it sounds like |
| --- | --- | --- |
| **"cha"** | the key/lever mechanism, gears and ratchet | a short burst of small mechanical clicks **as loud as the bell** |
| **"ching"** | the register bell — a small, hard metal bell struck by a hammer as the drawer opens | a bright, *inharmonic* metallic ring, ~2.1 kHz, **gone within half a second** |
| **drawer** | the drawer sliding out on its rollers and hitting its stop | a "shhk" of movement plus a low thud, **continuing after the bell** |

Notes from the sources:

- Catalogue descriptions for the classic effect name the exact three layers:
  *"Cash Register Key With Bell And Drawer Opens"*, *"Antique: Drawer Opens With
  Bell"*, and the clip lengths for these "CHA-CHING" effects are typically
  **1–4 seconds** (audiomicro cash-register category; AudioJungle / Pixabay
  listings).
- Anatomy write-ups describe the sound as *"a two-part harmony: the
  high-frequency shimmer of a bell and the mid-range crunch of a mechanical
  drawer"*, and explain *why* it exists: the bell was a security feature that
  rang on every drawer opening so the owner heard each sale. The drawer's
  "thud" is a spring-loaded metal drawer sliding open on steel rollers.
- The same write-up is explicit that *"the 'cha' sound is the noise of the
  heavy-duty internal gears turning and the spring-loaded drawer popping open"*.
- The history is documented academically in *"Cha-ching!": why the cash register
  came to ring* (Sound Studies 10:1, 2024), whose abstract confirms the bell was
  originally a surveillance mechanism.

### Three real recordings, measured

Descriptions alone cannot settle pitch, timing or level, so three freely
redistributable recordings of real and reproduced registers were downloaded and
measured with an FFT / Goertzel analyser. **None of them is shipped** — the site
keeps zero audio assets; they were used to take measurements and then deleted.

| # | Recording | What it is |
| --- | --- | --- |
| **C** | npm `stripe-play-ka-ching-sound` (MIT), clip `4kVTqUxJYBA.mp3` | the canonical "ka-ching" |
| **D** | Freesound 721774, "cash register" | a register bell over a drawer |
| **A** | an antique mechanical register being operated | the real thing, bell + mechanism |

**The bell.** All three have a bright inharmonic bell; two of them put the prime
in the same place:

| Recording | prime | peak at | prime decay | prime time constant | 20 dB down after |
| --- | --- | --- | --- | --- | --- |
| **C** | 2100 Hz | 0.260 s | −44.3 dB/s | **0.196 s** | **0.240 s** |
| **D** | 2097 Hz | 0.260 s | −46.6 dB/s | **0.168 s** | **0.440 s** |
| **A** | 5988 Hz | 0.250 s | −60.3 dB/s | 0.144 s | 0.060 s |

The register bell's pitch is **≈2.1 kHz**, and — this is the figure that matters
most — it is a *struck* bell: it is 20 dB down within a quarter to half a second.
It does not sustain.

The upper partials are inharmonic and die faster than the prime. Measured at the
strike (4096-point FFT) for **C**: 2039 Hz (−16.9 dB), **2098 Hz (prime)**,
**4805 Hz (−6.5 dB, ×2.291)**, 7734 Hz (−19.3 dB, ×3.687). The per-partial time
constants confirm the spread:

| Recording | prime | bright upper partial | other components |
| --- | --- | --- | --- |
| **C** | 2098 Hz, tau 0.189 s | 4805 Hz, tau 0.109 s | 7734 Hz, tau 0.133 s |
| **D** | 2089 Hz, tau 0.168 s | 4791 Hz, tau 0.135 s | 7730 Hz, tau 0.127 s; 775 Hz, tau 0.086 s; 2950 Hz, tau 0.083 s |

That spread — low partials lasting longest, bright ones dying first — *is* the
sound of struck metal.

**How loud the "cha" is.** This is the measurement the previous build got wrong.
Comparing the RMS of the mechanism (everything before the strike) with the RMS of
the bell over the 0.25 s after it:

| Recording | "cha" RMS | bell RMS | bell − cha |
| --- | --- | --- | --- |
| **C** | −9.3 dB | −9.0 dB | **+0.4 dB** |
| **A** | −15.1 dB | −18.2 dB | **−3.1 dB** |
| **D** | −33.9 dB | −20.7 dB | +13.1 dB |

In a real register the mechanism is **level with the bell, or louder**. It is not
a quiet prelude — it is the first syllable.

**How broadband the "cha" is.** A mechanical clatter spreads its energy; a few
thin ticks do not. Measuring the mean level of the mechanism in the low
(150–400 Hz), mid (700–1600 Hz) and high (2500–6000 Hz) bands:

| Recording | low | mid | high | spread |
| --- | --- | --- | --- | --- |
| **C** | −39.5 dB | −37.8 dB | −39.8 dB | **2.0 dB** |
| **A** | −45.4 dB | −47.8 dB | −43.6 dB | **4.3 dB** |
| **D** | −65.3 dB | −61.3 dB | −58.9 dB | **6.5 dB** |

**One strike, not two.** A re-excitation scan of the prime after the strike found
no fresh hammer blow in any of the three recordings — only small ripples
(+4…+11 dB in **C** and **D** at 0.37–0.55 s) riding on an already-decaying tone.
"Cha-ching" has **one** "ching".

**The drawer keeps moving.** In all three recordings there is broadband
mechanical energy *after* the bell as well as before it.

---

## 2. The design as shipped

Everything lives in `ALERT_SOUND` in `assets/js/reviews-feed.js`; the graph is
built by `buildCashRegisterChime(ctx, destination, t0, spec)` and played by
`playCashRegisterChime()`.

| Time | Layer |
| --- | --- |
| 0.000–0.058 s | **key clack** — bright band-passed noise burst at 4.2 kHz → the key goes down |
| 0.002–0.228 s | **mechanism bed** — band-passed noise whose centre sweeps 3000 → 900 Hz, so it reads as a machine working rather than as hiss |
| 0.004 s | **lever body** — low double knock (196 + 118 Hz) that sags in pitch; the heavy case answering the key |
| 0.024–0.202 s | **five gear clicks**, falling 3.6 kHz → 1.6 kHz and getting softer as the spring unwinds |
| 0.040–0.600 s | **the drawer rolls** — noise sweeping 1900 → 430 Hz, starting under the mechanism and continuing past the bell |
| 0.226 s | **hammer tick** — a 6 ms bright noise burst |
| **0.230 s** | **the bell is struck** — 17 inharmonic partials on a 2093 Hz prime |
| 0.230–~1.0 s | the bell rings down; the low body partials carry the tail |
| 0.600 s | **the drawer hits its stop** — low double thud (158 + 96 Hz) plus a click |
| → 1.90 s | master fade to silence; the alert is audible for **~1.6 s** |

Design decisions worth knowing, each one tied to a measurement above:

- **The bell is struck once.** "Cha-CHING", not "ching-ching" (see the
  re-excitation scan).
- **The prime's time constant is 0.19 s**, and the partials step down from 0.32 s
  (the 0.271x body partial) to 0.09 s (the 5.5x air partial). Measured: the prime
  is 20 dB down 0.435 s after the strike — right between **C**'s 0.240 s and
  **D**'s 0.440 s.
- **The mechanism is as loud as the bell, deliberately.** Measured: the bell sits
  **0.7 dB below** the mechanism. Real recordings: +0.4 dB and −3.1 dB.
- **The "cha" is broadband**, 4.3 dB apart across low/mid/high — inside the
  2.0–6.5 dB range of the references.
- **The drawer opens across the bell**, not before it: it starts at 0.040 s and
  reaches its stop at 0.600 s, so the mechanism is still running when the bell is
  struck and still running after it, exactly as the recordings show.
- **A hammer tick 4 ms before the tone** gives the strike its transient. An A/B
  render with the tick muted measures +4.8 dB in the 4 ms before the tone.
- **Level:** master gain 0.29 → the rendered peak is **−5.0 dBFS**, loud enough
  for an alert with no clipping anywhere.
- **No assets, no dependencies, no network.** Fully synthesized with the Web
  Audio API, so the alert can never fail to load and there is nothing to license.

---

## 3. Verification

Three independent checks back this up. All three are re-runnable.

### 3a. The structure test (runs in CI, no dependencies)

```bash
node tools/reviews-feed-test.mjs
```

Sections 11 and 14 drive the real public API against a recording AudioContext
stub and check the scheduled graph against `ALERT_SOUND` itself — node counts
are *derived* from the design data, so the test cannot silently drift from the
sound. It verifies: the number of noise sources and oscillators, that every
mechanical layer is a band-passed noise burst with a non-silent buffer, the
exact scheduled time of the key clack / each gear click / the mechanism bed /
the drawer / the hammer tick / the drawer stop, that both swept filters run from
their designed high centre down to their low one, that each bell partial sits at
fundamental × ratio and decays no slower than the partial below it, that the bell
is struck exactly once with a tick just before it, the master envelope's length
and hold point, that the run-at-risk alert builds a byte-identical graph, and the
shared 2.5 s cooldown. Latest run: **passes**.

### 3b. The rendered-PCM check (optional dependency)

```bash
npm install --no-save web-audio-engine
node tools/render-alert-sound.mjs alert-sound.wav   # writes a listenable WAV
```

This loads the shipped module in a VM whose `AudioContext` is a **real Web Audio
implementation rendering to PCM**, enables the sound toggle exactly as a user
click does, renders it offline, writes a WAV you can play, and then measures the
PCM. Every threshold in the tool is a number taken from the reference recordings
in section 1, quoted in the tool's header.

The module's `Math.random()` is seeded from inside the VM, so the render is
byte-reproducible and the A/B renders below compare *the same noise* with one
layer removed rather than two different noise fields.

Latest run, on the shipped code — **43/43**:

```
1) the alert as a whole
  PASS  lasts 1-2 seconds as requested        [audible to 1.712 s]
  PASS  does not clip                         [peak -5.0 dBFS]
  PASS  sits at a sensible alert level        [peak -5.0 dBFS]
2) the "cha" mechanism
  PASS  mechanism loud enough to be a syllable       [-20.6 dB RMS over 0-0.23 s]
  PASS  mechanism level with the bell                [bell is -0.7 dB vs mechanism]
  PASS  low / mid / high content all audible         [-48.8 / -47.5 / -51.8 dB]
  PASS  broadband across low/mid/high                [4.3 dB spread (refs 2.0-6.5)]
  PASS  noise-like, not a tone                       [crest 13.1 dB (refs 9.5-15.4)]
  PASS  mechanism still running at the strike        [-22.0 dB RMS]
3) the register bell
  PASS  all 17 partials ring                         [-5.8 … -26.3 dB below prime]
  PASS  no upper partial is an exact harmonic
  PASS  dominated by its prime — a tone, not a clatter [crest 28.3 dB (refs 17.8-42.9)]
  PASS  rings down, not a sustained tone             [-44.4 dB/s]
  PASS  time constant matches the measured 0.17-0.20 s [tau 0.191 s]
  PASS  20 dB down within 0.6 s of the strike        [0.435 s]
  PASS  the bright 2.526x partial dies faster than the prime
4) the bell is struck ONCE, with a hammer tick (seeded A/B renders)
  PASS  bell clearly audible over the mechanism      [+5.8 dB vs no-bell graph]
  PASS  hammer tick lands just before the tone       [+4.8 dB vs no-tick graph]
  PASS  no second strike (prime never re-attacks)    [largest rise +0.4 dB]
  PASS  a sharp bell attack is detectable            [at 0.225, 0.227, 0.231 s]
5) the ring
  PASS  keeps decaying (no flat tone)                [-39.2 dB/s]
  PASS  decays smoothly (no slow warble)             [residual 1.76 dB]
  PASS  no silent hole inside the alert              [0 ms below -60 dB]
```

The tool exits 0 with a "not installed" notice when `web-audio-engine` is absent,
so the CI smoke suite (which installs nothing) is never affected.

### 3c. The independent re-measurement

```bash
node tools/alert-sound-independent-check.mjs alert-sound.wav 0.230
```

This shares **no code** with the render tool: its own WAV parser written from the
RIFF spec, its own Hann-windowed Goertzel detector, its own peak clustering. It
is handed a WAV and a strike time and re-measures 12 independent facts — the
1–2 s duration, no clipping, the mechanism's level, that the bell and mechanism
sit level with each other, the bell prime in the ~2.1 kHz region, inharmonic
partials, that the prime never jumps back up (one strike), that it keeps falling
all the way down the ring, the decay rate and time constant, and the upper
partials dying faster than the prime. Latest run: **12/12**.

### 3d. What the previous sound was, and why it was wrong

The build immediately before this one was already a "cash register" attempt, but
it measured wrong on four counts. Every number below is the replaced build's own
render compared with the references:

| Measurement | references | replaced build | now |
| --- | --- | --- | --- |
| prime time constant | 0.168–0.196 s | **0.850 s** | **0.191 s** |
| prime 20 dB down after | 0.24–0.44 s | **0.72 s** | **0.435 s** |
| bell − mechanism level | +0.4 / −3.1 dB | **+14.2 dB** | **−0.7 dB** |
| "cha" band spread | 2.0–6.5 dB | **17.3 dB** | **4.3 dB** |
| bell strikes | 1 | **2** | **1** |

1. **It held the master gain flat for 1.6 s and gave the bell partials time
   constants near 1 s.** A real struck bell is ~0.19 s. The result was a
   *sustained tone* — a chime — not a "ching".
2. **Its "cha" sat 14 dB under the bell**, so the first syllable was never really
   audible. What you heard was a chime with clicks in front of it.
3. **It struck the bell twice.** None of the reference recordings shows a second
   bell strike.
4. **Its near-prime partial cluster was almost as loud as the prime** (2039 Hz at
   −5.9 dB against a 2098 Hz prime), so the tone beat and warbled instead of
   ringing clean. The partners around the prime now sit −11 dB and −19 dB down.

For the record, the build before *that* one played a 1.6-second two-note sine
chime (C6 → E6) — a chime, not a cash register at all.

Everything else about the alert (which events fire it, the 2.5 s cooldown, the
sound toggle, the run-at-risk path) is unchanged by this work.

---

## Sources

- Sound Effects catalogue, *Cash Registers* category — clip names and durations
  ("CASH REGISTER CHA-CHING", "Cash Register Key With Bell And Drawer Opens",
  "Antique: Drawer Opens With Bell"): <https://www.audiomicro.com/sound-effects/bars-and-restaurants/cash-registers>
- *Cash Soundboard* anatomy notes — bell + drawer as a two-part harmony, bell as
  an anti-theft alert: <https://soundboardmax.com/cash-soundboard/>
- *Cash Register Soundboard* history notes — "the 'cha' sound is the noise of
  the heavy-duty internal gears turning and the spring-loaded drawer popping
  open": <https://soundboardmax.com/cash-register-soundboard/>
- *Cash Register – Sound Effect* (sound-design breakdown of the cha-ching):
  <https://www.echosfx.com/free-sound-effects/cash-register-sound-effect>
- *"Cha-ching!": why the cash register came to ring*, Sound Studies 10:1 (2024)
  — the bell as a surveillance mechanism: <https://www.tandfonline.com/doi/full/10.1080/20551940.2024.2307721>
- Reddit r/Showerthoughts threads on the cha-ching — the association with money
  is largely media-driven; modern registers mostly just rattle change.
- **Measured reference recordings** (analysed as references only, never shipped):
  npm `stripe-play-ka-ching-sound` (MIT), clip `4kVTqUxJYBA.mp3`; Freesound
  721774 "cash register" (CC0); an antique mechanical register recording.
