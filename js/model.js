/* ==========================================================================
   model.js — data model, time helpers, defaults, and the bundled sample park.
   Loaded as a classic script so the app runs from file:// with no build step.
   ========================================================================== */
(function (PP) {
  'use strict';

  /* ---------- ids & math ------------------------------------------------ */

  PP.uid = function (prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
  };

  PP.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  // Linear interpolation across a sorted [[x,y], ...] curve.
  PP.curveAt = function (points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (var i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        var a = points[i - 1], b = points[i];
        var t = (x - a[0]) / (b[0] - a[0] || 1);
        return a[1] + t * (b[1] - a[1]);
      }
    }
    return points[points.length - 1][1];
  };

  // Deterministic RNG so a given set of answers always yields the same plan.
  PP.rng = function (seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  };

  /* ---------- time (minutes since midnight) ----------------------------- */

  PP.parseTime = function (str) {
    if (typeof str === 'number') return str;
    if (!str) return null;
    var m = String(str).trim().match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h * 60 + min;
  };

  PP.fmtTime = function (mins) {
    if (mins == null) return '--:--';
    var m = ((Math.round(mins) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    var ap = h < 12 ? 'am' : 'pm';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + (mm < 10 ? '0' : '') + mm + ap;
  };

  PP.fmtDur = function (mins) {
    var m = Math.round(mins);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + 'h ' + r + 'm' : h + 'h';
  };

  /* ---------- taxonomy --------------------------------------------------- */

  // Interest tags the question engine can weight and items can carry.
  PP.INTERESTS = [
    { id: 'thrill',      label: 'Thrill rides',     emoji: '🎢' },
    { id: 'animals',     label: 'Animals',          emoji: '🦁' },
    { id: 'shows',       label: 'Live shows',       emoji: '🎭' },
    { id: 'water',       label: 'Water rides',      emoji: '💦' },
    { id: 'kids',        label: 'Little kids',      emoji: '🧸' },
    { id: 'nature',      label: 'Walks & nature',   emoji: '🌿' },
    { id: 'interactive', label: 'Hands-on',         emoji: '🤲' },
    { id: 'indoor',      label: 'Indoor / aircon',  emoji: '❄️' }
  ];

  // Tags a party may want to rule out entirely.
  PP.AVOIDABLE = [
    { id: 'water',    label: 'Getting soaked' },
    { id: 'dark',     label: 'Dark rides' },
    { id: 'spinning', label: 'Spinning' },
    { id: 'heights',  label: 'Heights' },
    { id: 'thrill',   label: 'Big thrills' }
  ];

  /* ---------- constructors ---------------------------------------------- */

  PP.newPark = function (over) {
    return Object.assign({
      id: PP.uid('park'),
      name: 'My park',
      date: new Date().toISOString().slice(0, 10),
      openTime: 9 * 60,
      closeTime: 20 * 60,
      spanMeters: 1100,      // width/height the map covers, in metres
      mapImage: null,        // data: URL of the uploaded map photo
      entrance: { x: 0.5, y: 0.93 },
      attractions: [],
      shows: [],
      food: []
    }, over || {});
  };

  PP.newParty = function (over) {
    return Object.assign({
      adults: 2,
      kids: [],              // [{ age, heightCm }]
      stroller: false,
      pace: 'normal',        // slow | normal | fast
      willSplit: false       // split up so tall-enough members can ride
    }, over || {});
  };

  PP.newPrefs = function (over) {
    return Object.assign({
      arrive: 9 * 60 + 30,
      depart: 17 * 60,
      crowdLevel: 3,         // 1 (empty) .. 5 (packed)
      interests: {},         // tag -> -1..2 weight
      avoid: [],             // tag ids
      mustSee: [],           // item ids
      thrillTolerance: 5,    // 0..5
      queueAversion: 0,      // 0 = don't mind queueing, 1 = avoid long lines
      lunch: true,
      lunchWindow: [11 * 60 + 30, 14 * 60],
      dinner: false,
      dinnerWindow: [17 * 60, 19 * 60],
      breakEveryMin: 0,      // 0 = no scheduled breaks
      walkBudgetMeters: 0,   // 0 = unlimited
      repeatFavourites: false
    }, over || {});
  };

  /* ---------- item helpers ----------------------------------------------- */

  PP.allItems = function (park) {
    return park.attractions.concat(park.shows, park.food);
  };

  PP.findItem = function (park, id) {
    var all = PP.allItems(park);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  };

  // Every (show, showtime) pair is a separate schedulable node.
  PP.showInstances = function (show) {
    return (show.times || []).map(function (t, i) {
      return { show: show, timeIndex: i, start: t, end: t + show.durationMin };
    });
  };

  /* ---------- sample park ------------------------------------------------
     A zoo / theme-park hybrid. Deliberately built so ordering matters:
     shows are spread across the map and the day, thrill rides sit in one
     far corner, and the parade at the end pins the evening.
     --------------------------------------------------------------------- */

  function ride(name, x, y, zone, dur, wait, o) {
    return Object.assign({
      id: PP.uid('a'), name: name, kind: 'ride', x: x, y: y, zone: zone,
      durationMin: dur, typicalWaitMin: wait, thrill: 0, minHeightCm: 0,
      tags: [], iconic: false
    }, o || {});
  }

  function show(name, x, y, zone, dur, times, o) {
    return Object.assign({
      id: PP.uid('s'), name: name, kind: 'show', x: x, y: y, zone: zone,
      durationMin: dur, times: times, arriveEarlyMin: 10,
      capacityRisk: 'medium', tags: ['shows'], iconic: false
    }, o || {});
  }

  function food(name, x, y, zone, o) {
    return Object.assign({
      id: PP.uid('f'), name: name, kind: 'food', x: x, y: y, zone: zone,
      durationMin: 40, typicalWaitMin: 10, tags: ['food']
    }, o || {});
  }

  PP.samplePark = function () {
    var p = PP.newPark({ name: 'Wildwood Park (sample)', spanMeters: 1200 });

    p.attractions = [
      // Thrill Ridge — far corner, high waits, height limits.
      ride('Cyclone Coaster', 0.83, 0.26, 'Thrill Ridge', 5, 55,
        { thrill: 5, minHeightCm: 137, tags: ['thrill', 'heights'], iconic: true }),
      ride('Sky Drop', 0.88, 0.36, 'Thrill Ridge', 4, 40,
        { thrill: 5, minHeightCm: 132, tags: ['thrill', 'heights'] }),
      ride('River Rapids', 0.75, 0.34, 'Thrill Ridge', 8, 45,
        { thrill: 3, minHeightCm: 107, tags: ['water', 'thrill'], iconic: true }),
      ride('Vortex Spin', 0.86, 0.45, 'Thrill Ridge', 4, 30,
        { thrill: 4, minHeightCm: 122, tags: ['thrill', 'spinning'] }),

      // Savanna
      ride('Safari Trek', 0.22, 0.72, 'Savanna', 20, 35,
        { tags: ['animals', 'nature'], iconic: true }),
      ride('Giraffe Feeding Deck', 0.28, 0.75, 'Savanna', 15, 20,
        { tags: ['animals', 'interactive'] }),
      ride('Lion Ridge Walk', 0.15, 0.66, 'Savanna', 20, 0,
        { kind: 'walk', tags: ['animals', 'nature'] }),

      // Rainforest
      ride('Canopy Skywalk', 0.19, 0.38, 'Rainforest', 25, 15,
        { kind: 'walk', tags: ['heights', 'nature'] }),
      ride('Reptile House', 0.13, 0.30, 'Rainforest', 20, 10,
        { kind: 'walk', tags: ['animals', 'indoor'] }),
      ride('Gorilla Forest', 0.24, 0.28, 'Rainforest', 25, 5,
        { kind: 'walk', tags: ['animals', 'nature'], iconic: true }),
      ride('Butterfly Atrium', 0.30, 0.42, 'Rainforest', 15, 10,
        { kind: 'walk', tags: ['nature', 'indoor', 'interactive'] }),

      // Arctic
      ride('Polar Bear Cove', 0.48, 0.13, 'Arctic', 20, 5,
        { kind: 'walk', tags: ['animals'], iconic: true }),
      ride('Penguin Walkthrough', 0.56, 0.16, 'Arctic', 15, 15,
        { kind: 'walk', tags: ['animals', 'indoor'] }),
      ride('Arctic Blast', 0.60, 0.22, 'Arctic', 6, 30,
        { thrill: 2, minHeightCm: 102, tags: ['dark', 'indoor'] }),

      // Kids Cove
      ride('Jungle Junior Coaster', 0.79, 0.68, 'Kids Cove', 3, 25,
        { thrill: 2, minHeightCm: 92, tags: ['kids', 'thrill'] }),
      ride('Carousel', 0.74, 0.72, 'Kids Cove', 5, 15,
        { thrill: 1, tags: ['kids'] }),
      ride('Splash Pad', 0.82, 0.76, 'Kids Cove', 30, 0,
        { kind: 'play', tags: ['kids', 'water'] }),
      ride('Petting Barn', 0.70, 0.79, 'Kids Cove', 20, 10,
        { tags: ['kids', 'animals', 'interactive'] }),

      // Centre
      ride('Monorail Loop', 0.50, 0.55, 'Central', 12, 20,
        { tags: ['nature'], iconic: false })
    ];

    p.shows = [
      show('Sea Lion Splash', 0.30, 0.60, 'Savanna', 25,
        [11 * 60, 13 * 60 + 30, 16 * 60],
        { arriveEarlyMin: 15, capacityRisk: 'high', tags: ['shows', 'animals', 'water'], iconic: true }),
      show('Birds of Prey Flight', 0.16, 0.46, 'Rainforest', 20,
        [10 * 60 + 30, 12 * 60 + 30, 15 * 60 + 30],
        { arriveEarlyMin: 10, capacityRisk: 'medium', tags: ['shows', 'animals'], iconic: true }),
      show('Elephant Keeper Talk', 0.20, 0.80, 'Savanna', 15,
        [11 * 60 + 45, 14 * 60 + 45],
        { arriveEarlyMin: 5, capacityRisk: 'low', tags: ['shows', 'animals', 'interactive'] }),
      show('Penguin Feeding', 0.53, 0.11, 'Arctic', 15,
        [10 * 60 + 15, 13 * 60, 16 * 60 + 30],
        { arriveEarlyMin: 10, capacityRisk: 'medium', tags: ['shows', 'animals'] }),
      show('Rainforest Rhythms', 0.26, 0.32, 'Rainforest', 30,
        [12 * 60, 15 * 60],
        { arriveEarlyMin: 5, capacityRisk: 'low', tags: ['shows'] }),
      show('Night Lights Parade', 0.50, 0.86, 'Central', 30,
        [18 * 60 + 45],
        { arriveEarlyMin: 25, capacityRisk: 'high', tags: ['shows'], iconic: true })
    ];

    p.food = [
      food('Savanna Grill', 0.25, 0.68, 'Savanna'),
      food('Rainforest Cafe', 0.18, 0.26, 'Rainforest'),
      food('Arctic Scoops', 0.55, 0.20, 'Arctic', { durationMin: 20 }),
      food('Cove Kitchen', 0.76, 0.65, 'Kids Cove'),
      food('Plaza Market', 0.50, 0.88, 'Central')
    ];

    return p;
  };

  /* ---------- serialisation ---------------------------------------------- */

  PP.exportState = function (state) {
    return JSON.stringify({
      version: 1,
      park: state.park,
      party: state.party,
      prefs: state.prefs,
      answered: state.answered,
      progress: state.progress
    }, null, 2);
  };

  PP.importState = function (json) {
    var d = JSON.parse(json);
    if (!d || !d.park) throw new Error('Not a Parkway save file — no "park" key found.');
    var park = PP.newPark(d.park);
    // Tolerate hand-written or AI-produced JSON with missing fields.
    ['attractions', 'shows', 'food'].forEach(function (k) {
      park[k] = (park[k] || []).map(function (it) {
        return Object.assign({
          id: PP.uid(k[0]), x: 0.5, y: 0.5, zone: '', tags: [],
          durationMin: 15, typicalWaitMin: 0, thrill: 0, minHeightCm: 0
        }, it, { kind: it.kind || (k === 'shows' ? 'show' : k === 'food' ? 'food' : 'ride') });
      });
    });
    park.openTime = PP.parseTime(park.openTime) || 9 * 60;
    park.closeTime = PP.parseTime(park.closeTime) || 20 * 60;
    park.shows.forEach(function (s) {
      s.times = (s.times || []).map(PP.parseTime).filter(function (t) { return t != null; });
      if (s.arriveEarlyMin == null) s.arriveEarlyMin = 10;
    });
    return {
      park: park,
      party: PP.newParty(d.party),
      prefs: PP.newPrefs(d.prefs),
      answered: d.answered || {},
      progress: d.progress || { done: [], skipped: [], observedWaits: {} }
    };
  };

})(window.PP || (window.PP = {}));
