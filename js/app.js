/* ==========================================================================
   app.js — state, persistence and the controller. One delegated click
   handler plus a few input handlers drive everything.
   ========================================================================== */
(function (PP) {
  'use strict';

  var LS_STATE = 'parkway.state.v1';
  var state = null;

  /* ---------- state -------------------------------------------------------- */

  function blankState() {
    return {
      park: null,
      party: PP.newParty(),
      prefs: PP.newPrefs(),
      answered: {},
      progress: { done: [], skipped: [], observedWaits: {} },
      uploads: { map: [], board: [] },
      hints: { name: '', date: new Date().toISOString().slice(0, 10) },
      plan: null,
      screen: 'page',
      imageVerdicts: null,
      currentQuestion: null,
      currentDuel: null,
      planDuel: null,
      duels: PP.duels.blank(),
      waitsUI: { query: '', suggestions: [], searched: false, matchReport: null },
      stepCount: 0,
      questionRank: null,
      parseNotes: null,
      steerLog: null,
      testResult: null,
      clockOverride: null,
      busy: false
    };
  }

  function save() {
    if (!state) return;
    var slim = {
      version: 1,
      park: state.park,
      party: state.party,
      prefs: state.prefs,
      answered: state.answered,
      progress: state.progress,
      hints: state.hints,
      duels: state.duels,
      screen: state.screen
    };
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(slim));
    } catch (e) {
      // Almost certainly the base64 map photo blowing the ~5 MB quota.
      try {
        var noImg = JSON.parse(JSON.stringify(slim));
        if (noImg.park) noImg.park.mapImage = null;
        localStorage.setItem(LS_STATE, JSON.stringify(noImg));
        PP.ui.toast('Saved, but the map photo was too big to keep offline.', 'warn');
      } catch (e2) {
        PP.ui.toast('Could not save to this device.', 'warn');
      }
    }
  }

  function load() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) { raw = null; }
    var s = blankState();
    if (raw && raw.park) {
      try {
        var restored = PP.importState(JSON.stringify(raw));
        s.park = restored.park;
        s.party = restored.party;
        s.prefs = restored.prefs;
        s.answered = restored.answered;
        s.progress = restored.progress;
        s.hints = raw.hints || s.hints;
        s.duels = raw.duels && raw.duels.w ? raw.duels : PP.duels.blank();
        s.screen = 'page';   // one page; Settings is never restored into


      } catch (e) { /* fall back to a blank slate */ }
    }
    return s;
  }

  /* ---------- planning ------------------------------------------------------ */

  function rebuild(iterations) {
    if (!state.park) return;
    try {
      state.plan = PP.plan(state, { iterations: iterations });
    } catch (e) {
      state.plan = { ok: false, reason: 'error', stops: [] };
      PP.ui.toast('Planner error: ' + e.message, 'warn');
    }
  }

  function render() { PP.ui.render(state); }

  function refresh(iterations) {
    rebuild(iterations);
    save();
    render();
  }

  /* ---------- interview flow ------------------------------------------------ */

  function showDuel() {
    var pair = PP.duels.pick(state);
    if (!pair) return false;
    state.currentQuestion = null;
    state.questionRank = null;
    state.currentDuel = pair;
    render();
    return true;
  }

  /* Decide what to put in front of the visitor next: a setup question, an
     A/B comparison, or the highest-information question left. Alternating
     questions and comparisons keeps the interview from feeling like a form,
     and the two learn different things — questions capture hard constraints,
     comparisons capture taste. */
  function advanceQuestion() {
    state.currentDuel = null;

    var setupQ = PP.nextSetupQuestion(state);
    if (setupQ) {
      state.currentQuestion = setupQ;
      state.questionRank = null;
      render();
      return;
    }

    state.stepCount = (state.stepCount || 0) + 1;
    if (state.stepCount % 2 === 0 && PP.duels.shouldAsk(state) && showDuel()) return;

    // Otherwise ask whichever question would change the day most.
    state.currentQuestion = null;
    state.questionRank = null;
    state.busy = true;
    render();
    showThinking('Working out what to ask next…');

    PP.rankQuestions(state, { limit: 1, maxEvaluate: 8 }).then(function (ranked) {
      state.busy = false;
      hideThinking();
      if (ranked.length) {
        state.currentQuestion = ranked[0].q;
        state.questionRank = ranked[0];
        render();
      } else if (!showDuel()) {
        render();          // genuinely nothing left worth asking
      }
    }).catch(function (e) {
      state.busy = false;
      hideThinking();
      PP.ui.toast('Could not rank questions: ' + e.message, 'warn');
      render();
    });
  }

  function showThinking(msg) {
    var n = document.getElementById('thinking');
    if (!n) return;
    n.querySelector('span').textContent = msg;
    n.hidden = false;
  }
  function hideThinking() {
    var n = document.getElementById('thinking');
    if (n) n.hidden = true;
  }

  /* ---------- actions -------------------------------------------------------- */

  var actions = {

    /* navigation */
    /* On one page these reveal a section rather than navigate. Settings is the
       exception — a genuine detour, not part of the flow. */
    'screen:settings':  function () { state.testResult = null; go('settings'); },
    'screen:setup':     function () { backToPage(); window.scrollTo(0, 0); },
    'screen:plan':      function () { if (!state.plan) refresh(); reveal('the-plan'); },
    'screen:review':    function () { reveal('review'); },
    'screen:map':       function () { reveal('map'); },
    'screen:live':      function () { reveal('live'); },
    'screen:waits':     function () { reveal('waits'); },
    'screen:compare':   function () { reveal('refine'); },

    /* The one button on the page. Always does the sensible next thing. */
    'day:plan': function () {
      if (state.busy) return;

      if (!state.park) {
        if (!PP.vision.configured()) {
          PP.ui.toast('Add an API key first.', 'warn');
          go('settings');
          return;
        }
        if (!state.uploads.map.length) {
          PP.ui.toast('Add your park map first.', 'warn');
          return;
        }
        actions['park:parse']();      // parses, then plans, then scrolls
        return;
      }

      rebuild(600);
      save();
      PP.ui._scrollToPlan = true;
      render();
    },

    /* A/B comparisons ---------------------------------------------------- */

    'duel:pick': function (el) {
      var d = state.currentDuel;
      if (!d) return;
      var winnerId = el.dataset.winner;
      var loserId = d.a.id === winnerId ? d.b.id : d.a.id;
      PP.duels.record(state, winnerId, loserId);
      PP.duels.commit(state);
      state.currentDuel = null;
      rebuild(200);
      save();
      advanceQuestion();
    },

    'duel:tie': function () {
      var d = state.currentDuel;
      if (!d) return;
      PP.duels.recordTie(state, d.a.id, d.b.id);
      PP.duels.commit(state);
      state.currentDuel = null;
      rebuild(200);
      save();
      advanceQuestion();
    },

    'duel:skip': function () {
      var d = state.currentDuel;
      if (d) PP.duels.ensure(state).asked[d.key] = true;
      state.currentDuel = null;
      advanceQuestion();
    },

    /* whole-day comparisons ----------------------------------------------- */

    'compare:build': function () {
      showThinking('Building two different days…');
      setTimeout(function () {
        try {
          var pd = PP.duels.planPair(state, { exclude: state.lastAxes || [] });
          hideThinking();
          if (!pd) {
            // Second try without the exclusion, in case that was the problem.
            pd = PP.duels.planPair(state, {});
          }
          if (!pd) {
            PP.ui.toast('Every option produces much the same day right now.', 'warn');
            return;
          }
          state.planDuel = pd;
          state.lastAxes = [pd.a.axis.id, pd.b.axis.id];
          reveal('refine');
        } catch (e) {
          hideThinking();
          PP.ui.toast('Could not build the comparison: ' + e.message, 'warn');
        }
      }, 20);
    },

    'compare:choose': function (el) {
      var axis = PP.duels.adoptAxis(state, el.dataset.axis);
      state.planDuel = null;
      rebuild(600);
      save();
      PP.ui._scrollToPlan = true; render();
      PP.ui.toast(axis ? 'Applied: ' + axis.label.toLowerCase() + '.' : 'Applied.');
    },

    /* live queue times ----------------------------------------------------- */

    'waits:search': function () {
      var box = document.getElementById('waits-q');
      var q = box ? box.value.trim() : '';
      state.waitsUI.query = q;
      if (!q) { PP.ui.toast('Type a park name first.', 'warn'); return; }
      showThinking('Looking up parks…');
      PP.waits.listParks()
        .then(function (parks) {
          hideThinking();
          state.waitsUI.suggestions = PP.waits.suggestParks(parks, q);
          state.waitsUI.searched = true;
          render();
        })
        .catch(function (e) { hideThinking(); PP.ui.toast(e.message, 'warn'); });
    },

    'waits:connect': function (el) {
      syncWaits(+el.dataset.pid, el.dataset.pname);
    },

    'waits:refresh': function () {
      var src = state.park.waitSource;
      if (!src) { reveal('waits'); return; }
      if (src.provider === 'web') { webWaits(); return; }
      syncWaits(src.parkId, src.parkName);
    },

    'waits:disconnect': function () {
      PP.waits.clear(state.park);
      state.waitsUI.matchReport = null;
      refresh(400);
      PP.ui.toast('Back to modelled queue estimates.');
    },

    'waits:web': function () { webWaits(); },
    'screen:interview': function () {
      reveal('refine');
      if (!state.currentQuestion && !state.currentDuel) advanceQuestion();
    },

    /* park sources */
    'park:sample': function () {
      state.park = PP.samplePark();
      state.prefs.arrive = PP.clamp(state.prefs.arrive,
                                    state.park.openTime, state.park.closeTime);
      state.prefs.depart = PP.clamp(state.prefs.depart,
                                    state.prefs.arrive + 30, state.park.closeTime);
      state.answered = {};
      state.progress = { done: [], skipped: [], observedWaits: {} };
      rebuild(600);
      save();
      backToPage();
      PP.ui._scrollToPlan = true;
      render();
      PP.ui.toast('Sample park loaded.');
    },

    'park:blank': function () {
      state.park = PP.newPark({ name: state.hints.name || 'My park' });
      state.park.food.push({
        id: PP.uid('f'), name: 'Food court', kind: 'food',
        x: 0.5, y: 0.8, zone: '', durationMin: 40, typicalWaitMin: 10, tags: ['food']
      });
      backToPage();
      reveal('review');
    },

    'park:parse': function () {
      if (state.busy) return;
      state.busy = true;
      state.parseNotes = null;
      render();
      showThinking('Reading your photos…');

      PP.vision.parsePark(state.uploads.map, state.uploads.board, state.hints)
        .then(function (res) {
          state.park = res.park;
          state.parseNotes = res.notes;
          state.imageVerdicts = res.gated || null;
          // Keep the times they typed above the button; only pull them inside
          // the park's actual opening hours.
          state.prefs.arrive = PP.clamp(state.prefs.arrive,
                                        res.park.openTime, res.park.closeTime);
          state.prefs.depart = PP.clamp(state.prefs.depart,
                                        state.prefs.arrive + 30, res.park.closeTime);
          state.answered = {};
          state.progress = { done: [], skipped: [], observedWaits: {} };
          state.busy = false;
          hideThinking();
          rebuild(600);                 // straight to a plan, no second tap
          save();
          PP.ui._scrollToPlan = true;
          render();
          PP.ui.toast('Read ' + res.park.attractions.length + ' attractions and ' +
            res.park.shows.length + ' shows.');
          tryAutoConnectWaits();
        })
        .catch(function (e) {
          state.busy = false;
          hideThinking();
          render();
          PP.ui.toast(e.message, 'warn');
        });
    },

    'park:export': function () {
      var json = PP.exportState(state);
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.park ? state.park.name.replace(/[^\w-]+/g, '-') : 'park') + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    },

    'upload:remove': function (el) {
      var bucket = el.dataset.bucket, i = +el.dataset.index;
      state.uploads[bucket].splice(i, 1);
      render();
    },

    /* review editing */
    'item:add:attraction': function () {
      state.park.attractions.push({
        id: PP.uid('a'), name: 'New attraction', kind: 'ride', x: 0.5, y: 0.5,
        zone: '', durationMin: 10, typicalWaitMin: 20, thrill: 0, minHeightCm: 0,
        tags: [], iconic: false
      });
      render();
    },
    'item:add:show': function () {
      state.park.shows.push({
        id: PP.uid('s'), name: 'New show', kind: 'show', x: 0.5, y: 0.5, zone: '',
        durationMin: 20, times: [12 * 60], arriveEarlyMin: 10,
        capacityRisk: 'medium', tags: ['shows'], iconic: false
      });
      render();
    },
    'item:delete': function (el) {
      var id = el.dataset.id;
      ['attractions', 'shows', 'food'].forEach(function (k) {
        state.park[k] = state.park[k].filter(function (i) { return i.id !== id; });
      });
      save();
      render();
    },

    /* interview */
    'answer:single': function (el) {
      var qid = el.dataset.q;
      var value = JSON.parse(el.dataset.value);
      PP.applyAnswer(state, qid, value);
      rebuild(200);
      save();
      advanceQuestion();
    },

    'answer:toggle': function (el) {
      var qid = el.dataset.q;
      var value = JSON.parse(el.dataset.value);
      var cur = Array.isArray(state.answered[qid]) ? state.answered[qid].slice() : [];
      var i = cur.indexOf(value);
      if (i >= 0) cur.splice(i, 1); else cur.push(value);
      state.answered[qid] = cur;                 // record without applying yet
      render();
    },

    'answer:commit': function (el) {
      var qid = el.dataset.q;
      PP.applyAnswer(state, qid, state.answered[qid] || []);
      rebuild(200);
      save();
      advanceQuestion();
    },

    'answer:party': function () {
      state.answered.party = true;
      rebuild(200);
      save();
      advanceQuestion();
    },

    'answer:hours': function () {
      state.answered.hours = true;
      rebuild(200);
      save();
      advanceQuestion();
    },

    'kid:add': function () {
      state.party.kids.push({ age: 6, heightCm: 115 });
      render();
    },
    'kid:remove': function (el) {
      state.party.kids.splice(+el.dataset.index, 1);
      render();
    },

    'interview:reset': function () {
      state.answered = {};
      state.prefs = PP.newPrefs({ arrive: state.prefs.arrive, depart: state.prefs.depart });
      state.currentQuestion = null;
      advanceQuestion();
    },

    /* plan */
    'plan:build':   function () { refresh(); },
    'plan:rebuild': function () {
      showThinking('Re-optimising…');
      setTimeout(function () { hideThinking(); refresh(800); PP.ui.toast('Plan rebuilt.'); }, 10);
    },
    'mustsee:add': function (el) {
      var id = el.dataset.id;
      if (state.prefs.mustSee.indexOf(id) < 0) state.prefs.mustSee.push(id);
      refresh(600);
      PP.ui.toast('Rebuilt around that one.');
    },

    /* live */
    'live:done': function (el) {
      var id = el.dataset.id;
      if (id && state.progress.done.indexOf(id) < 0) state.progress.done.push(id);
      replanNow();
    },
    'live:skip': function (el) {
      var id = el.dataset.id;
      if (id && state.progress.skipped.indexOf(id) < 0) state.progress.skipped.push(id);
      replanNow();
    },
    'live:observe': function (el) {
      var input = document.getElementById('obs-wait');
      var v = input && input.value !== '' ? +input.value : null;
      if (v == null || isNaN(v)) { PP.ui.toast('Enter the queue length first.', 'warn'); return; }
      state.progress.observedWaits[el.dataset.id] = v;
      PP.ui.toast('Noted — similar queues nearby adjusted too.');
      replanNow();
    },
    'live:late': function () {
      state.clockOverride = (state.clockOverride != null ? state.clockOverride : PP.nowMinutes()) + 20;
      replanNow();
      PP.ui.toast('Shifted 20 minutes later.');
    },
    'live:replan': function () { replanNow(); PP.ui.toast('Re-optimised from here.'); },

    'live:steer': function () {
      var box = document.getElementById('steer-text');
      var text = box ? box.value.trim() : '';
      if (!text) { PP.ui.toast('Say what changed first.', 'warn'); return; }

      if (!PP.vision.configured()) {
        state.steerLog = PP.steer(state, text);
        if (!state.steerLog.length) {
          PP.ui.toast('Did not understand that. Add an API key for free-text steering.', 'warn');
          return;
        }
        replanNow();
        return;
      }

      showThinking('Working out what that means…');
      PP.vision.interpret(state, text)
        .then(function (patch) {
          hideThinking();
          var changes = PP.vision.applyPatch(state, patch);
          state.steerLog = changes.length ? changes : [patch.summary || 'no change needed'];
          replanNow();
        })
        .catch(function (e) {
          hideThinking();
          // Fall back to the offline keyword rules.
          state.steerLog = PP.steer(state, text);
          if (state.steerLog.length) { replanNow(); }
          else PP.ui.toast(e.message, 'warn');
        });
    },

    /* settings */
    'settings:save': function () {
      PP.vision.saveSettings({});
      PP.ui.toast('Saved.');
      render();
    },
    'settings:test': function () {
      state.testResult = null;
      showThinking('Testing…');
      PP.vision.test()
        .then(function (txt) {
          hideThinking();
          state.testResult = { ok: true, msg: 'Connected. The model replied: "' + txt + '"' };
          render();
        })
        .catch(function (e) {
          hideThinking();
          state.testResult = { ok: false, msg: e.message };
          render();
        });
    },

    'state:reset': function () {
      if (!confirm('Clear the park, your answers and the plan from this device?')) return;
      localStorage.removeItem(LS_STATE);
      state = blankState();
      render();
    }
  };

  function go(screen) {
    state.screen = screen;
    PP.ui._resetScroll = true;
    save();
    render();
  }

  // Come back from Settings to the single page.
  function backToPage() {
    if (state.screen === 'settings') { state.screen = 'page'; save(); render(); }
  }

  /* Reveal a section of the one page. If we are in Settings, come back first
     and let the re-render finish before scrolling to it. */
  function reveal(id) {
    if (state.screen === 'settings') {
      backToPage();
      setTimeout(function () { PP.ui.revealPanel(id); }, 50);
      return;
    }
    PP.ui.revealPanel(id);
  }

  /* Try to hook up live queue times without being asked. Only commits on a
     confident park-name match AND a decent ride-match rate — auto-connecting
     the wrong park would be worse than connecting nothing, so it backs out
     silently rather than leaving bad numbers in the plan. */
  /* If the person hosting this dropped a park.json next to index.html, load it
     so recipients never see the setup screen or need an API key. Only the PARK
     is taken — the host's party size, hours and answers are theirs, not the
     visitor's. Fails silently from file://, where fetch is blocked. */
  function tryBundledPark() {
    if (state.park) return;
    fetch('park.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('no bundled park'); return r.text(); })
      .then(function (txt) {
        if (state.park) return;                       // they picked one meanwhile
        var restored = PP.importState(txt);
        state.park = restored.park;
        state.prefs = PP.newPrefs({
          arrive: Math.max(restored.park.openTime, PP.nowMinutes()),
          depart: restored.park.closeTime
        });
        rebuild();
        save();
        reveal('refine');
        advanceQuestion();
        tryAutoConnectWaits();
      })
      .catch(function () {
        /* No bundled park. The normal setup screen is already showing. */
      });
  }

  function tryAutoConnectWaits() {
    if (!state.park || state.park.waitSource) return;
    var parkName = state.park.name;

    PP.waits.listParks().then(function (parks) {
      var top = PP.waits.suggestParks(parks, parkName)[0];
      if (!top || top.score < 0.85) return;

      return PP.waits.sync(state, top.park.id, top.park.name).then(function (res) {
        var rate = res.applied / Math.max(1, state.park.attractions.length);
        if (rate < 0.25) {
          PP.waits.clear(state.park);       // name matched, rides did not
          return;
        }
        state.waitsUI.matchReport = res.match;
        rebuild(400);
        save();
        render();
        PP.ui.toast('Live queue times connected automatically — ' +
          res.applied + ' attractions.');
      });
    }).catch(function () {
      /* Offline, or the provider is down. This is a bonus, not a requirement. */
    });
  }

  function syncWaits(parkId, parkName) {
    showThinking('Fetching live queue times…');
    PP.waits.sync(state, parkId, parkName)
      .then(function (res) {
        hideThinking();
        state.waitsUI.matchReport = res.match;
        rebuild(500);
        save();
        render();
        var missing = res.match.unmatched.length;
        var rate = res.applied / Math.max(1, state.park.attractions.length);
        PP.ui.toast(rate < 0.25
          ? 'Only ' + res.applied + ' of ' + state.park.attractions.length +
            ' matched — is this the right park?'
          : 'Live times for ' + res.applied + ' attraction' +
            (res.applied === 1 ? '' : 's') +
            (missing ? '; ' + missing + ' had no match' : '') + '.',
          rate < 0.25 ? 'warn' : '');
      })
      .catch(function (e) { hideThinking(); PP.ui.toast(e.message, 'warn'); });
  }

  function webWaits() {
    showThinking('Searching the web for live waits…');
    PP.waits.viaClaude(state)
      .then(function (res) {
        hideThinking();
        state.waitsUI.matchReport = res.match;
        rebuild(500);
        save();
        render();
        PP.ui.toast('Found live times for ' + res.applied + ' attractions.');
      })
      .catch(function (e) { hideThinking(); PP.ui.toast(e.message, 'warn'); });
  }

  function replanNow() {
    try {
      state.plan = PP.replan(state, {
        now: state.clockOverride != null ? state.clockOverride : PP.nowMinutes(),
        iterations: 500
      });
    } catch (e) {
      PP.ui.toast('Re-plan failed: ' + e.message, 'warn');
    }
    save();
    render();
  }

  /* ---------- input handling -------------------------------------------------- */

  function onInput(e) {
    var el = e.target;
    if (!el.matches('input, select, textarea')) return;
    var d = el.dataset;

    if (d.hint) { state.hints[d.hint] = el.value; return; }

    if (d.park) {
      var v = d.park === 'spanMeters' ? Math.max(50, +el.value) : PP.parseTime(el.value);
      if (v != null && !isNaN(v)) { state.park[d.park] = v; save(); }
      return;
    }

    if (d.pref) {
      var t = PP.parseTime(el.value);
      if (t != null) { state.prefs[d.pref] = t; save(); }
      return;
    }

    if (d.party) { state.party[d.party] = Math.max(0, +el.value || 0); save(); return; }

    if (d.kid != null && d.field) {
      var kid = state.party.kids[+d.kid];
      if (kid) { kid[d.field] = el.value === '' ? null : +el.value; save(); }
      return;
    }

    if (d.edit && d.field) {
      var item = PP.findItem(state.park, d.edit);
      if (!item) return;
      if (d.field === 'name') item.name = el.value;
      else if (d.field === 'times') {
        item.times = el.value.split(',').map(function (s) { return PP.parseTime(s.trim()); })
          .filter(function (t) { return t != null; }).sort(function (a, b) { return a - b; });
      } else item[d.field] = +el.value || 0;
      save();
      return;
    }

    if (d.setting) {
      var patch = {};
      patch[d.setting] = d.setting === 'apiKey' ? el.value.trim() : el.value;
      PP.vision.saveSettings(patch);
      if (d.setting === 'transport') render();
      return;
    }
  }

  /* ---------- file inputs ------------------------------------------------------ */

  function wireFiles() {
    document.addEventListener('change', function (e) {
      var el = e.target;

      if (el.id === 'file-map' || el.id === 'file-board') {
        var bucket = el.id === 'file-map' ? 'map' : 'board';
        var files = Array.prototype.slice.call(el.files || []);
        if (!files.length) return;
        showThinking('Preparing files…');
        // Settle rather than all: one unreadable file should not throw away
        // the others the visitor picked at the same time.
        Promise.all(files.map(function (f) {
          return PP.vision.readFile(f).then(
            function (ok) { return { ok: ok }; },
            function (err) { return { err: err.message }; }
          );
        })).then(function (results) {
          hideThinking();
          var good = results.filter(function (r) { return r.ok; }).map(function (r) { return r.ok; });
          var bad = results.filter(function (r) { return r.err; });
          state.uploads[bucket] = state.uploads[bucket].concat(good).slice(0, 4);
          render();
          if (bad.length) PP.ui.toast(bad[0].err, 'warn');
        });
        el.value = '';
        return;
      }

      if (el.id === 'file-json') {
        var f = (el.files || [])[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var restored = PP.importState(String(reader.result));
            state.park = restored.park;
            state.party = restored.party;
            state.prefs = restored.prefs;
            state.answered = restored.answered;
            state.progress = restored.progress;
            rebuild();
            reveal('review');
            PP.ui.toast('Imported ' + state.park.name + '.');
            tryAutoConnectWaits();
          } catch (err) {
            PP.ui.toast('Could not read that file: ' + err.message, 'warn');
          }
        };
        reader.readAsText(f);
        el.value = '';
      }
    });
  }

  /* ---------- boot -------------------------------------------------------------- */

  function onClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    var fn = actions[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el);
  }

  function boot() {
    state = load();
    PP.state = state;                     // handy in the console
    if (state.park && !state.plan) rebuild();
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
    wireFiles();
    render();
    tryBundledPark();

    // Keep the Live screen honest as the clock moves.
    setInterval(function () {
      if (state.screen === 'live' && state.clockOverride == null) render();
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window.PP || (window.PP = {}));
