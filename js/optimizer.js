/* ==========================================================================
   optimizer.js — the routing engine.

   The problem is an Orienteering Problem with Time Windows (OPTW):
   choose a SUBSET of attractions and a SHOWTIME for each show, and an ORDER,
   that maximises total value subject to walking time, queue length that
   varies by hour, fixed show start times, meal windows and park closing.

   That is NP-hard, so we use the standard construction + local-search combo:
     1. score every candidate against the party's stated preferences
     2. greedy insertion, cheapest-insertion style, in three passes
        (shows first — they have hard windows — then meals, then rides)
     3. iterated local search: relocate / swap / re-time a show /
        ruin-and-recreate, keeping any move that improves the objective
   Everything is driven by a seeded RNG so the same answers give the same plan.
   ========================================================================== */
(function (PP) {
  'use strict';

  /* ---------- tuning constants ------------------------------------------ */

  var BASE_WALK_M_PER_MIN = 80;   // ~4.8 km/h on flat ground
  var PATH_FACTOR = 1.3;          // paths wind; straight-line distance is a lie
  var SHOW_GRACE_MIN = 0;         // no arriving late for a seated show
  var ILS_ITERATIONS = 500;

  // Queue length through the day, as a multiple of the item's typical wait.
  // Parks empty at rope drop, peak early afternoon, then drain.
  var CROWD_CURVE = [
    [0.00, 0.45], [0.12, 0.75], [0.30, 1.15], [0.50, 1.40],
    [0.68, 1.20], [0.85, 0.80], [1.00, 0.50]
  ];

  var CROWD_LEVEL_FACTOR = [0.6, 0.8, 1.0, 1.25, 1.55];
  var PACE_FACTOR = { slow: 0.75, normal: 1.0, fast: 1.18 };

  // How fast a live wait reading stops telling you anything. At 90 minutes
  // away from the reading its influence is down to ~37%, at 3 hours ~13%.
  var LIVE_DECAY_MIN = 90;

  /* ---------- context ----------------------------------------------------
     Everything the cost functions need, precomputed once per plan.
     --------------------------------------------------------------------- */

  PP.buildContext = function (state, over) {
    var park = state.park, party = state.party, prefs = state.prefs;
    var progress = state.progress || { done: [], skipped: [], observedWaits: {} };

    var speed = BASE_WALK_M_PER_MIN * (PACE_FACTOR[party.pace] || 1);
    if (party.stroller) speed *= 0.90;
    if (party.kids.some(function (k) { return k.age != null && k.age < 6; })) speed *= 0.85;
    speed *= 1 - 0.04 * (prefs.crowdLevel - 3);   // crowds slow you down

    var ctx = {
      park: park,
      party: party,
      prefs: prefs,
      progress: progress,
      walkSpeed: Math.max(30, speed),
      crowdFactor: CROWD_LEVEL_FACTOR[PP.clamp(prefs.crowdLevel, 1, 5) - 1],
      zoneCorr: zoneCorrections(park, progress),
      startTime: Math.max(prefs.arrive, park.openTime),
      endTime: Math.min(prefs.depart, park.closeTime),
      startPos: park.entrance,
      exitPos: park.entrance,
      done: new Set(progress.done || []),
      skipped: new Set(progress.skipped || []),
      live: park.liveWaits || {},
      liveAt: park.liveWaitsAt == null ? null : park.liveWaitsAt,
      liveCalibration: null,
      warnings: [],
      rng: PP.rng(1337)
    };

    // One live reading also tells you something about every ride you did not
    // get a number for: if everything measured is queueing at 1.4x the model,
    // the park is simply busier than you said it was.
    ctx.liveCalibration = calibrate(ctx);

    return Object.assign(ctx, over || {});
  };

  // Observed waits teach us that a zone is busier or quieter than modelled.
  function zoneCorrections(park, progress) {
    var obs = progress.observedWaits || {};
    var sums = {}, counts = {};
    Object.keys(obs).forEach(function (itemId) {
      var item = PP.findItem(park, itemId);
      if (!item || !item.typicalWaitMin) return;
      var ratio = obs[itemId] / item.typicalWaitMin;
      var z = item.zone || '_';
      sums[z] = (sums[z] || 0) + ratio;
      counts[z] = (counts[z] || 0) + 1;
    });
    var out = {};
    Object.keys(sums).forEach(function (z) {
      // Pull only partway towards the observation — one data point is noisy.
      var mean = sums[z] / counts[z];
      out[z] = PP.clamp(1 + 0.6 * (mean - 1), 0.3, 3);
    });
    return out;
  }

  /* ---------- cost models ------------------------------------------------ */

  PP.crowdMultiplier = function (park, t) {
    var span = park.closeTime - park.openTime || 1;
    return PP.curveAt(CROWD_CURVE, PP.clamp((t - park.openTime) / span, 0, 1));
  };

  // What the model alone predicts, before any live reading is folded in.
  function modelledWait(item, t, ctx) {
    if (!item.typicalWaitMin) return 0;
    var m = PP.crowdMultiplier(ctx.park, t) * ctx.crowdFactor *
            (ctx.zoneCorr[item.zone || '_'] || 1);
    return item.typicalWaitMin * m;
  }

  // Median of live/modelled across everything we have a reading for.
  function calibrate(ctx) {
    var ids = Object.keys(ctx.live || {});
    if (ids.length < 3 || ctx.liveAt == null) return null;
    var ratios = [];
    ids.forEach(function (id) {
      var entry = ctx.live[id];
      if (!entry || !entry.open) return;
      var item = PP.findItem(ctx.park, id);
      if (!item || !item.typicalWaitMin) return;
      var predicted = modelledWait(item, entry.at, ctx);
      if (predicted > 0) ratios.push(entry.wait / predicted);
    });
    if (ratios.length < 3) return null;
    ratios.sort(function (a, b) { return a - b; });
    var mid = Math.floor(ratios.length / 2);
    var med = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
    return PP.clamp(med, 0.2, 4);
  }

  PP.waitFor = function (item, t, ctx) {
    var live = ctx.live && ctx.live[item.id];
    var modelled = modelledWait(item, t, ctx);

    if (live && live.open) {
      // A reading is about the moment it was taken. Trust it fully at that
      // moment and fade back to the model as the plan moves away from it.
      var influence = Math.exp(-Math.abs(t - live.at) / LIVE_DECAY_MIN);
      var atRead = modelledWait(item, live.at, ctx);
      if (atRead <= 0) {
        // Model says this never queues, but it is queueing right now.
        return Math.round(live.wait * influence);
      }
      var ratio = live.wait / atRead;
      return Math.round(Math.max(0, modelled * (1 + (ratio - 1) * influence)));
    }

    if (!modelled) return 0;

    if (ctx.liveCalibration != null && ctx.liveAt != null) {
      // No reading for this one, but the park-wide correction still applies,
      // with less confidence than a direct measurement.
      var inf2 = 0.6 * Math.exp(-Math.abs(t - ctx.liveAt) / LIVE_DECAY_MIN);
      return Math.round(Math.max(0, modelled * (1 + (ctx.liveCalibration - 1) * inf2)));
    }

    return Math.round(modelled);
  };

  PP.modelledWait = modelledWait;

  PP.distanceMeters = function (a, b, ctx) {
    var s = ctx.park.spanMeters || 1100;
    var dx = (a.x - b.x) * s, dy = (a.y - b.y) * s;
    return Math.hypot(dx, dy) * PATH_FACTOR;
  };

  PP.travelMinutes = function (a, b, ctx) {
    return PP.distanceMeters(a, b, ctx) / ctx.walkSpeed;
  };

  /* ---------- scoring ----------------------------------------------------
     Returns 0 for anything the party has ruled out, so it never gets picked.
     --------------------------------------------------------------------- */

  PP.scoreItem = function (item, ctx) {
    var prefs = ctx.prefs, party = ctx.party;
    var mustSee = prefs.mustSee.indexOf(item.id) >= 0;

    if (!mustSee) {
      // Hard exclusions.
      if (item.thrill > prefs.thrillTolerance) return 0;
      for (var i = 0; i < item.tags.length; i++) {
        if (prefs.avoid.indexOf(item.tags[i]) >= 0) return 0;
      }
    }

    var base = item.iconic ? 100 : 60;
    if (item.kind === 'show') {
      base *= item.capacityRisk === 'high' ? 1.15 : item.capacityRisk === 'low' ? 0.95 : 1;
    }

    // Interest match: each tag the party cares about lifts or drops the score.
    var lift = 0;
    item.tags.forEach(function (t) { lift += (prefs.interests[t] || 0); });
    var interest = PP.clamp(1 + 0.5 * lift, 0.15, 3);

    // Height limits: does everyone in the party actually get to ride?
    var fit = 1;
    if (item.minHeightCm > 0 && party.kids.length) {
      var blocked = party.kids.filter(function (k) {
        return k.heightCm != null && k.heightCm < item.minHeightCm;
      }).length;
      if (blocked === party.kids.length && !party.willSplit && !mustSee) return 0;
      if (blocked > 0) fit = party.willSplit ? 0.7 : 0.35;
    }

    var score = base * interest * fit;

    // Some people would rather do three small things than queue an hour for
    // one big one. Learned from A/B comparisons, or set directly.
    if (prefs.queueAversion && item.typicalWaitMin) {
      score *= 1 - prefs.queueAversion * PP.clamp(item.typicalWaitMin / 60, 0, 1) * 0.7;
    }

    if (mustSee) score *= 6;
    return score;
  };

  /* ---------- candidate generation --------------------------------------- */

  // A "spec" is a schedulable thing: a ride, one instance of a show, a meal,
  // or a rest break. Specs are what the optimizer shuffles around.
  function attractionSpec(item, value) {
    return { kind: 'ride', id: item.id, item: item, value: value, mandatory: false };
  }

  function showSpec(inst, value) {
    return {
      kind: 'show', id: inst.show.id + '@' + inst.timeIndex, showId: inst.show.id,
      item: inst.show, value: value, startAt: inst.start,
      timeIndex: inst.timeIndex, mandatory: false
    };
  }

  function mealSpec(item, label, window, durationMin) {
    return {
      kind: 'food', id: 'meal_' + label, item: item, value: 0,
      window: window, label: label, mandatory: true,
      durationMin: durationMin || item.durationMin || 40
    };
  }

  function breakSpec(n) {
    return {
      kind: 'break', id: 'break_' + n, item: { name: 'Rest & recharge', tags: [] },
      value: 0, durationMin: 20, mandatory: true
    };
  }

  PP.candidates = function (ctx) {
    var park = ctx.park, out = { shows: [], rides: [], meals: [], closed: [] };

    park.attractions.forEach(function (a) {
      if (ctx.done.has(a.id) || ctx.skipped.has(a.id)) return;
      // A live feed reporting the ride as down is a hard exclusion; there is
      // no point routing anyone to a closed attraction.
      var live = ctx.live && ctx.live[a.id];
      if (live && live.open === false) { out.closed.push(a.name); return; }
      var v = PP.scoreItem(a, ctx);
      if (v > 0) out.rides.push(attractionSpec(a, v));
    });

    park.shows.forEach(function (s) {
      if (ctx.done.has(s.id) || ctx.skipped.has(s.id)) return;
      var v = PP.scoreItem(s, ctx);
      if (v <= 0) return;
      PP.showInstances(s).forEach(function (inst) {
        // Drop showtimes that are already impossible.
        if (inst.start - s.arriveEarlyMin < ctx.startTime) return;
        if (inst.end > ctx.endTime) return;
        out.shows.push(showSpec(inst, v));
      });
    });

    // Meals are placed at whichever eatery is most convenient, decided during
    // insertion — so we generate one spec per eatery and keep the best.
    var prefs = ctx.prefs;
    if (prefs.lunch) out.meals.push({ label: 'Lunch', window: prefs.lunchWindow });
    if (prefs.dinner) out.meals.push({ label: 'Dinner', window: prefs.dinnerWindow });

    return out;
  };

  /* ---------- simulation -------------------------------------------------
     Walk the ordered list forward in time and work out whether it is even
     possible, and what it costs. This is the single source of truth for
     feasibility — every heuristic below just calls it.
     --------------------------------------------------------------------- */

  PP.simulate = function (order, ctx) {
    var t = ctx.startTime;
    var pos = ctx.startPos;
    var walk = 0, idle = 0, queued = 0, value = 0;
    var stops = [];

    for (var i = 0; i < order.length; i++) {
      var spec = order[i];
      var stop = { spec: spec, item: spec.item };

      if (spec.kind === 'break') {
        stop.travelMin = 0;
        stop.arrive = t;
        stop.waitMin = 0;
        stop.start = t;
        stop.end = t + spec.durationMin;
      } else {
        var dist = PP.distanceMeters(pos, spec.item, ctx);
        var travel = dist / ctx.walkSpeed;
        walk += dist;
        stop.travelMin = travel;
        stop.distMeters = dist;
        stop.arrive = t + travel;

        if (spec.kind === 'show') {
          var deadline = spec.startAt - (spec.item.arriveEarlyMin || 0);
          if (stop.arrive > deadline + SHOW_GRACE_MIN) return infeasible('late-for-show', spec);
          stop.deadline = deadline;
          stop.start = spec.startAt;
          stop.end = spec.startAt + spec.item.durationMin;
          stop.waitMin = 0;
          stop.idleMin = Math.max(0, spec.startAt - stop.arrive);
          idle += stop.idleMin;
        } else {
          var readyAt = stop.arrive;
          if (spec.kind === 'food' && spec.window) {
            if (stop.arrive > spec.window[1]) return infeasible('missed-meal-window', spec);
            if (stop.arrive < spec.window[0]) {
              // Nobody eats lunch at opening time. Arriving early means
              // standing around, which the objective punishes — so the
              // search moves the meal instead of parking it at 9am.
              stop.idleMin = spec.window[0] - stop.arrive;
              idle += stop.idleMin;
              readyAt = spec.window[0];
            }
          }
          var w = PP.waitFor(spec.item, readyAt, ctx);
          stop.waitMin = w;
          queued += w;
          stop.start = readyAt + w;
          stop.end = stop.start + (spec.durationMin || spec.item.durationMin || 15);
        }
        pos = spec.item;
      }

      if (stop.end > ctx.endTime) return infeasible('past-departure', spec);
      value += spec.value || 0;
      t = stop.end;
      stops.push(stop);
    }

    // Getting back to the gate counts too.
    var exitDist = stops.length ? PP.distanceMeters(pos, ctx.exitPos, ctx) : 0;
    var exitMin = exitDist / ctx.walkSpeed;
    if (t + exitMin > ctx.endTime) return infeasible('cannot-reach-exit', null);
    walk += exitDist;

    if (ctx.prefs.walkBudgetMeters > 0 && walk > ctx.prefs.walkBudgetMeters) {
      return infeasible('over-walk-budget', null);
    }

    return {
      ok: true, stops: stops, value: value, walkMeters: walk,
      idleMin: idle, queuedMin: queued, endTime: t,
      exitMin: exitMin, exitAt: t + exitMin
    };
  };

  function infeasible(reason, spec) {
    return { ok: false, reason: reason, spec: spec, value: -Infinity, stops: [] };
  }

  // What we actually maximise. Value dominates; walking and standing around
  // break ties, so between two equally good plans we return the easier one.
  PP.objective = function (sim) {
    if (!sim.ok) return -Infinity;
    return sim.value - sim.walkMeters * 0.004 - sim.idleMin * 0.35;
  };

  /* ---------- construction: greedy insertion ------------------------------ */

  function tryInsertBest(order, spec, ctx, requireFeasible) {
    var best = null;
    for (var pos = 0; pos <= order.length; pos++) {
      var trial = order.slice();
      trial.splice(pos, 0, spec);
      var sim = PP.simulate(trial, ctx);
      if (!sim.ok) continue;
      var obj = PP.objective(sim);
      if (!best || obj > best.obj) best = { pos: pos, obj: obj, sim: sim, order: trial };
    }
    if (!best && requireFeasible) return null;
    return best;
  }

  // Pick the eatery that costs least to visit, given the route so far.
  function insertMeal(order, meal, ctx) {
    var best = null;
    var quick = ctx.prefs.lunchQuick && meal.label === 'Lunch';
    ctx.park.food.forEach(function (f) {
      var spec = mealSpec(f, meal.label, meal.window, quick ? 20 : f.durationMin);
      var r = tryInsertBest(order, spec, ctx, true);
      if (r && (!best || r.obj > best.obj)) best = r;
    });
    return best;
  }

  PP.construct = function (ctx) {
    var cand = PP.candidates(ctx);
    var order = [];

    if (cand.closed.length) {
      ctx.warnings.push('Closed right now, so left out: ' +
        cand.closed.slice(0, 6).join(', ') +
        (cand.closed.length > 6 ? ' and ' + (cand.closed.length - 6) + ' more' : '') + '.');
    }

    // Pass 1 — shows. Hard time windows, so they claim their slots first.
    // Highest-value show first; for each, try every remaining showtime.
    var showsByValue = {};
    cand.shows.forEach(function (s) {
      (showsByValue[s.showId] = showsByValue[s.showId] || []).push(s);
    });
    Object.keys(showsByValue)
      .sort(function (a, b) { return showsByValue[b][0].value - showsByValue[a][0].value; })
      .forEach(function (showId) {
        var best = null;
        showsByValue[showId].forEach(function (spec) {
          var r = tryInsertBest(order, spec, ctx, true);
          if (r && (!best || r.obj > best.obj)) best = r;
        });
        if (best) order = best.order;
      });

    // Pass 2 — meals and breaks. Mandatory, so they go in before rides
    // compete for the same minutes.
    // If a meal the visitor asked for cannot be fitted, say so rather than
    // quietly dropping it — they planned their day around eating.
    cand.meals.forEach(function (meal) {
      var r = insertMeal(order, meal, ctx);
      if (r) order = r.order;
      else ctx.warnings.push(meal.label + ' would not fit between ' +
        PP.fmtTime(meal.window[0]) + ' and ' + PP.fmtTime(meal.window[1]) + '.');
    });

    if (ctx.prefs.breakEveryMin > 0) {
      var span = ctx.endTime - ctx.startTime;
      var n = Math.max(0, Math.floor(span / ctx.prefs.breakEveryMin) - 1);
      for (var b = 0; b < n; b++) {
        var r = tryInsertBest(order, breakSpec(b), ctx, true);
        if (r) order = r.order;
      }
    }

    // Pass 3 — rides, by value density: value per minute the insertion costs.
    var pool = cand.rides.slice();
    var guard = 0;
    while (pool.length && guard++ < 200) {
      var baseSim = PP.simulate(order, ctx);
      var baseEnd = baseSim.ok ? baseSim.endTime : ctx.startTime;
      var pick = null;

      for (var i = 0; i < pool.length; i++) {
        var r = tryInsertBest(order, pool[i], ctx, true);
        if (!r) continue;
        var costMin = Math.max(1, r.sim.endTime - baseEnd);
        var density = pool[i].value / costMin;
        if (!pick || density > pick.density) pick = { i: i, r: r, density: density };
      }

      if (!pick) break;               // nothing else fits in the day
      order = pick.r.order;
      pool.splice(pick.i, 1);
    }

    return order;
  };

  /* ---------- improvement: iterated local search -------------------------- */

  // Anything may be *relocated* — simulate() rejects the move if it breaks a
  // time window. Only non-mandatory stops may be *removed*: a meal can shift
  // around the day, but it cannot silently vanish from it.
  function relocIndices(order) {
    var idx = [];
    for (var i = 0; i < order.length; i++) idx.push(i);
    return idx;
  }

  function removableIndices(order) {
    var idx = [];
    for (var i = 0; i < order.length; i++) if (!order[i].mandatory) idx.push(i);
    return idx;
  }

  PP.improve = function (order, ctx, iterations) {
    var bestOrder = order.slice();
    var bestObj = PP.objective(PP.simulate(bestOrder, ctx));
    var rnd = ctx.rng;
    var n = iterations == null ? ILS_ITERATIONS : iterations;

    var usedShowIds = {};
    order.forEach(function (s) { if (s.kind === 'show') usedShowIds[s.showId] = true; });

    var cand = PP.candidates(ctx);

    for (var it = 0; it < n; it++) {
      var trial = bestOrder.slice();
      var move = rnd();

      if (move < 0.30) {
        // Relocate one stop.
        var m = relocIndices(trial);
        if (!m.length) continue;
        var from = m[Math.floor(rnd() * m.length)];
        var spec = trial.splice(from, 1)[0];
        var to = Math.floor(rnd() * (trial.length + 1));
        trial.splice(to, 0, spec);

      } else if (move < 0.48) {
        // Swap two stops.
        var mm = relocIndices(trial);
        if (mm.length < 2) continue;
        var a = mm[Math.floor(rnd() * mm.length)];
        var b = mm[Math.floor(rnd() * mm.length)];
        if (a === b) continue;
        var tmp = trial[a]; trial[a] = trial[b]; trial[b] = tmp;

      } else if (move < 0.60) {
        // Re-pick the eatery for a meal. Meals are placed before the rides
        // exist, so the first choice is often a detour once the day fills in.
        var meals = trial.filter(function (s) { return s.kind === 'food'; });
        if (!meals.length) continue;
        var meal = meals[Math.floor(rnd() * meals.length)];
        var others = ctx.park.food.filter(function (f) { return f !== meal.item; });
        if (!others.length) continue;
        var venue = others[Math.floor(rnd() * others.length)];
        trial = trial.filter(function (s) { return s !== meal; });
        var moved = tryInsertBest(
          trial,
          mealSpec(venue, meal.label, meal.window, meal.durationMin),
          ctx, true
        );
        if (!moved) continue;
        trial = moved.order;

      } else if (move < 0.72) {
        // Move a show to one of its other showtimes.
        var shows = trial.filter(function (s) { return s.kind === 'show'; });
        if (!shows.length) continue;
        var target = shows[Math.floor(rnd() * shows.length)];
        var alts = cand.shows.filter(function (s) {
          return s.showId === target.showId && s.timeIndex !== target.timeIndex;
        });
        if (!alts.length) continue;
        var alt = alts[Math.floor(rnd() * alts.length)];
        trial = trial.filter(function (s) { return s !== target; });
        var placed = tryInsertBest(trial, alt, ctx, true);
        if (!placed) continue;
        trial = placed.order;

      } else if (move < 0.88) {
        // Ruin & recreate: drop a couple of stops, refill greedily.
        // Mandatory stops are exempt — a meal may move, never disappear.
        var mv = removableIndices(trial);
        if (!mv.length) continue;
        var kills = 1 + Math.floor(rnd() * 2);
        for (var k = 0; k < kills && mv.length; k++) {
          var ki = Math.floor(rnd() * mv.length);
          trial.splice(mv[ki], 1);
          mv = removableIndices(trial);
        }
        trial = refill(trial, cand, ctx);

      } else {
        // Try to squeeze in something currently left out.
        var inUse = {};
        trial.forEach(function (s) { inUse[s.id] = true; if (s.showId) inUse[s.showId] = true; });
        var spare = cand.rides.filter(function (s) { return !inUse[s.id]; })
          .concat(cand.shows.filter(function (s) { return !inUse[s.showId]; }));
        if (!spare.length) continue;
        var add = spare[Math.floor(rnd() * spare.length)];
        var ins = tryInsertBest(trial, add, ctx, true);
        if (!ins) continue;
        trial = ins.order;
      }

      if (!validOrder(trial)) continue;
      var obj = PP.objective(PP.simulate(trial, ctx));
      if (obj > bestObj + 1e-9) { bestObj = obj; bestOrder = trial; }
    }

    return bestOrder;
  };

  // No duplicate rides, and never two showtimes of the same show.
  function validOrder(order) {
    var seen = {}, shows = {};
    for (var i = 0; i < order.length; i++) {
      var s = order[i];
      if (s.kind === 'break') continue;
      if (seen[s.id]) return false;
      seen[s.id] = true;
      if (s.kind === 'show') {
        if (shows[s.showId]) return false;
        shows[s.showId] = true;
      }
    }
    return true;
  }

  // Greedily put back whatever fits. Shows are eligible as well as rides —
  // otherwise ruin-and-recreate would only ever remove shows and never
  // restore them, and they would bleed out of the plan over many iterations.
  function refill(order, cand, ctx) {
    var usedIds = {}, usedShows = {};
    order.forEach(function (s) {
      usedIds[s.id] = true;
      if (s.showId) usedShows[s.showId] = true;
    });

    var pool = cand.rides.filter(function (s) { return !usedIds[s.id]; })
      .concat(cand.shows.filter(function (s) { return !usedShows[s.showId]; }));

    var guard = 0;
    while (pool.length && guard++ < 60) {
      var baseSim = PP.simulate(order, ctx);
      var baseEnd = baseSim.ok ? baseSim.endTime : ctx.startTime;
      var pick = null;
      for (var i = 0; i < pool.length; i++) {
        var r = tryInsertBest(order, pool[i], ctx, true);
        if (!r) continue;
        var d = pool[i].value / Math.max(1, r.sim.endTime - baseEnd);
        if (!pick || d > pick.d) pick = { i: i, r: r, d: d };
      }
      if (!pick) break;

      var chosen = pool[pick.i];
      order = pick.r.order;
      if (chosen.showId) {
        // Taking one showtime rules out that show's other showtimes.
        pool = pool.filter(function (s) { return s.showId !== chosen.showId; });
      } else {
        pool.splice(pick.i, 1);
      }
    }
    return order;
  }

  /* ---------- polish -------------------------------------------------------
     Local search is random, so it can leave an obvious few minutes on the
     table. This pass is exhaustive but cheap: try every eatery for every
     meal, and try moving every stop to its single best position, until
     nothing improves. It bounds the worst case of the random phase.
     --------------------------------------------------------------------- */

  PP.polish = function (order, ctx) {
    var best = order.slice();
    var bestObj = PP.objective(PP.simulate(best, ctx));
    var improved = true, rounds = 0;

    while (improved && rounds++ < 4) {
      improved = false;

      // Every eatery, for every meal.
      for (var i = 0; i < best.length; i++) {
        var spec = best[i];
        if (spec.kind !== 'food') continue;
        var without = best.filter(function (s) { return s !== spec; });
        for (var f = 0; f < ctx.park.food.length; f++) {
          var alt = mealSpec(ctx.park.food[f], spec.label, spec.window, spec.durationMin);
          var r = tryInsertBest(without, alt, ctx, true);
          if (r && r.obj > bestObj + 1e-9) {
            best = r.order; bestObj = r.obj; improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) continue;

      // Every stop, to its best position (or-opt).
      for (var j = 0; j < best.length; j++) {
        var moving = best[j];
        var rest = best.slice();
        rest.splice(j, 1);
        var r2 = tryInsertBest(rest, moving, ctx, true);
        if (r2 && r2.obj > bestObj + 1e-9) {
          best = r2.order; bestObj = r2.obj; improved = true;
          break;
        }
      }
    }
    return best;
  };

  /* ---------- explanations ------------------------------------------------
     Short, honest annotations derived from the numbers we already computed —
     no hand-waving, each one is checkable against the model.
     --------------------------------------------------------------------- */

  function explain(stop, sim, idx, ctx) {
    var out = [];
    var spec = stop.spec, item = stop.item;

    if (spec.kind === 'show') {
      var buf = Math.round(stop.start - stop.arrive);
      out.push('Seated ' + buf + ' min before it starts' +
        (item.capacityRisk === 'high' ? ' — this one fills up' : ''));
      var alts = (item.times || []).filter(function (t) { return t !== spec.startAt; });
      if (alts.length) {
        out.push('Chosen over the ' +
          alts.map(PP.fmtTime).join(' / ') + ' showing to fit the route');
      }
    } else if (spec.kind === 'food') {
      out.push(spec.label + ' — nearest option to where you already are');
    } else if (spec.kind === 'break') {
      out.push('Scheduled breather');
    } else {
      var live = ctx.live && ctx.live[item.id];
      if (live && live.open) {
        var gap = Math.abs(stop.arrive - live.at);
        out.push('Live queue was ' + live.wait + ' min at ' + PP.fmtTime(live.at) +
          (gap > 45
            ? ', blended back towards the usual pattern for ' + PP.fmtTime(stop.arrive)
            : ''));
      } else if (item.typicalWaitMin) {
        var mult = PP.crowdMultiplier(ctx.park, stop.arrive) * ctx.crowdFactor;
        var pct = Math.round(mult * 100);
        if (ctx.liveCalibration != null) {
          out.push('No live figure for this one; estimated from the ' +
            Math.round(ctx.liveCalibration * 100) + '% park-wide reading');
        } else if (mult < 0.85) {
          out.push('Queue here runs about ' + pct + '% of its typical length at this hour');
        } else if (mult > 1.2) {
          out.push('Peak-hours queue (' + pct + '% of typical) — no quieter slot fits');
        }
      }
    }

    if (stop.travelMin >= 6) {
      out.push(Math.round(stop.distMeters) + ' m walk (~' + Math.round(stop.travelMin) + ' min)');
    }
    if (spec.mandatory === false && ctx.prefs.mustSee.indexOf(item.id) >= 0) {
      out.unshift('On your must-see list');
    }
    return out;
  }

  /* ---------- public entry points ----------------------------------------- */

  PP.plan = function (state, opts) {
    opts = opts || {};
    var ctx = PP.buildContext(state, opts.ctx);
    var order = PP.construct(ctx);
    order = PP.improve(order, ctx, opts.iterations);
    order = PP.polish(order, ctx);
    return PP.describe(order, ctx);
  };

  PP.describe = function (order, ctx) {
    var sim = PP.simulate(order, ctx);
    if (!sim.ok) {
      return { ok: false, reason: sim.reason, order: order, stops: [], ctx: ctx };
    }

    sim.stops.forEach(function (stop, i) {
      stop.why = explain(stop, sim, i, ctx);
    });

    // What we had to leave out, and why it is worth knowing.
    var scheduled = {};
    order.forEach(function (s) { scheduled[s.id] = true; if (s.showId) scheduled[s.showId] = true; });
    var missed = [];
    PP.allItems(ctx.park).forEach(function (item) {
      if (item.kind === 'food') return;
      if (scheduled[item.id] || ctx.done.has(item.id) || ctx.skipped.has(item.id)) return;
      var v = PP.scoreItem(item, ctx);
      missed.push({
        item: item,
        value: v,
        reason: v === 0 ? 'ruled out by your answers' : 'no room in the day'
      });
    });
    missed.sort(function (a, b) { return b.value - a.value; });

    return {
      ok: true,
      ctx: ctx,
      order: order,
      stops: sim.stops,
      value: sim.value,
      walkMeters: sim.walkMeters,
      walkKm: sim.walkMeters / 1000,
      queuedMin: sim.queuedMin,
      idleMin: sim.idleMin,
      endTime: sim.endTime,
      exitAt: sim.exitAt,
      counts: {
        rides: sim.stops.filter(function (s) { return s.spec.kind === 'ride'; }).length,
        shows: sim.stops.filter(function (s) { return s.spec.kind === 'show'; }).length
      },
      warnings: ctx.warnings.slice(),
      missed: missed
    };
  };

  /* Re-plan mid-day: keep what has happened, re-optimise what is left. */
  PP.replan = function (state, live) {
    live = live || {};
    // Never start the remaining day before the gates open — re-planning at
    // 7am would otherwise invent two hours of park time that do not exist.
    var from = live.now != null ? live.now : nowMinutes();
    var ctx = PP.buildContext(state, {
      startTime: Math.max(from, state.park.openTime, state.prefs.arrive),
      startPos: live.position || state.park.entrance
    });
    if (ctx.startTime >= ctx.endTime) {
      return { ok: false, reason: 'day-over', ctx: ctx, stops: [] };
    }
    var order = PP.construct(ctx);
    order = PP.improve(order, ctx, live.iterations);
    order = PP.polish(order, ctx);
    return PP.describe(order, ctx);
  };

  PP.nowMinutes = nowMinutes;
  function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

})(window.PP || (window.PP = {}));
