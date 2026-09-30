# `assets/audio/` — the alert-sound slot

This directory is where a **real cash-register recording** goes. Nothing is
committed here by default, so the site never ships an audio file whose licence
has not been checked.

The site's single alert sound has two paths, and only one of them lives here:

| Path | Where it comes from | When it plays |
|---|---|---|
| 1. The real recording | `assets/audio/cha-ching.*` | whenever a file is installed here |
| 2. The synthesized cha-ching | `assets/js/reviews-feed.js` (`buildCashRegisterChime`) | whenever path 1 has nothing to play |

Path 2 is not a placeholder. It is measured against a real recording by
`tools/render-alert-sound.mjs` (57 checks: body level, plateau texture, attack
count, bell decay, peak, audible duration). A fresh clone is never silent.

## The filenames the site probes

In this order, first one that fetches and decodes wins — implemented as
`ALERT_SAMPLE_PATHS` in `assets/js/reviews-feed.js`:

```
assets/audio/cha-ching.mp3
assets/audio/cha-ching.wav
assets/audio/cha-ching.ogg
assets/audio/cha-ching.m4a
```

A missing file costs four fast 404s **once per page load**, then the answer is
cached for the session. The winning path is remembered in `localStorage`
(`replayFeedAlertSamplePath`) so a working install costs exactly one request.

## How to install a recording

**Option A — the Sound Lab (no code, no git).** Open `sound-lab.html`, drop a
file on the page, audition it, and click **Install on this server**. That POSTs
the bytes to `/api/alert-sound`, which writes `assets/audio/cha-ching.<ext>`
atomically and removes any other extension so the newest upload is
unambiguously the alert. Requires `node server.mjs` (the static GitHub Pages
deployment has no upload endpoint — use option B there).

**Option B — copy the file in.**

```sh
cp ~/Downloads/cash-register.mp3 assets/audio/cha-ching.mp3
```

**Option C — commit it**, so every visitor gets the real recording:

```sh
cp ~/Downloads/cash-register.mp3 assets/audio/cha-ching.mp3
$EDITOR assets/audio/LICENCE.md      # required — see below
git add assets/audio/cha-ching.mp3 assets/audio/LICENCE.md
git commit -m "Ship a real cash-register cha-ching as the alert sound"
```

Then in **any** tab, the next gesture re-probes and the recording takes over.

## Format guidance

- **Length:** 1–2 s is what the alert is designed for. Longer is fine — it is
  not truncated — but the bell ring is what carries the tail, so a 3 s file with
  a long room tail will sound like it overlaps the next alert. The 2.5 s
  cooldown is shared by both paths.
- **Level:** do not master it. The file's true peak is normalized
  automatically to **−2.0 dBFS** (`ALERT_SAMPLE_TARGET_PEAK_DB`), clamped to a
  gain of 0.1×–8× so neither a whisper nor a brick-walled file is forced into
  an unusable range. A stock sound effect mastered to 0 dBFS is cut by 2 dB; a
  quiet field recording is lifted.
- **Channels:** mono or stereo, any sample rate — `decodeAudioData` resamples.
  Normalization uses the loudest channel, so a stereo file with one hot side is
  handled correctly.
- **Size:** the upload endpoint caps at 12 MB. A 2 s MP3 is ~30 KB.
- **Rejected on purpose:** anything under 512 bytes, and anything whose first
  512 bytes look like HTML or JSON. Some static hosts answer an unknown path
  with `index.html` at status **200**; without that check the browser would try
  to decode a web page and fail confusingly instead of falling back cleanly.

## Where to get one you are allowed to ship

The sound the request pointed at — YouTube `trR5YxZjfes`, channel
*cashregistersound*, "Cash Register Cha-Ching | Sound Effect | (Kaching)" —
links in its own description to a **paid Bandcamp release**. It is not free to
copy, and nothing in this repository should be ripped from it.

These two were checked page-by-page and are free to use commercially:

| Sound | Author | Length | Licence |
|---|---|---|---|
| [Cash Register (Kaching) — Sound Effect](https://pixabay.com/sound-effects/film-special-effects-cash-register-kaching-sound-effect-125042/) | Modestas123123 (Pixabay) | 0:03 | [Pixabay Content Licence](https://pixabay.com/service/license-summary/) |
| [Cash Register Fake](https://pixabay.com/sound-effects/film-special-effects-cash-register-fake-88639/) | freesound_community / CapsLok (Pixabay, from [Freesound 184438](https://freesound.org/people/CapsLok/sounds/184438/)) | 0:02 | Pixabay Content Licence; the underlying Freesound recording is **CC0** |

The first is the closest match to the reference video — the same class of stock
SFX, the same title pattern, ~624k plays / ~300k downloads. The second is the
more conservatively licensed of the two (CC0 underneath).

Pixabay Content Licence, as summarized at the URL above: free for commercial
use, **no attribution required**, may not be sold or redistributed standalone
as your own. Downloading a sound effect from Pixabay needs no account.

Both are stock recordings of the same kind of machine, so neither is *the*
video's sound — nothing freely hosted is. If the exact recording matters, it has
to be bought from the Bandcamp release the video links to, and then its own
licence terms decide whether it can ship in a public repository.

## `LICENCE.md` is required when a file is committed

This repository previously shipped **zero** audio assets, so committing one
changes what the repo redistributes. Before `git add`-ing a sound, record in
`assets/audio/LICENCE.md`:

```markdown
# Alert sound licence

- File: cha-ching.mp3
- Title: Cash Register (Kaching) - Sound Effect
- Author: Modestas123123
- Source: https://pixabay.com/sound-effects/film-special-effects-cash-register-kaching-sound-effect-125042/
- Retrieved: 2026-09-30
- Licence: Pixabay Content Licence (https://pixabay.com/service/license-summary/)
- Attribution required: no
- Commercial use permitted: yes
```

Fill in what is actually true of the file you install — do not copy the example
if you used a different source. If a licence *does* require attribution, that
attribution belongs here and in the site's `README.md`.

## Checking a recording before you commit it

```sh
node tools/render-alert-sound.mjs /tmp/alert.wav
```

That renders the **synthesized** fallback and measures it. For the recording
itself, the Sound Lab prints duration, peak dBFS, RMS and spectral centroid
when you drop a file, so you can see whether it is the right shape (a real
"cha-ching" measures a ~45 ms ramp, a plateau held to the strike, then a bell
with a ~0.22 s decay time constant — `docs/alert-sound.md` §2 has the method
and the numbers).
