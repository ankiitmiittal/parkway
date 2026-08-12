# Parkway

Photograph a park map and a showtimes board on your way in. Answer a few
questions. Get a route through the day that actually accounts for when the
shows start, how long the queues will be at 2pm, and how far your legs are
willing to carry you — and that re-optimises when the day goes sideways.

Built for zoos, theme parks, safari parks — anything with fixed-time shows
scattered across a map.

---

## Running it

**Double-click `index.html`.** That is the whole install. No build step, no
`npm install`, no server. It is plain JavaScript in classic `<script>` tags
specifically so it runs from `file://`.

On your phone: put the folder in a cloud drive and open `index.html`, or run
the bundled server (below) and browse to your laptop's IP.

> After editing any file under `js/`, bump the `?v=` number in `index.html`.
> Browsers cache aggressively and will otherwise keep serving the old code —
> this bit me repeatedly while building it.

---

## Reading photos

Turning a photographed map into structured data is the one part that needs a
model. Everything else — the routing, the questions, the live re-planning —
runs offline on the device.

There are three ways to get your park in, in order of convenience:

Both slots take **a photo or a PDF**. Claude reads PDFs natively, so an official
downloadable park map is parsed from the vector text rather than from a
photograph of it — noticeably more accurate for small labels. Limits: 12 MB per
PDF, ~24 MB per request.

Two things differ for PDFs:

- **No map backdrop.** Browsers cannot rasterise a PDF without a library, so a
  PDF-only park falls back to the Map screen's schematic grid. Pins and the
  route still draw correctly, because coordinates are normalised. Upload a photo
  *as well* if you want a picture behind them — the PDF is used for accuracy and
  the photo for the backdrop.
- **Metadata is not stripped.** Images are re-drawn through a canvas, which
  discards EXIF and GPS as a side effect. A PDF is forwarded byte for byte, so
  whatever its author embedded goes with it.

### 1. Direct from the browser

