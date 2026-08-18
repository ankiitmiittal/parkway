# Parkway — working notes

A park route planner. Photograph (or PDF) a park map and showtimes board, answer
adaptive questions, get an optimised route through the day that re-plans live.

Live: https://peppy-creponne-f2be92.netlify.app/ — **`main` auto-deploys.**

---

## Hard constraints — do not "fix" these

**No build step, and no dependencies.** Plain HTML/CSS/JS in classic `<script>`
tags. This is deliberate: the app must open from `file://` by double-clicking
`index.html`, and the machine it was written on has no Node and no Python.

**Do not convert to ES modules.** `type="module"` is blocked over `file://` by
CORS. Classic script tags are the only thing that works there. Load order in
`index.html` is the dependency order.

**Do not add a bundler, framework, or npm dependency** without checking first.
There is no toolchain to run one.

## Releasing — the trap that bites everyone

Two version numbers, and **the second is the one that actually matters**:

1. `?v=N` on every script/style tag in `index.html`
2. `CACHE` in `sw.js`

**Bumping `?v=` alone does nothing for anyone who has already visited.** The
service worker matches with `ignoreSearch`, so `app.js?v=99` happily returns the
cached `app.js` from the previous build. This was verified against the live
site: a bumped `?v=` returned the *old* file's contents. Only changing `CACHE`
evicts the shell.

**Bump both, every release.**

## Verifying changes

**There is no test suite.** Verification has been: open the app in a browser and
exercise it. `PP` is exposed on `window`, so the engine can be driven directly
from the console — that is how the optimizer, the preference learning and the
retention gate were tested.

```js
const s = { park: PP.samplePark(), party: PP.newParty(),
            prefs: PP.newPrefs({ arrive: 9*60, depart: 17*60 }),
            answered: {}, progress: { done: [], skipped: [], observedWaits: {} },
            duels: PP.duels.blank() };
const p = PP.plan(s, { iterations: 400 });
```

Invariants worth re-checking after touching `optimizer.js`: no stop starts
before the previous one ends, no show arrived at after its deadline, no meal
outside its window, nothing past `ctx.endTime`, no duplicate stops.

**If you cannot run a browser** (a phone or cloud session), say so rather than
claiming a change is verified. Prefer a branch and a Netlify deploy preview over
pushing straight to `main`.

## Layout

```
index.html          shell; script tags in dependency order + ?v= cache busting
sw.js               offline cache; CACHE constant gates every release
netlify.toml        publish root, functions dir, no-cache headers on sw/index
css/app.css         light + dark, mobile-first
js/model.js         data model, time helpers, the sample park
js/optimizer.js     cost models, simulation, construction, local search
js/questions.js     question bank, value-of-information ranking
js/duels.js         A/B preference learning, whole-day comparisons
js/vision.js        Claude calls: photo/PDF -> park JSON; the retention gate
js/waits.js         live queue times, name matching, calibration
js/ui.js            rendering; every screen is a function of state
js/app.js           state, persistence, event wiring
netlify/functions/  same-origin proxy for queue-times (CORS workaround)
```

## Gotchas already paid for

**`PP.simulate()` is the only definition of "possible."** Add new scheduling
constraints there, not in the heuristics, or the search will happily produce
itineraries that violate them.

**queue-times.com sends no CORS headers for real origins.** It appears to work
from `file://` because the origin is `null`. Hosted, it must go through
`netlify/functions/queue-times.js`. `waits.js` handles both.

**The service worker must never cache live data.** Both the live hosts *and*
same-origin `/.netlify/functions/*` are excluded. A cached queue time is worse
than none.

**Never write the API key to a file.** It lives in browser `localStorage` only.
That is what makes the repo safe to publish and the folder safe to upload.

**The retention gate is a whitelist and must fail closed.** Only affirmatively
clean map documents pass; a missing or malformed assessment is a rejection.
Do not soften it into a "does it contain a person" blacklist — that fails open.

**Editing images strips EXIF; PDFs do not get stripped.** Images are re-drawn
through a canvas, which discards metadata as a side effect. PDFs are forwarded
byte for byte.

**Don't use PowerShell `Set-Content` on source files.** It re-encodes and
mangles non-ASCII characters. Use the editing tools.

## Style

British English in user-facing copy. Comments explain *why*, not *what*, and
are worth adding where a reader would otherwise wonder why something is the way
it is. Match the surrounding code — it is plain ES5-flavoured JS with `var` and
function expressions, deliberately, for `file://` compatibility.
