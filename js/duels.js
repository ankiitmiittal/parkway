/* ==========================================================================
   duels.js - learning preferences from "which of these two?" choices.

   Asking someone to rate thrill rides 0-5 gets you a number they made up.
   Showing them two real attractions from the park in front of them and
   asking which they would rather do gets you a genuine revealed preference.

   The model is Bradley-Terry over a feature vector: each item is described
   by its tags plus intensity / queue cost / marquee status, and

       P(A beaten by B) = sigmoid(w . (xA - xB))

   Every answer is one step of online logistic regression on w. Pairs are
   chosen to be maximally informative: near a coin-flip under the current
   weights (so the answer is not already known) and touching dimensions we
   have the least evidence about.

   Plan duels are the same idea one level up - two whole days, built under
   different weightings, pick the one you would rather live.
   ========================================================================== */
(function (PP) {
  'use strict';

  var D = PP.duels = {};

  var TAG_DIMS = PP.INTERESTS.map(function (i) { return i.id; });
  var EXTRA_DIMS = ['intensity', 'queuePain', 'marquee', 'longStay'];
  var ALL_DIMS = TAG_DIMS.concat(EXTRA_DIMS);

  var LEARN_RATE = 0.7;
  var WEIGHT_CLAMP = 2.5;
  var MAX_DUELS = 8;          // past this, the marginal answer teaches little
  var PAIR_SAMPLES = 150;

  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  /* ---------- state -------------------------------------------------------- */

  D.blank = function () {
    return { w: {}, seen: {}, history: [], asked: {} };
  };

  D.ensure = function (state) {
    if (!state.duels) state.duels = D.blank();
    return state.duels;
  };

  /* ---------- features ------------------------------------------------------ */

  D.feature = function (item) {
    var f = {};
    (item.tags || []).forEach(function (t) {
      if (TAG_DIMS.indexOf(t) >= 0) f[t] = 1;
    });
    if (item.thrill) f.intensity = PP.clamp(item.thrill / 5, 0, 1);
    if (item.typicalWaitMin) f.queuePain = PP.clamp(item.typicalWaitMin / 60, 0, 1);
    if (item.iconic) f.marquee = 1;
    if (item.durationMin) f.longStay = PP.clamp(item.durationMin / 30, 0, 1);
    return f;
  };

  function diff(a, b) {
    var d = {};
    ALL_DIMS.forEach(function (k) {
      var v = (a[k] || 0) - (b[k] || 0);
      if (v !== 0) d[k] = v;
    });
    return d;
  }

  function dot(w, d) {
    var s = 0;
    Object.keys(d).forEach(function (k) { s += (w[k] || 0) * d[k]; });
    return s;
  }

  function magnitude(d) {
    var s = 0;
    Object.keys(d).forEach(function (k) { s += Math.abs(d[k]); });
    return s;
  }

  /* ---------- which items may be compared ------------------------------------ */

  function eligible(state) {
    var party = state.party;
    return state.park.attractions.concat(state.park.shows).filter(function (it) {
      if (state.progress.done.indexOf(it.id) >= 0) return false;
      if (state.progress.skipped.indexOf(it.id) >= 0) return false;
      // Do not ask about rides nobody in the party can go on.
      if (it.minHeightCm > 0 && party.kids.length && !party.willSplit) {
        var allBlocked = party.kids.every(function (k) {
          return k.heightCm != null && k.heightCm < it.minHeightCm;
        });
        if (allBlocked) return false;
      }
      return true;
    });
  }

  /* ---------- choosing the next pair ------------------------------------------ */

  D.pick = function (state) {
    var d = D.ensure(state);
    var items = eligible(state);
    if (items.length < 4) return null;

    var best = null;
    var rnd = PP.rng(9001 + d.history.length * 7);

    for (var n = 0; n < PAIR_SAMPLES; n++) {
      var i = Math.floor(rnd() * items.length);
      var j = Math.floor(rnd() * items.length);
      if (i === j) continue;

      var A = items[i], B = items[j];
      var key = A.id < B.id ? A.id + '|' + B.id : B.id + '|' + A.id;
      if (d.asked[key]) continue;

      var dv = diff(D.feature(A), D.feature(B));
      var mag = magnitude(dv);
      if (mag < 0.8) continue;                  // too similar to be worth asking

      // Most informative when the current model cannot call it.
      var p = sigmoid(dot(d.w, dv));
      var closeness = 1 - Math.abs(p - 0.5) * 2;

      // Prefer dimensions we have little evidence on.
      var novelty = 0, dims = Object.keys(dv);
      dims.forEach(function (k) { novelty += 1 / (1 + (d.seen[k] || 0)); });
      novelty /= Math.max(1, dims.length);

      var score = (0.35 + closeness) * (0.4 + novelty) * Math.min(1.4, mag / 2);
      if (!best || score > best.score) best = { a: A, b: B, key: key, score: score };
    }

    return best;
  };

  /* ---------- learning from an answer ------------------------------------------ */

  D.record = function (state, winnerId, loserId) {
    var d = D.ensure(state);
    var win = PP.findItem(state.park, winnerId);
    var lose = PP.findItem(state.park, loserId);
    if (!win || !lose) return d;

    var dv = diff(D.feature(win), D.feature(lose));
    var p = sigmoid(dot(d.w, dv));
    var step = LEARN_RATE * (1 - p);            // logistic gradient ascent

    Object.keys(dv).forEach(function (k) {
      d.w[k] = PP.clamp((d.w[k] || 0) + step * dv[k], -WEIGHT_CLAMP, WEIGHT_CLAMP);
      d.seen[k] = (d.seen[k] || 0) + Math.abs(dv[k]);
    });

    var key = winnerId < loserId ? winnerId + '|' + loserId : loserId + '|' + winnerId;
    d.asked[key] = true;
    d.history.push({ winner: winnerId, loser: loserId });
    return d;
  };

  // "No strong feeling" still teaches something: the two are close, so pull
  // the weights on their difference gently towards each other.
  D.recordTie = function (state, aId, bId) {
    var d = D.ensure(state);
    var A = PP.findItem(state.park, aId), B = PP.findItem(state.park, bId);
    if (!A || !B) return d;
    var dv = diff(D.feature(A), D.feature(B));
    var p = sigmoid(dot(d.w, dv));
    var step = LEARN_RATE * 0.5 * (0.5 - p);
    Object.keys(dv).forEach(function (k) {
      d.w[k] = PP.clamp((d.w[k] || 0) + step * dv[k], -WEIGHT_CLAMP, WEIGHT_CLAMP);
      d.seen[k] = (d.seen[k] || 0) + Math.abs(dv[k]) * 0.5;
    });
    var key = aId < bId ? aId + '|' + bId : bId + '|' + aId;
    d.asked[key] = true;
    d.history.push({ winner: null, loser: null, tie: [aId, bId] });
    return d;
  };

  /* ---------- feeding the learned weights back into preferences ---------------- */

  D.commit = function (state) {
    var d = D.ensure(state);
    var prefs = state.prefs;

    TAG_DIMS.forEach(function (tag) {
      if (d.w[tag] == null) return;
      prefs.interests[tag] = PP.clamp(d.w[tag], -2, 2);
    });

    // Strong dislike of intensity tightens the thrill ceiling; strong liking
    // lifts it, but never past what they explicitly told us.
    if (d.w.intensity != null && !state.answered.hasOwnProperty('thrill')) {
      if (d.w.intensity <= -1.2) prefs.thrillTolerance = 2;
      else if (d.w.intensity <= -0.5) prefs.thrillTolerance = 3;
      else if (d.w.intensity >= 1.0) prefs.thrillTolerance = 5;
    }

    // Hating long queues is a real preference and worth acting on.
    if (d.w.queuePain != null) {
      prefs.queueAversion = PP.clamp(-d.w.queuePain / 2, 0, 1);
    }
    return prefs;
  };

  /* ---------- transparency ------------------------------------------------------ */

  var DIM_LABEL = {
    intensity: 'intense rides', queuePain: 'long queues',
    marquee: 'headline attractions', longStay: 'things you linger over'
  };
  PP.INTERESTS.forEach(function (i) { DIM_LABEL[i.id] = i.label.toLowerCase(); });

  D.learned = function (state) {
    var d = D.ensure(state);
    return Object.keys(d.w)
      .map(function (k) { return { dim: k, label: DIM_LABEL[k] || k, w: d.w[k] }; })
      .filter(function (x) { return Math.abs(x.w) >= 0.35; })
      .sort(function (a, b) { return Math.abs(b.w) - Math.abs(a.w); })
      .slice(0, 6);
  };

  D.count = function (state) { return D.ensure(state).history.length; };

  D.shouldAsk = function (state) {
    var d = D.ensure(state);
    if (d.history.length >= MAX_DUELS) return false;
    return !!D.pick(state);
  };

  /* ---------- plan duels ---------------------------------------------------------
     Two whole days built under different weightings. This catches trade-offs
     that no single question exposes - "fewer things but no rushing" against
     "everything, at a march".
     --------------------------------------------------------------------- */

  D.AXES = [
    { id: 'shows',   label: 'Show-led',        blurb: 'built around the scheduled shows',
      apply: function (s) { s.prefs.interests.shows = 2; } },
    { id: 'rides',   label: 'Attraction-led',  blurb: 'skips shows for more attractions',
      apply: function (s) { s.prefs.interests.shows = -1.5; } },
    { id: 'light',   label: 'Gentle',          blurb: 'much less walking, slower pace',
      apply: function (s) { s.prefs.walkBudgetMeters = 3500; s.party.pace = 'slow';
                            s.prefs.breakEveryMin = 150; } },
    { id: 'packed',  label: 'Maximum',         blurb: 'fit in as much as physically possible',
      apply: function (s) { s.party.pace = 'fast'; s.prefs.walkBudgetMeters = 0;
                            s.prefs.breakEveryMin = 0; } },
    { id: 'quiet',   label: 'Queue-averse',    blurb: 'avoids anything with a long line',
      apply: function (s) { s.prefs.queueAversion = 0.9; } },
    { id: 'marquee', label: 'Headliners',      blurb: 'the famous ones, however long the wait',
      apply: function (s) { s.prefs.queueAversion = 0; s.prefs.interests.thrill =
                            Math.max(s.prefs.interests.thrill || 0, 1); } }
  ];

  function variantState(state, axis) {
    var s = {
      park: state.park,
      party: JSON.parse(JSON.stringify(state.party)),
      prefs: JSON.parse(JSON.stringify(state.prefs)),
      progress: state.progress,
      answered: state.answered
    };
    axis.apply(s);
    return s;
  }

  function planIds(plan) {
    var set = new Set();
    if (plan.ok) plan.stops.forEach(function (s) { set.add(s.spec.showId || s.spec.id); });
    return set;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 0;
    var inter = 0;
    a.forEach(function (x) { if (b.has(x)) inter++; });
    return 1 - inter / (a.size + b.size - inter || 1);
  }

  /* Build the two most different days we can offer right now. */
  D.planPair = function (state, opts) {
    opts = opts || {};
    var iters = opts.iterations || 250;
    var built = [];

    D.AXES.forEach(function (axis) {
      if (opts.exclude && opts.exclude.indexOf(axis.id) >= 0) return;
      var plan = PP.plan(variantState(state, axis), { iterations: iters });
      if (plan.ok && plan.stops.length) built.push({ axis: axis, plan: plan, ids: planIds(plan) });
    });

    if (built.length < 2) return null;

    var best = null;
    for (var i = 0; i < built.length; i++) {
      for (var j = i + 1; j < built.length; j++) {
        var dist = jaccard(built[i].ids, built[j].ids);
        if (!best || dist > best.dist) best = { a: built[i], b: built[j], dist: dist };
      }
    }
    if (!best || best.dist < 0.15) return null;   // the options are the same day
    return best;
  };

  /* What actually differs between two plans, in plain words. */
  D.contrast = function (a, b) {
    var aIds = planIds(a.plan), bIds = planIds(b.plan);
    var onlyA = [], onlyB = [];
    a.plan.stops.forEach(function (s) {
      var id = s.spec.showId || s.spec.id;
      if (!bIds.has(id) && s.spec.kind !== 'food' && s.spec.kind !== 'break') onlyA.push(s.spec.item.name);
    });
    b.plan.stops.forEach(function (s) {
      var id = s.spec.showId || s.spec.id;
      if (!aIds.has(id) && s.spec.kind !== 'food' && s.spec.kind !== 'break') onlyB.push(s.spec.item.name);
    });
    return { onlyA: onlyA.slice(0, 5), onlyB: onlyB.slice(0, 5) };
  };

  D.adoptAxis = function (state, axisId) {
    var axis = D.AXES.filter(function (x) { return x.id === axisId; })[0];
    if (!axis) return null;
    axis.apply(state);
    state.answered['planDuel:' + axisId] = true;
    return axis;
  };

})(window.PP || (window.PP = {}));