Settings → paste an [Anthropic API key](https://console.anthropic.com/) → take
your photos → **Read my photos**.

The key is stored in this browser's `localStorage` and sent straight to
Anthropic. That is fine for your own phone. It is **not** fine if anyone else
will use the page — the key is readable by anything running on it. Use the
proxy for that.

### 2. Through the bundled proxy

Keeps the key server-side. Needs Node 18+ (nothing to install beyond Node):

```bash
set ANTHROPIC_API_KEY=sk-ant-...
node server/proxy.mjs
```

Then open <http://localhost:8787/> and set Settings → *Through my own proxy*.
Serving the app over `http://` also sidesteps any `file://` restrictions your
browser applies.

### 3. No API key at all

Send the photos to Claude in a normal chat and ask for park JSON in the shape
below, save the reply as a `.json` file, then **Import a saved park**. Or press
**Build one by hand** and type it in. Or press **Load the sample park** to see
how the whole thing behaves before committing to any of this.

---

## Sharing it with other people

The trick is that **only photo parsing needs an API key**. The optimizer, the
questions, the A/B comparisons, the map, live mode and Queue-Times live waits
are all keyless. So if you parse the park once yourself and ship the result,
everyone else gets the full app with no key and no account.

1. **Get the park right.** Read your photos (or build it by hand), then fix
   anything wrong on the Review screen. This is the one step only you can do.
2. **Settings → Export park + answers.** Save the file.
3. **Rename it `park.json`** and drop it next to `index.html`. On load the app
   picks it up automatically and goes straight to the questions — recipients
   never see the setup screen. Only the *park* is taken from the file; your
   party size, hours and answers are not imposed on them.
4. **Upload the folder.** Drag it onto [Netlify Drop](https://app.netlify.com/drop),
   or use Cloudflare Pages or GitHub Pages. All free, all static, no build step.
   You can leave out `.claude/` (editor config) and `server/` (only needed if you
   run the proxy) — everything else is the app.
5. **Share the URL.** Tell people to use *Add to Home Screen* — it installs as a
   standalone app and, thanks to the service worker, keeps working when the park
   Wi-Fi gives up.

**Your API key is not in the folder.** It lives in your own browser's
`localStorage` and is never written to any file, so uploading the folder cannot
leak it. The flip side: recipients have no key, so *they* cannot read photos,
use model-based free-text steering, or use the web-search tier for live waits.
Everything else works.

If you want them to have photo parsing too, that needs the proxy — and the
bundled `server/proxy.mjs` is **not safe to expose as-is**: no authentication,
no rate limiting, and `Access-Control-Allow-Origin: *` by default. Anyone who
finds the URL can spend your credits. Put it behind a shared secret and a rate
limit first.

### Releasing an update

Two version numbers, and **the second one is the one that matters**:

- `?v=N` on the script/style tags in `index.html` — busts the browser's HTTP cache.
- `CACHE` in `sw.js` — busts the offline cache.

**Bumping `?v=` alone does nothing for returning visitors.** The service worker
matches cached files with `ignoreSearch`, which is what stops the two version
schemes fighting each other — but it also means `app.js?v=99` happily matches
the cached `app.js` from the previous build. Verified on a live deploy: a
request for a bumped `?v=` returned the *old* file's contents. Only changing
`CACHE` evicts the shell.

Bump both, every release.

## Which photos are safe to keep

Every parse also classifies each image, and a **retention gate** decides whether
that image could ever be kept beyond the trip it was taken for. Nothing is
currently retained or transmitted anywhere — the gate exists so that if you ever
do build a shared park library, only clean map documents can enter it.

The test is a whitelist, not a person-detector. "Does this contain a person?"
fails open, because small, blurred or background people get missed and every
miss is the bad case. "Is this a wall map, paper map or showtimes board with no
one in it?" fails closed: a photo of your kids by the castle simply isn't a map.

An image is kept **only** when all of these hold:

| Check | Keeps |
|---|---|
| `documentType` | `wall_map`, `paper_map`, `showtimes_board` |
| `humanPresence` | `none`, or `hands_only` (fingers holding a leaflet) |
| `isCleanMapDocument` | `true` |
| `confidence` | ≥ 0.85 |

Anything else is rejected, including a missing or malformed assessment. A
reflection of the photographer in glass counts as a person. If the model
contradicts itself — claims the image is clean while also reporting someone in
the background — the reported person wins.

The three constants live at the top of the gate in `js/vision.js`. Setting
`V.ALLOWED_PRESENCE = ['none']` also rejects held paper maps, which is stricter
but throws away most real-world leaflet photos.

**What this does not do.** It lowers the volume of the problem; it does not make
collection unsupervised. Classification has a false-negative rate, people
routinely walk through shots of a map board in a busy plaza, and a strict gate
will reject a large share of otherwise-good uploads. Consent and a human look
before anything ships are still the actual safeguards.

Independently of any of that, the gate is useful today: the Review screen tells
you when a photo did not read as a map, which catches someone who uploaded the
wrong picture.

## Park data format

Import/export uses this shape. Coordinates are fractions of the map image:
`x: 0` is its left edge, `y: 0` the top.

```jsonc
{
  "park": {
    "name": "Wildwood Park",
    "openTime": "09:00",
    "closeTime": "20:00",
    "spanMeters": 1200,          // real-world width the map covers
    "entrance": { "x": 0.5, "y": 0.93 },

    "attractions": [{
      "name": "Cyclone Coaster",
      "kind": "ride",            // ride | walk | play | exhibit
      "x": 0.83, "y": 0.26,
      "zone": "Thrill Ridge",
      "durationMin": 5,          // time on the ride, excluding the queue
      "typicalWaitMin": 55,      // mid-day queue; scaled by hour and crowd level
      "thrill": 5,               // 0 gentle .. 5 extreme
      "minHeightCm": 137,        // 0 if none
      "tags": ["thrill", "heights"],
      "iconic": true             // headline attraction
    }],

    "shows": [{
      "name": "Sea Lion Splash",
      "x": 0.30, "y": 0.60,
      "durationMin": 25,
      "times": ["11:00", "13:30", "16:00"],
      "arriveEarlyMin": 15,      // how early you must be seated
      "capacityRisk": "high",    // low | medium | high
      "tags": ["shows", "animals"],
      "iconic": true
    }],

    "food": [{ "name": "Savanna Grill", "x": 0.25, "y": 0.68, "durationMin": 40 }]
  }
}
```

Valid tags: `thrill`, `water`, `dark`, `spinning`, `heights`, `animals`,
`kids`, `indoor`, `nature`, `interactive`, `shows`, `food`, `history`.

---

## How the route is chosen

Picking which attractions to do, in what order, with which showtime, is an
**Orienteering Problem with Time Windows** — NP-hard, so this uses the standard
construct-then-improve approach rather than pretending to solve it exactly.

**Cost models** (`js/optimizer.js`)

- *Queues* — each attraction's typical wait is scaled by a crowd curve across
  the day (0.45× at rope drop, 1.4× at early-afternoon peak, 0.5× near close),
  then by how busy you said the park is, then by any corrections learned from
  waits you reported during the day.
- *Walking* — straight-line distance across the map, scaled by 1.3 because
  paths wind, divided by a walking speed that accounts for your pace, a
  stroller, small children and crowds.
- *Value* — headline attractions score higher, tags you said you care about
  multiply it, must-sees get a 6× bonus, and anything above your thrill limit
  or matching an avoid tag scores zero and is never routed to. Height limits
  drop an attraction entirely if nobody in the party clears them.

**Search**

1. **Shows first.** They have hard start times, so they claim their slots
   before anything else, highest-value show first, trying each showtime.
2. **Meals and breaks**, placed at whichever eatery is cheapest to reach.
3. **Attractions**, inserted one at a time — always whichever gives the most
   value per minute it adds to the day.
4. **Iterated local search**, a few hundred rounds: relocate a stop, swap two,
   move a show to a different showtime, re-pick a meal's venue, or tear out a
   couple of stops and refill greedily. Anything that improves the day sticks.
5. **A deterministic polish pass** — try every eatery for every meal, and every
   stop in every position — so the random phase cannot leave something obvious
   on the table.

Every candidate ordering is checked by one simulation function that walks the
day forward minute by minute. If a show deadline is missed, a meal falls
outside its window, the walking cap is blown, or you would not make it back to
the gate, the ordering is rejected. That function is the only definition of
"possible" in the codebase.

A fixed RNG seed means the same answers always produce the same plan.

## Live queue times

If the park publishes live waits, the app uses them instead of guessing.

**Around 140 major parks** — Disney, Universal, Merlin, Six Flags, Cedar Fair,
Europa-Park, PortAventura and others across 22 countries — are covered by
[queue-times.com](https://queue-times.com), which allows cross-origin requests.
No API key needed. **It connects on its own** when you read a map or import a
park whose name matches a covered park confidently — you just get told it
happened. Otherwise search for it under **Live queue times**.

**It does need a proxy when hosted.** queue-times.com does not send
`Access-Control-Allow-Origin` for real web origins, so a browser on
`https://yoursite.example` cannot read its responses. It *appears* to work from
`file://`, where the origin is `null` — which is exactly how this got missed
until the first deployment. `netlify/functions/queue-times.js` is a same-origin
proxy that fixes it: Netlify builds and hosts it, nothing to install locally,
and it only forwards the two endpoints the app uses so it cannot be abused as
an open relay. `waits.js` calls the proxy when hosted and falls back to a direct
call locally, so both environments work.

Two gates stop it attaching the wrong park's data: the park name must match
above 0.85, *and* at least a quarter of your attractions must match real rides.
Name-only matches back out silently, because plausible-but-wrong queue times are
worse than none. Ride names are matched by token similarity, so trademark
symbols and stray "The"s do not break it, and anything below the threshold is
listed rather than quietly dropped.

For parks not on that list, Claude can search the web for an official live
wait-times page (needs an API key). It is instructed to return nothing rather
than estimate — a fabricated wait sends you across a park for nothing.

**A live reading is about now, not about 4pm**, so it is used as a *calibration*
rather than a replacement:

- At the moment of the reading, the live figure is used as-is.
- Its influence decays with an ~90-minute half-life as the plan moves away from
  it, falling back to that attraction's usual pattern for the time of day.
- If enough attractions report at, say, 1.5× their modelled wait, that park-wide
  correction is applied at reduced confidence to every attraction with **no**
  live figure of its own — so one sync improves every estimate, not just the
  ones that matched.
- Anything reported **closed** is dropped from the route, and you are told which.

Waits you type in yourself on the Live screen work the same way, correcting the
whole zone around them.

## How the questions work

The interview is not a fixed form. After the three setup questions, the app
picks each next question by **value of information**: for every question it has
not asked, it builds the plan under each possible answer and measures how much
the resulting days differ (Jaccard distance over the chosen attractions, plus
the spread in total value).

The question that would change your day most gets asked next. Questions whose
answers all produce the same itinerary are never asked at all — which is why
the count of remaining questions shrinks faster than the list length suggests.
The percentage shown next to each question is that divergence.

## Comparing two options

Asking someone to rate thrill rides 0–5 gets you a number they invented. Showing
them two real attractions from the park they are standing in and asking which
they would rather do gets you a genuine preference. The interview alternates
between questions and these comparisons — questions capture hard constraints
(heights, hours, what you refuse to miss), comparisons capture taste.

Under the hood it is a **Bradley-Terry model**: each attraction is a feature
vector (its tags, plus intensity, queue cost, marquee status, how long you
linger), and

```
P(you pick A over B) = sigmoid(w · (xA − xB))
```

Every answer is one step of online logistic regression on `w`. Pairs are chosen
to be maximally informative — near a coin-flip under the current weights, so the
answer is not already known, and touching the dimensions with the least evidence
so far. "No strong feeling" is also informative and nudges the two together.

The learned weights feed straight back into the scoring the router uses, and are
shown to you as plain-language chips ("+ animals", "− long queues") so nothing
is happening behind your back. In testing, five "animals over thrill" choices
produced a day with nine animal stops and zero thrill rides; the mirrored
choices put all four coasters first.

**Whole-day comparisons** work the same way one level up. From the plan screen,
*Compare two versions of this day* builds two genuinely different itineraries
under opposing weightings — show-led against attraction-led, gentle against
maximum, queue-averse against headliner-first — picks the two that differ most,
and shows both with what is unique to each. A real example from the sample park:

| | Show-led | Attraction-led |
|---|---|---|
| Attractions | 4 | 12 |
| Shows | 5 | 0 |
| Walking | 7.3 km | 4.4 km |
| Queueing | 1h 07m | 2h 36m |

That is a trade-off no yes/no question surfaces. Picking one applies it to
everything from then on.

## During the day

The Live tab tracks where you should be. Mark things **done** or **skipped**,
report what a queue **actually** was, tell it you are **running late**, or just
type what is going on ("we're shattered, cut the walking") and it re-plans the
remainder from your current time and position.

Reported queue times feed back into the model as a per-zone correction, so one
observation improves the estimates for everything nearby.

Free-text steering works offline via keyword rules; with an API key it goes
through the model instead and understands considerably more.

---

## Layout

```
index.html          shell; script tags in dependency order
css/app.css         light + dark, mobile-first
js/model.js         data model, time helpers, the sample park
js/optimizer.js     cost models, simulation, construction, local search
js/questions.js     question bank, value-of-information ranking, offline steering
js/duels.js         A/B preference learning, whole-day comparisons
js/vision.js        Claude calls: photo → park JSON, web search → live waits
js/waits.js         live queue times: provider API, name matching, calibration
js/ui.js            rendering; every screen is a function of state
js/app.js           state, persistence, event wiring
server/proxy.mjs    optional key-holding proxy + static server
```

## Known limits

- **Distances are straight lines × 1.3.** There is no path graph, so a route
  around a lake will be underestimated. Correcting `spanMeters` on the Review
  screen is the main lever you have.
- **Live waits cover theme parks, not zoos.** The provider list is ~140 major
  theme parks; most zoos and safari parks publish nothing live, so those fall
  back to the modelled crowd curve plus whatever you report during the day.
- **The crowd curve is a reasonable shape, not your park's shape.** Without a
  live feed the queue figures are estimates. Reporting one real wait per zone
  during the day corrects a surprising amount.
- **Matching is by name similarity.** If your map calls it "Rapids" and the feed
  calls it "Congo River Rapids", it matches; if the names genuinely differ it
  will not, and the app tells you how many matched rather than pretending.
- **Vision gets names right far more often than numbers.** Queue times and ride
  durations are inferred from what an attraction appears to be. Review them.
- **One park per device.** Import/export is the way to keep more than one.
- **`localStorage` is ~5 MB.** A large map photo can exceed it; the app then
  saves everything except the photo and tells you so.
