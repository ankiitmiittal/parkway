/* ==========================================================================
   questions.js — the adaptive interview.

   Two kinds of question:
     stage 'setup'  — always asked, in order (who's going, when, how busy)
     stage 'refine' — ranked by VALUE OF INFORMATION before each round

   Value of information: for each unanswered question we build the plan under
   every possible answer and measure how much the resulting day differs. A
   question whose answers all produce the same itinerary is worthless and
   never gets asked; a question that swings half the day goes to the top.
   That is what makes the interview feel like it is actually listening.
   ========================================================================== */
(function (PP) {
  'use strict';

  /* ---------- helpers ----------------------------------------------------- */

  // Clone only what an answer can mutate. The park (with its base64 map photo)
  // is shared by reference — cloning it per simulation would be very slow.
  function variant(state, apply) {
    var s = {
      park: state.park,
      party: JSON.parse(JSON.stringify(state.party)),
      prefs: JSON.parse(JSON.stringify(state.prefs)),
      progress: state.progress,
      answered: state.answered
    };
    if (apply) apply(s);
    return s;
  }

  function setInterest(prefs, tag, w) { prefs.interests[tag] = w; }

  function toggle(list, v, on) {
    var i = list.indexOf(v);
    if (on && i < 0) list.push(v);
    if (!on && i >= 0) list.splice(i, 1);
  }

  /* ---------- question bank ----------------------------------------------- */

  PP.QUESTIONS = [

    /* ---- setup ---------------------------------------------------------- */
    {
      id: 'party', stage: 'setup', type: 'party',
      text: "Who's going today?",
      help: 'Heights matter — they decide which rides are even worth routing you to.'
    },
    {
      id: 'hours', stage: 'setup', type: 'hours',
      text: 'When do you arrive, and when do you need to leave?',
      help: 'Everything is built around this window.'
    },
    {
      id: 'crowd', stage: 'setup', type: 'single',
      text: 'How busy does the park look right now?',
      help: 'Scales every queue estimate up or down.',
      options: [
        { value: 1, label: 'Empty',  hint: 'walk-on everywhere' },
        { value: 2, label: 'Quiet',  hint: 'short queues' },
        { value: 3, label: 'Normal', hint: 'a typical day' },
        { value: 4, label: 'Busy',   hint: 'noticeable queues' },
        { value: 5, label: 'Packed', hint: 'peak-season crowds' }
      ],
      apply: function (s, v) { s.prefs.crowdLevel = v; }
    },

    /* ---- refine --------------------------------------------------------- */
    {
      id: 'focus', stage: 'refine', type: 'single',
      text: "What's today mostly about?",
      help: 'Sets the baseline weighting before the finer questions.',
      options: [
        {
          value: 'thrill', label: 'Rides and thrills',
          apply: function (s) { setInterest(s.prefs, 'thrill', 2); setInterest(s.prefs, 'water', 1); }
        },
        {
          value: 'animals', label: 'Animals and exhibits',
          apply: function (s) { setInterest(s.prefs, 'animals', 2); setInterest(s.prefs, 'nature', 1); }
        },
        {
          value: 'shows', label: 'Shows and displays',
          apply: function (s) { setInterest(s.prefs, 'shows', 2); }
        },
        {
          value: 'kids', label: 'Keeping small kids happy',
          apply: function (s) {
            setInterest(s.prefs, 'kids', 2);
            setInterest(s.prefs, 'interactive', 1);
            setInterest(s.prefs, 'thrill', -1);
          }
        },
        {
          value: 'mix', label: 'A bit of everything',
          apply: function (s) { PP.INTERESTS.forEach(function (i) { setInterest(s.prefs, i.id, 0.5); }); }
        }
      ],
      apply: function (s, v, opt) { if (opt && opt.apply) opt.apply(s); }
    },
    {
      id: 'thrill', stage: 'refine', type: 'single',
      text: 'How much thrill is too much?',
      help: 'Anything above your limit is dropped from the route entirely.',
      when: function (s) { return s.park.attractions.some(function (a) { return a.thrill >= 3; }); },
      options: [
        { value: 1, label: 'Gentle only',      hint: 'carousels, walkthroughs' },
        { value: 3, label: 'Moderate',         hint: 'family coasters, water rides' },
        { value: 5, label: 'Anything you have', hint: 'the big stuff' }
      ],
      apply: function (s, v) { s.prefs.thrillTolerance = v; }
    },
    {
      id: 'avoid', stage: 'refine', type: 'multi',
      text: 'Anything to rule out?',
      help: 'Hard exclusions — these never appear in the route.',
      options: PP.AVOIDABLE.map(function (a) { return { value: a.id, label: a.label }; }),
      apply: function (s, values) {
        s.prefs.avoid = (values || []).slice();
      }
    },
    {
      id: 'mustSee', stage: 'refine', type: 'multi',
      text: 'Anything you refuse to miss?',
      help: 'Must-sees are scheduled first and the rest of the day bends around them.',
      dynamicOptions: function (s) {
        var items = s.park.shows.concat(
          s.park.attractions.filter(function (a) { return a.iconic; })
        );
        return items.map(function (i) {
          return {
            value: i.id,
            label: i.name,
            hint: i.kind === 'show' && i.times.length
              ? i.times.map(PP.fmtTime).join(' · ')
              : (i.typicalWaitMin ? '~' + i.typicalWaitMin + ' min queue' : '')
          };
        });
      },
      apply: function (s, values) { s.prefs.mustSee = (values || []).slice(); }
    },
    {
      id: 'pace', stage: 'refine', type: 'single',
      text: "What's your walking pace?",
      help: 'Changes travel times, which changes what fits.',
      options: [
        { value: 'slow',   label: 'Take it easy',  hint: 'small kids, or no rush' },
        { value: 'normal', label: 'Normal' },
        { value: 'fast',   label: 'Keep moving',   hint: 'we cover ground' }
      ],
      apply: function (s, v) { s.party.pace = v; }
    },
    {
      id: 'stroller', stage: 'refine', type: 'single',
      text: 'Pushing a stroller or wheelchair?',
      when: function (s) { return s.party.kids.length > 0; },
      options: [
        { value: true,  label: 'Yes' },
        { value: false, label: 'No' }
      ],
      apply: function (s, v) { s.party.stroller = !!v; }
    },
    {
      id: 'split', stage: 'refine', type: 'single',
      text: 'Happy to split up so the tall-enough ones can ride?',
      help: 'Otherwise height-restricted rides get dropped when a child is too short.',
      when: function (s) {
        if (!s.party.kids.length) return false;
        return s.park.attractions.some(function (a) {
          return a.minHeightCm > 0 && s.party.kids.some(function (k) {
            return k.heightCm != null && k.heightCm < a.minHeightCm;
          });
        });
      },
      options: [
        { value: true,  label: 'Yes, we can split' },
        { value: false, label: 'No, we stay together' }
      ],
      apply: function (s, v) { s.party.willSplit = !!v; }
    },
    {
      id: 'lunch', stage: 'refine', type: 'single',
      text: 'How are you handling lunch?',
      options: [
        { value: 'sit',  label: 'Proper sit-down',  hint: '40 min blocked out' },
        { value: 'quick', label: 'Something quick', hint: '20 min' },
        { value: 'none', label: 'Graze as we go',   hint: 'no stop scheduled' }
      ],
      apply: function (s, v) {
        s.prefs.lunch = v !== 'none';
        s.prefs.lunchQuick = v === 'quick';
      }
    },
    {
      id: 'breaks', stage: 'refine', type: 'single',
      text: 'Want downtime built in?',
      help: 'A scheduled sit-down stops the day turning into a forced march.',
      options: [
        { value: 0,   label: 'No, keep going' },
        { value: 180, label: 'A breather every 3 hours' },
        { value: 120, label: 'A breather every 2 hours' }
      ],
      apply: function (s, v) { s.prefs.breakEveryMin = v; }
    },
    {
      id: 'walkBudget', stage: 'refine', type: 'single',
      text: 'Cap how far you walk?',
      help: 'A tight cap trades a couple of attractions for much less ground covered.',
      options: [
        { value: 0,    label: 'No limit' },
        { value: 6000, label: 'About 6 km' },
        { value: 4000, label: 'About 4 km', hint: 'noticeably lighter day' }
      ],
      apply: function (s, v) { s.prefs.walkBudgetMeters = v; }
    },
    {
      id: 'interests', stage: 'refine', type: 'multi',
      text: 'Fine-tune what you care about',
      help: 'Optional — nudges the ranking without ruling anything out.',
      options: PP.INTERESTS.map(function (i) {
        return { value: i.id, label: i.emoji + ' ' + i.label };
      }),
      apply: function (s, values) {
        (values || []).forEach(function (t) { setInterest(s.prefs, t, 1.5); });
      }
    }
  ];

  PP.getQuestion = function (id) {
    return PP.QUESTIONS.filter(function (q) { return q.id === id; })[0] || null;
  };

  PP.questionOptions = function (q, state) {
    if (q.dynamicOptions) return q.dynamicOptions(state);
    return q.options || [];
  };

  /* ---------- applying answers -------------------------------------------- */

  PP.applyAnswer = function (state, qid, value) {
    var q = PP.getQuestion(qid);
    if (!q) return state;
    applyTo(q, state, value);
    state.answered[qid] = value;
    return state;
  };

  function applyTo(q, s, value) {
    if (!q.apply) return;
    if (q.type === 'single') {
      var opts = PP.questionOptions(q, s);
      var opt = opts.filter(function (o) { return o.value === value; })[0];
      q.apply(s, value, opt);
    } else {
      q.apply(s, value);
    }
  }

  /* ---------- value of information ---------------------------------------- */

  // The distinct plans a question could lead to. For multi-selects we sample
  // representative choices rather than the full power set.
  function probesFor(q, state) {
    var opts = PP.questionOptions(q, state);
    if (!opts.length) return [];
    if (q.type === 'single') {
      return opts.slice(0, 5).map(function (o) {
        return { label: o.label, value: o.value };
      });
    }
    // multi: nothing selected, then each option on its own
    var probes = [{ label: 'none', value: [] }];
    opts.slice(0, 4).forEach(function (o) {
      probes.push({ label: o.label, value: [o.value] });
    });
    return probes;
  }

  function planSignature(state) {
    // Construction only, no local search — fast and deterministic, and enough
    // to tell whether two answers lead to materially different days.
    var ctx = PP.buildContext(state);
    var order = PP.construct(ctx);
    var sim = PP.simulate(order, ctx);
    var ids = new Set();
    order.forEach(function (s) { ids.add(s.showId || s.id); });
    return { ids: ids, value: sim.ok ? sim.value : 0, ok: sim.ok };
  }

  function jaccardDistance(a, b) {
    if (!a.size && !b.size) return 0;
    var inter = 0;
    a.forEach(function (x) { if (b.has(x)) inter++; });
    var union = a.size + b.size - inter;
    return union ? 1 - inter / union : 0;
  }

  function divergence(sigs) {
    if (sigs.length < 2) return 0;
    var pairs = 0, total = 0, maxV = 0, minV = Infinity;
    for (var i = 0; i < sigs.length; i++) {
      maxV = Math.max(maxV, sigs[i].value);
      minV = Math.min(minV, sigs[i].value);
      for (var j = i + 1; j < sigs.length; j++) {
        total += jaccardDistance(sigs[i].ids, sigs[j].ids);
        pairs++;
      }
    }
    var shape = pairs ? total / pairs : 0;              // how different the sets are
    var spread = maxV > 0 ? (maxV - minV) / maxV : 0;   // how different the payoff is
    return 0.75 * shape + 0.25 * spread;
  }

  /* Rank the unanswered refine questions by how much they would change the
     day. Yields to the event loop between questions so the UI stays alive. */
  PP.rankQuestions = function (state, opts) {
    opts = opts || {};
    var limit = opts.limit || 3;

    var pending = PP.QUESTIONS.filter(function (q) {
      if (q.stage !== 'refine') return false;
      if (state.answered.hasOwnProperty(q.id)) return false;
      if (q.when && !q.when(state)) return false;
      return true;
    });

    // Each probe builds a whole plan, so cap the work on slower phones.
    if (opts.maxEvaluate) pending = pending.slice(0, opts.maxEvaluate);

    var i = 0, scored = [];

    // Every probe builds a whole itinerary, so evaluating the full bank costs
    // a couple of seconds on a phone. The bank is already in rough priority
    // order, so stop as soon as something clearly worth asking turns up.
    var goodEnough = opts.goodEnough == null ? 0.2 : opts.goodEnough;

    function finish(resolve) {
      scored.sort(function (a, b) { return b.divergence - a.divergence; });
      resolve(scored.filter(function (s) { return s.divergence > 0.02; }).slice(0, limit));
    }

    return new Promise(function (resolve) {
      function step() {
        if (i >= pending.length) return finish(resolve);

        var q = pending[i++];
        var probes = probesFor(q, state);
        var sigs = probes.map(function (p) {
          return planSignature(variant(state, function (s) { applyTo(q, s, p.value); }));
        });
        var d = divergence(sigs);
        scored.push({ q: q, divergence: d, probes: probes });

        if (d >= goodEnough && scored.length >= limit) return finish(resolve);
        setTimeout(step, 0);
      }
      step();
    });
  };

  /* Questions still worth asking, in the order to ask them. Setup questions
     come first and in fixed order; the rest are chosen adaptively. */
  PP.nextSetupQuestion = function (state) {
    return PP.QUESTIONS.filter(function (q) {
      return q.stage === 'setup' && !state.answered.hasOwnProperty(q.id) &&
             (!q.when || q.when(state));
    })[0] || null;
  };

  PP.remainingCount = function (state) {
    return PP.QUESTIONS.filter(function (q) {
      return !state.answered.hasOwnProperty(q.id) && (!q.when || q.when(state));
    }).length;
  };

  /* ---------- free-text steering ------------------------------------------
     Lets the user type "we're knackered, cut the walking" and have the plan
     change. Keyword matching, so it works with no API key; vision.js can
     upgrade this to a model call when a key is present.
     --------------------------------------------------------------------- */

  PP.STEER_RULES = [
    { re: /(tired|knacker|exhaust|feet|sore|slow down|take it easy)/i,
      label: 'Easier day — less walking, slower pace, a break added',
      apply: function (s) {
        s.party.pace = 'slow';
        s.prefs.walkBudgetMeters = Math.round((s.prefs.walkBudgetMeters || 6000) * 0.7);
        if (!s.prefs.breakEveryMin) s.prefs.breakEveryMin = 120;
      } },
    { re: /(more rides|pack it in|cram|maximis|maximiz|as much as possible|hustle)/i,
      label: 'Denser day — faster pace, walking cap lifted',
      apply: function (s) { s.party.pace = 'fast'; s.prefs.walkBudgetMeters = 0; s.prefs.breakEveryMin = 0; } },
    { re: /(skip|no more|enough) (the )?shows?/i,
      label: 'Shows dropped',
      apply: function (s) { s.prefs.interests.shows = -2; } },
    { re: /(more|only|just) shows?/i,
      label: 'Shows prioritised',
      apply: function (s) { s.prefs.interests.shows = 2; } },
    { re: /(no|skip|avoid|hate) (water|getting wet|soak)/i,
      label: 'Water rides ruled out',
      apply: function (s) { toggle(s.prefs.avoid, 'water', true); } },
    { re: /(no|skip|avoid) (coaster|thrill|scary)/i,
      label: 'Thrill rides ruled out',
      apply: function (s) { s.prefs.thrillTolerance = 2; } },
    { re: /(hungry|eat|lunch|food)/i,
      label: 'Meal stop added next',
      apply: function (s) {
        s.prefs.lunch = true;
        var now = PP.nowMinutes();
        s.prefs.lunchWindow = [now, Math.min(now + 120, s.prefs.depart)];
      } },
    { re: /(leave earlier|head home|finish early|wrap up)/i,
      label: 'Departure pulled forward an hour',
      apply: function (s) { s.prefs.depart = Math.max(s.prefs.arrive + 60, s.prefs.depart - 60); } },
    { re: /(stay later|stay longer|extra hour)/i,
      label: 'Departure pushed back an hour',
      apply: function (s) { s.prefs.depart = Math.min(s.park.closeTime, s.prefs.depart + 60); } },
    { re: /(rain|wet weather|storm|shelter|indoors?)/i,
      label: 'Indoor attractions prioritised',
      apply: function (s) { s.prefs.interests.indoor = 2; s.prefs.interests.water = -2; } },
    { re: /(hot|heat|boiling|shade|aircon|air.?condition)/i,
      label: 'Indoor and water options prioritised',
      apply: function (s) { s.prefs.interests.indoor = 1.5; s.prefs.interests.water = 1.5; } }
  ];

  PP.steer = function (state, text) {
    var applied = [];
    PP.STEER_RULES.forEach(function (r) {
      if (r.re.test(text)) { r.apply(state); applied.push(r.label); }
    });
    return applied;
  };

})(window.PP || (window.PP = {}));
