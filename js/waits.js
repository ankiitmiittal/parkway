/* ==========================================================================
   waits.js - live queue times.

   Three tiers, tried in order:
     1. Queue-Times.com - a free public API covering ~140 major parks
        (Disney, Universal, Merlin, Six Flags, Cedar Fair, Europa-Park...).
        CORS-enabled, so the browser can call it directly with no key and no
        server. This is the happy path.
     2. Claude web search - for parks that provider does not cover. Costs an
        API call, and is only as good as what the park publishes.
     3. What you type in yourself on the Live screen.

   A live wait tells you about *now*, not about 4pm. So rather than
   overwriting the model, a live reading CALIBRATES it: we compare the
   observed wait against what the model predicted for that moment, and let
   that correction decay as the plan moves away from the observation.

   Note: non-ASCII characters in regexes are written as \u escapes on purpose
   so that a stray re-encoding of this file cannot silently break matching.
   ========================================================================== */
(function (PP) {
  'use strict';

  var W = PP.waits = {};

  var QT_BASE = 'https://queue-times.com';
  var QT_PROXY = '/.netlify/functions/queue-times?path=';
  var PARKS_TTL_MS = 24 * 60 * 60 * 1000;
  var LS_PARKS = 'parkway.qt.parks.v1';

  /* queue-times.com does not send CORS headers for real web origins, so a
     hosted page cannot read its responses directly — only file:// gets away
     with it, because the origin there is null. So: go through the bundled
     same-origin Netlify Function when we are on http(s), and fall back to a
     direct call (which is what works locally, and covers hosts where the
     function is not deployed). */
  function qtFetch(path) {
    var hosted = location.protocol === 'http:' || location.protocol === 'https:';
    var direct = QT_BASE + path;

    if (!hosted) return fetch(direct).then(readJson);

    return fetch(QT_PROXY + encodeURIComponent(path))
      .then(readJson)
      .catch(function (proxyErr) {
        return fetch(direct).then(readJson).catch(function () {
          // Report the proxy failure: it is the one the site owner can fix.
          throw new Error('Live queue times are unavailable. ' + proxyErr.message);
        });
      });
  }

  /* ---------- provider: Queue-Times -------------------------------------- */

  // The park list changes rarely; cache it for a day.
  W.listParks = function () {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(LS_PARKS) || 'null'); } catch (e) { /* ignore */ }
    if (cached && Date.now() - cached.at < PARKS_TTL_MS && cached.parks) {
      return Promise.resolve(cached.parks);
    }
    return qtFetch('/parks.json')
      .then(function (groups) {
        var parks = [];
        (groups || []).forEach(function (g) {
          (g.parks || []).forEach(function (p) {
            parks.push({ id: p.id, name: p.name, country: p.country, company: g.name });
          });
        });
        try {
          localStorage.setItem(LS_PARKS, JSON.stringify({ at: Date.now(), parks: parks }));
        } catch (e) { /* quota - fine, we just refetch next time */ }
        return parks;
      });
  };

  W.fetchWaits = function (parkId) {
    return qtFetch('/parks/' + parkId + '/queue_times.json')
      .then(function (data) {
        // Rides live under lands for most parks, at the top level for some.
        var rides = [];
        (data.lands || []).forEach(function (land) {
          (land.rides || []).forEach(function (r) {
            rides.push({ id: r.id, name: r.name, land: land.name,
                         wait: r.wait_time, open: r.is_open !== false,
                         at: r.last_updated });
          });
        });
        (data.rides || []).forEach(function (r) {
          rides.push({ id: r.id, name: r.name, land: '',
                       wait: r.wait_time, open: r.is_open !== false,
                       at: r.last_updated });
        });
        return rides;
      });
  };

  function readJson(res) {
    if (!res.ok) throw new Error('Live wait service returned HTTP ' + res.status + '.');
    return res.json();
  }

  /* ---------- name matching ------------------------------------------------
     Park and ride names never match exactly - trademark symbols, sponsor
     prefixes, "the", spelling. Token-set Dice similarity handles it well
     enough, and anything borderline is shown to the user to confirm.
     --------------------------------------------------------------------- */

  var STOPWORDS = /\b(the|a|an|of|and|at|on|in|ride|experience|adventure|presented|inspired|by|featuring|starring)\b/g;
  var COMBINING = /[̀-ͯ]/g;          // accents, after NFD
  var TRADEMARKS = /[™®©]/g;    // TM, (R), (C)

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(COMBINING, '')
      .replace(TRADEMARKS, ' ')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(STOPWORDS, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(s) {
    return norm(s).split(' ').filter(Boolean);
  }

  // Dice coefficient over token sets, with a bonus when one name contains
  // the other (handles "Cyclone" vs "The Cyclone Coaster").
  function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    var setB = {}, hits = 0;
    tb.forEach(function (t) { setB[t] = (setB[t] || 0) + 1; });
    ta.forEach(function (t) { if (setB[t]) { hits++; setB[t]--; } });
    var dice = (2 * hits) / (ta.length + tb.length);

    var na = norm(a), nb = norm(b);
    if (na && nb && (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0)) {
      dice = Math.max(dice, 0.8);
    }
    return dice;
  }

  W.similarity = similarity;
  W.normalise = norm;

  W.suggestParks = function (parks, query) {
    var q = String(query || '').trim();
    if (!q) return [];
    var scored = parks.map(function (p) {
      return { park: p, score: similarity(p.name, q) };
    }).filter(function (s) { return s.score > 0.2; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 8);
  };

  var AUTO_MATCH = 0.55;

  /* Match our attractions against the provider's ride list. Returns matched
     pairs plus the ones we could not place, so the UI can be honest. */
  W.matchRides = function (park, liveRides) {
    var used = {};
    var matched = [], unmatched = [];

    park.attractions.forEach(function (a) {
      var best = null;
      liveRides.forEach(function (r) {
        if (used[r.id]) return;
        var s = similarity(a.name, r.name);
        if (!best || s > best.score) best = { ride: r, score: s };
      });
      if (best && best.score >= AUTO_MATCH) {
        used[best.ride.id] = true;
        matched.push({ attraction: a, ride: best.ride, score: best.score });
      } else {
        unmatched.push({ attraction: a, best: best });
      }
    });

    var extra = liveRides.filter(function (r) { return !used[r.id]; });
    return { matched: matched, unmatched: unmatched, providerOnly: extra };
  };

  /* ---------- applying a reading ------------------------------------------ */

  /* Store live waits on the park. Each entry records the wait, whether the
     ride is open, and when it was read - the optimizer needs all three. */
  W.applyReading = function (park, matched, readAtMinutes) {
    park.liveWaits = park.liveWaits || {};
    var at = readAtMinutes == null ? PP.nowMinutes() : readAtMinutes;
    var applied = 0;

    matched.forEach(function (m) {
      var w = m.ride.wait;
      park.liveWaits[m.attraction.id] = {
        wait: (w == null || isNaN(w)) ? 0 : w,
        open: m.ride.open !== false,
        at: at,
        source: m.ride.name
      };
      applied++;
    });

    park.liveWaitsAt = at;
    return applied;
  };

  W.clear = function (park) {
    park.liveWaits = {};
    park.liveWaitsAt = null;
    park.waitSource = null;
  };

  W.ageMinutes = function (park) {
    if (!park || park.liveWaitsAt == null) return null;
    return Math.max(0, PP.nowMinutes() - park.liveWaitsAt);
  };

  W.closedCount = function (park) {
    var n = 0, lw = (park && park.liveWaits) || {};
    Object.keys(lw).forEach(function (k) { if (!lw[k].open) n++; });
    return n;
  };

  /* One-shot: pick a provider park, pull waits, match, apply. */
  W.sync = function (state, providerParkId, providerParkName) {
    var park = state.park;
    return W.fetchWaits(providerParkId).then(function (rides) {
      var m = W.matchRides(park, rides);
      var n = W.applyReading(park, m.matched);
      park.waitSource = {
        provider: 'queue-times',
        parkId: providerParkId,
        parkName: providerParkName || '',
        matched: m.matched.length,
        total: park.attractions.length
      };
      return { applied: n, match: m, rides: rides };
    });
  };

  /* ---------- tier 2: anything else, via Claude web search ----------------- */

  W.viaClaude = function (state) {
    if (!PP.vision.configured()) {
      return Promise.reject(new Error('Add an API key in Settings to search the web for waits.'));
    }
    return PP.vision.findLiveWaits(state).then(function (res) {
      var park = state.park;
      // The model returns names; match them the same way as the provider feed.
      var pseudo = (res.waits || []).map(function (w, i) {
        return { id: 'web_' + i, name: w.name, land: '',
                 wait: w.waitMinutes, open: w.open !== false, at: null };
      });
      var m = W.matchRides(park, pseudo);
      var n = W.applyReading(park, m.matched);
      park.waitSource = {
        provider: 'web',
        sourceUrl: res.sourceUrl || '',
        matched: m.matched.length,
        total: park.attractions.length
      };
      return { applied: n, match: m, notes: res.notes || [], sourceUrl: res.sourceUrl };
    });
  };

})(window.PP || (window.PP = {}));
