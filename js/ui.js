/* ==========================================================================
   ui.js — rendering. Every screen is a pure function of app state; actions
   are wired by data-action attributes and one delegated click handler, so
   there is no framework and nothing to build.
   ========================================================================== */
(function (PP) {
  'use strict';

  var UI = PP.ui = {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  UI.esc = esc;

  function attr(o) {
    return Object.keys(o).map(function (k) {
      return o[k] == null ? '' : k + '="' + esc(o[k]) + '"';
    }).join(' ');
  }

  /* ---------- shared bits -------------------------------------------------- */

  var KIND_ICON = {
    ride: '🎡', walk: '🚶', play: '🛝', exhibit: '🔍',
    show: '🎭', food: '🍽️', break: '🪑'
  };

  function icon(spec) {
    if (spec.kind === 'break') return KIND_ICON.break;
    if (spec.kind === 'food') return KIND_ICON.food;
    if (spec.kind === 'show') return KIND_ICON.show;
    return KIND_ICON[(spec.item && spec.item.kind) || 'ride'] || '🎡';
  }

  function chip(text, cls) {
    return '<span class="chip ' + (cls || '') + '">' + esc(text) + '</span>';
  }

  function btn(action, label, cls, extra) {
    return '<button type="button" class="btn ' + (cls || '') + '" data-action="' +
      esc(action) + '" ' + attr(extra || {}) + '>' + label + '</button>';
  }

  UI.toast = function (msg, kind) {
    var host = $('#toasts');
    if (!host) return;
    var node = document.createElement('div');
    node.className = 'toast ' + (kind || '');
    node.textContent = msg;
    host.appendChild(node);
    setTimeout(function () { node.classList.add('out'); }, 3600);
    setTimeout(function () { node.remove(); }, 4200);
  };

  /* ---------- top-level ---------------------------------------------------- */

  UI.render = function (state) {
    var root = $('#app');
    if (!root) return;
    var body;
    switch (state.screen) {
      case 'setup':     body = renderSetup(state); break;
      case 'review':    body = renderReview(state); break;
      case 'interview': body = renderInterview(state); break;
      case 'plan':      body = renderPlan(state); break;
      case 'map':       body = renderMap(state); break;
      case 'live':      body = renderLive(state); break;
      case 'compare':   body = renderCompare(state); break;
      case 'waits':     body = renderWaits(state); break;
      case 'settings':  body = renderSettings(state); break;
      default:          body = renderSetup(state);
    }
    root.innerHTML = header(state) + '<main class="screen">' + body + '</main>' + nav(state);
    if (state.screen === 'map') drawRoute(state);
    var scroll = root.querySelector('.screen');
    if (scroll && UI._resetScroll) { window.scrollTo(0, 0); UI._resetScroll = false; }
  };

  function header(state) {
    var p = state.park;
    return '<header class="top">' +
      '<div class="top-title">' +
        '<strong>' + esc(p && p.name ? p.name : 'Parkway') + '</strong>' +
        (p ? '<span class="top-sub">' + PP.fmtTime(state.prefs.arrive) + ' – ' +
             PP.fmtTime(state.prefs.depart) + '</span>' : '') +
      '</div>' +
      btn('screen:settings', '⚙️', 'icon-btn', { title: 'Settings' }) +
      '</header>';
  }

  function nav(state) {
    var hasPark = !!state.park;
    var items = [
      ['plan', '🗒️', 'Plan'],
      ['map', '🗺️', 'Map'],
      ['live', '📍', 'Live'],
      ['interview', '❓', 'Tune'],
      ['setup', '📷', 'Park']
    ];
    return '<nav class="tabs">' + items.map(function (it) {
      var disabled = !hasPark && it[0] !== 'setup';
      return '<button type="button" class="tab' + (state.screen === it[0] ? ' on' : '') + '"' +
        (disabled ? ' disabled' : '') + ' data-action="screen:' + it[0] + '">' +
        '<span class="tab-i">' + it[1] + '</span><span>' + it[2] + '</span></button>';
    }).join('') + '</nav>';
  }

  /* ---------- setup -------------------------------------------------------- */

  function renderSetup(state) {
    var u = state.uploads;
    var configured = PP.vision.configured();

    var thumbs = function (list, bucket) {
      if (!list.length) return '';
      return '<div class="thumbs">' + list.map(function (f, i) {
        // A PDF has no bitmap to preview, so show the filename instead.
        var inner = f.kind === 'pdf'
          ? '<span class="thumb-pdf"><b>PDF</b>' +
            (f.sizeBytes ? '<em>' + Math.max(1, Math.round(f.sizeBytes / 102400) / 10) + ' MB</em>' : '') +
            '</span>'
          : '<img src="' + f.dataUrl + '" alt="">';
        return '<div class="thumb" title="' + esc(f.name || '') + '">' + inner +
          '<button type="button" class="thumb-x" data-action="upload:remove" ' +
          'data-bucket="' + bucket + '" data-index="' + i + '">✕</button></div>';
      }).join('') + '</div>';
    };

    return [
      '<section class="card">',
        '<h1>Set up your park</h1>',
        '<p class="muted">Photograph the map and the showtimes board as you walk in. ',
        'Reading the photos needs a connection; the routing, the questions and ',
        're-planning all run on your phone afterwards.</p>',
      '</section>',

      '<section class="card">',
        '<h2>1 · Map &amp; showtimes</h2>',
        '<label class="drop" for="file-map">',
          '<span class="drop-i">🗺️</span>',
          '<span><strong>Park map</strong><br><span class="muted">Take a photo, choose one from your gallery, or pick a PDF. Required — sets the coordinates everything else is placed on.</span></span>',
        '</label>',
        '<input type="file" id="file-map" accept="image/*,application/pdf,.pdf" multiple hidden>',
        thumbs(u.map, 'map'),

        '<label class="drop" for="file-board">',
          '<span class="drop-i">🕐</span>',
          '<span><strong>Showtimes board</strong><br><span class="muted">Photo, gallery image or PDF. Optional, but this is what makes the timing work.</span></span>',
        '</label>',
        '<input type="file" id="file-board" accept="image/*,application/pdf,.pdf" multiple hidden>',
        thumbs(u.board, 'board'),

        '<div class="row gap">',
          '<label class="field"><span>Park name</span>',
            '<input type="text" data-hint="name" value="' + esc(state.hints.name || '') + '" placeholder="Optional"></label>',
          '<label class="field"><span>Date</span>',
            '<input type="date" data-hint="date" value="' + esc(state.hints.date || '') + '"></label>',
        '</div>',

        // Always put a button where the eye expects one. Hiding it when there
        // is no API key left people staring at an uploaded map wondering what
        // to press, so the unconfigured state is now a call to action rather
        // than a note that is easy to skim past.
        configured
          ? btn('park:parse', '✨ Read my map', 'primary block' + (state.busy ? ' busy' : ''),
              state.busy || !u.map.length ? { disabled: 'disabled' } : {})
          : btn('screen:settings', '🔑 Add a key to read this map', 'primary block'),
        configured ? ''
          : '<p class="muted small">Reading a map needs a Claude API key. It is stored in ' +
            'this browser only. Already have park data? Import it from Settings.</p>',
        state.parseNotes && state.parseNotes.length
          ? '<div class="note">The model flagged these:<ul>' +
            state.parseNotes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
            '</ul></div>'
          : '',
      '</section>',

      state.park ? '<section class="card">' +
        '<h2>Current park</h2>' +
        '<p>' + esc(state.park.name) + ' — ' + state.park.attractions.length + ' attractions, ' +
        state.park.shows.length + ' shows, ' + state.park.food.length + ' places to eat.</p>' +
        '<div class="stack">' +
          btn('screen:review', '📝 Review & correct the details', 'block') +
          btn('screen:waits', '🟢 Connect live queue times', 'block') +
          btn('park:export', '💾 Export this park as JSON', 'block') +
        '</div></section>' : ''
    ].join('');
  }

  /* ---------- review ------------------------------------------------------- */

  function renderReview(state) {
    var p = state.park;

    function numField(item, field, label, step) {
      return '<label class="mini"><span>' + label + '</span>' +
        '<input type="number" step="' + (step || 1) + '" value="' + esc(item[field]) +
        '" data-edit="' + item.id + '" data-field="' + field + '"></label>';
    }

    function itemRow(item) {
      var isShow = item.kind === 'show';
      return '<details class="item">' +
        '<summary><span class="i">' + icon({ kind: item.kind === 'food' ? 'food' : isShow ? 'show' : 'ride', item: item }) +
          '</span><span class="nm">' + esc(item.name) + '</span>' +
          (isShow && item.times.length
            ? '<span class="muted small">' + item.times.map(PP.fmtTime).join(' · ') + '</span>'
            : item.typicalWaitMin ? '<span class="muted small">~' + item.typicalWaitMin + ' min</span>' : '') +
        '</summary>' +
        '<div class="item-body">' +
          '<label class="mini wide"><span>Name</span><input type="text" value="' + esc(item.name) +
            '" data-edit="' + item.id + '" data-field="name"></label>' +
          numField(item, 'durationMin', 'Duration (min)') +
          (isShow
            ? '<label class="mini wide"><span>Times (24h, comma separated)</span>' +
              '<input type="text" value="' + esc(item.times.map(function (t) {
                var h = Math.floor(t / 60), m = t % 60;
                return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
              }).join(', ')) + '" data-edit="' + item.id + '" data-field="times"></label>' +
              numField(item, 'arriveEarlyMin', 'Be seated (min early)')
            : numField(item, 'typicalWaitMin', 'Typical queue (min)') +
              numField(item, 'minHeightCm', 'Min height (cm)') +
              numField(item, 'thrill', 'Thrill 0–5')) +
          '<label class="mini"><span>Map x</span><input type="number" step="0.01" value="' +
            item.x.toFixed(2) + '" data-edit="' + item.id + '" data-field="x"></label>' +
          '<label class="mini"><span>Map y</span><input type="number" step="0.01" value="' +
            item.y.toFixed(2) + '" data-edit="' + item.id + '" data-field="y"></label>' +
          '<button type="button" class="btn danger small" data-action="item:delete" data-id="' +
            item.id + '">Remove</button>' +
        '</div></details>';
    }

    return [
      imageVerdictCard(state),
      '<section class="card">',
        '<h1>Review what was read</h1>',
        '<p class="muted">Vision gets names right far more often than it gets queue times right. ',
        'Fix anything obviously wrong — the whole plan is built on these numbers.</p>',
        '<div class="row gap">',
          '<label class="field"><span>Opens</span><input type="time" data-park="openTime" value="' +
            hhmm(p.openTime) + '"></label>',
          '<label class="field"><span>Closes</span><input type="time" data-park="closeTime" value="' +
            hhmm(p.closeTime) + '"></label>',
          '<label class="field"><span>Park width (m)</span><input type="number" data-park="spanMeters" value="' +
            p.spanMeters + '"></label>',
        '</div>',
      '</section>',

      section('Shows (' + p.shows.length + ')', p.shows.map(itemRow).join('') ||
        '<p class="muted">None found. Shows are where the timing payoff is — add one if the board had any.</p>'),
      section('Attractions (' + p.attractions.length + ')', p.attractions.map(itemRow).join('') ||
        '<p class="muted">None yet.</p>'),
      section('Food (' + p.food.length + ')', p.food.map(itemRow).join('')),

      '<section class="card">',
        '<div class="stack">',
          btn('item:add:attraction', '➕ Add an attraction', 'block'),
          btn('item:add:show', '➕ Add a show', 'block'),
          btn('screen:interview', 'Looks right — continue →', 'primary block'),
        '</div>',
      '</section>'
    ].join('');
  }

  /* Whether each photo is a clean map document. Rejected photos were still
     used to plan this trip — the verdict only governs whether an image could
     ever be retained. Worth showing either way: it catches someone who
     photographed the wrong thing. */
  function imageVerdictCard(state) {
    var v = state.imageVerdicts;
    if (!v || !v.length) return '';
    var bad = v.filter(function (g) { return !g.keep; });
    if (!bad.length) {
      return '<section class="card"><div class="note">' +
        '📄 All ' + v.length + ' photo' + (v.length === 1 ? '' : 's') +
        ' read as clean map documents.</div></section>';
    }
    return '<section class="card"><div class="note warn">' +
      '📄 ' + bad.length + ' of ' + v.length + ' photo' + (v.length === 1 ? '' : 's') +
      ' did not pass as a clean map:<ul>' +
      bad.map(function (g, i) {
        return '<li>' + esc(g.image.name || (g.role + ' photo ' + (i + 1))) + ' — ' +
          esc(g.reason) + '</li>';
      }).join('') +
      '</ul>Still used for your plan. If one of these was meant to be the map, ' +
      'retake it and read the photos again.</div></section>';
  }

  function section(title, inner) {
    return '<section class="card"><h2>' + esc(title) + '</h2>' + inner + '</section>';
  }

  function hhmm(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* ---------- interview ---------------------------------------------------- */

  function renderInterview(state) {
    if (state.currentDuel) return renderDuel(state);

    var q = state.currentQuestion;
    var progress = Object.keys(state.answered).length;

    // Ranking is async. Without this branch the "nothing left" copy below
    // flashes up for a second or two every time, which reads as a bug.
    if (!q && state.busy) {
      return '<section class="card">' +
        '<div class="q-meta">Thinking</div>' +
        '<h1>Working out what to ask next…</h1>' +
        '<p class="muted">Testing each remaining question against your plan to find ' +
        'the one that would change the day most.</p></section>' +
        (state.plan && state.plan.ok ? planSummaryCard(state.plan, true) : '');
    }

    if (!q) {
      return [
        '<section class="card">',
          '<h1>Nothing left worth asking</h1>',
          '<p class="muted">Every remaining question would give you the same day. ',
          'You can still change anything from here.</p>',
          '<div class="stack">',
            btn('screen:plan', 'See the plan →', 'primary block'),
            btn('interview:reset', 'Start the questions over', 'block'),
          '</div>',
        '</section>',
        state.plan && state.plan.ok ? planSummaryCard(state.plan) : ''
      ].join('');
    }

    return [
      '<section class="card q-card">',
        '<div class="q-meta">' + esc(q.stage === 'setup' ? 'Setting up' : 'Refining') +
          ' · ' + progress + ' answered' +
          (state.questionRank && state.questionRank.divergence
            ? ' · <span title="How much your answer changes the day">impact ' +
              Math.round(state.questionRank.divergence * 100) + '%</span>'
            : '') +
        '</div>',
        '<h1>' + esc(q.text) + '</h1>',
        q.help ? '<p class="muted">' + esc(q.help) + '</p>' : '',
        questionBody(q, state),
      '</section>',

      state.plan && state.plan.ok ? planSummaryCard(state.plan, true) : '',

      '<section class="card">',
        '<div class="stack">',
          btn('screen:plan', 'Skip ahead to the plan →', 'block'),
        '</div>',
      '</section>'
    ].join('');
  }

  function questionBody(q, state) {
    var current = state.answered[q.id];

    if (q.type === 'party') return partyEditor(state);
    if (q.type === 'hours') return hoursEditor(state);

    var opts = PP.questionOptions(q, state);

    if (q.type === 'single') {
      return '<div class="opts">' + opts.map(function (o) {
        var on = current === o.value;
        return '<button type="button" class="opt' + (on ? ' on' : '') + '" ' +
          'data-action="answer:single" data-q="' + q.id + '" data-value="' +
          esc(JSON.stringify(o.value)) + '">' +
          '<span class="opt-label">' + esc(o.label) + '</span>' +
          (o.hint ? '<span class="opt-hint">' + esc(o.hint) + '</span>' : '') +
          '</button>';
      }).join('') + '</div>';
    }

    // multi
    var sel = Array.isArray(current) ? current : [];
    return '<div class="opts multi">' + opts.map(function (o) {
      var on = sel.indexOf(o.value) >= 0;
      return '<button type="button" class="opt' + (on ? ' on' : '') + '" ' +
        'data-action="answer:toggle" data-q="' + q.id + '" data-value="' +
        esc(JSON.stringify(o.value)) + '">' +
        '<span class="opt-check">' + (on ? '✓' : '') + '</span>' +
        '<span class="opt-label">' + esc(o.label) + '</span>' +
        (o.hint ? '<span class="opt-hint">' + esc(o.hint) + '</span>' : '') +
        '</button>';
    }).join('') + '</div>' +
      '<div class="row end">' + btn('answer:commit', 'Continue →', 'primary', { 'data-q': q.id }) + '</div>';
  }

  function partyEditor(state) {
    var p = state.party;
    var kids = p.kids.map(function (k, i) {
      return '<div class="kid">' +
        '<label class="mini"><span>Age</span><input type="number" min="0" max="17" value="' +
          esc(k.age == null ? '' : k.age) + '" data-kid="' + i + '" data-field="age"></label>' +
        '<label class="mini"><span>Height (cm)</span><input type="number" min="40" max="200" value="' +
          esc(k.heightCm == null ? '' : k.heightCm) + '" data-kid="' + i + '" data-field="heightCm"></label>' +
        '<button type="button" class="btn small danger" data-action="kid:remove" data-index="' + i + '">✕</button>' +
        '</div>';
    }).join('');

    return '<div class="party">' +
      '<label class="field"><span>Adults</span>' +
        '<input type="number" min="1" max="20" value="' + p.adults + '" data-party="adults"></label>' +
      (kids || '<p class="muted small">No children in the party.</p>') +
      btn('kid:add', '➕ Add a child', 'block') +
      '<p class="muted small">Height is the one that matters — it decides which rides are worth ' +
      'walking to at all.</p>' +
      '<div class="row end">' + btn('answer:party', 'Continue →', 'primary') + '</div>' +
      '</div>';
  }

  function hoursEditor(state) {
    var pr = state.prefs, p = state.park;
    return '<div class="row gap">' +
      '<label class="field"><span>We arrive</span><input type="time" data-pref="arrive" value="' +
        hhmm(pr.arrive) + '"></label>' +
      '<label class="field"><span>We leave</span><input type="time" data-pref="depart" value="' +
        hhmm(pr.depart) + '"></label>' +
      '</div>' +
      '<p class="muted small">The park is open ' + PP.fmtTime(p.openTime) + ' – ' +
      PP.fmtTime(p.closeTime) + '.</p>' +
      '<div class="row end">' + btn('answer:hours', 'Continue →', 'primary') + '</div>';
  }

  /* ---------- A/B duels ----------------------------------------------------- */

  function duelFacts(item) {
    var bits = [];
    if (item.zone) bits.push(chip(item.zone, 'zone'));
    if (item.kind === 'show') {
      bits.push(chip(item.durationMin + ' min show'));
      if (item.times && item.times.length) {
        bits.push(chip(item.times.map(PP.fmtTime).join(' · '), 'show'));
      }
    } else {
      if (item.typicalWaitMin) bits.push(chip('~' + item.typicalWaitMin + ' min queue', 'wait'));
      else bits.push(chip('no queue'));
      bits.push(chip(item.durationMin + ' min'));
    }
    if (item.thrill >= 3) bits.push(chip('thrill ' + item.thrill + '/5'));
    if (item.minHeightCm) bits.push(chip(item.minHeightCm + ' cm+'));
    (item.tags || []).slice(0, 3).forEach(function (t) { bits.push(chip(t)); });
    return '<div class="chips">' + bits.join('') + '</div>';
  }

  function duelSide(item, side) {
    return '<button type="button" class="duel-side" data-action="duel:pick" ' +
      'data-winner="' + esc(item.id) + '" data-side="' + side + '">' +
      '<span class="duel-i">' + icon({ kind: item.kind === 'show' ? 'show' : 'ride', item: item }) + '</span>' +
      '<strong>' + esc(item.name) + '</strong>' +
      duelFacts(item) +
      '</button>';
  }

  function renderDuel(state) {
    var d = state.currentDuel;
    var learned = PP.duels.learned(state);
    var n = PP.duels.count(state);

    return [
      '<section class="card q-card">',
        '<div class="q-meta">Comparing · ' + n + ' so far</div>',
        '<h1>Which would you rather do?</h1>',
        '<p class="muted">Pick the one you would genuinely choose if you only had time ' +
        'for one. This teaches it more than any rating scale.</p>',
        '<div class="duel">',
          duelSide(d.a, 'a'),
          '<div class="duel-vs">or</div>',
          duelSide(d.b, 'b'),
        '</div>',
        '<div class="row end">',
          btn('duel:tie', 'No strong feeling', 'small'),
          btn('duel:skip', 'Skip this one', 'small'),
        '</div>',
      '</section>',

      learned.length ? '<section class="card">' +
        '<div class="q-meta">What it has worked out</div>' +
        '<div class="chips">' + learned.map(function (l) {
          return chip((l.w > 0 ? '+ ' : '− ') + l.label, l.w > 0 ? 'show' : 'wait');
        }).join('') + '</div>' +
        '<p class="muted small">Derived from your choices, not from anything you typed.</p>' +
        '</section>' : '',

      state.plan && state.plan.ok ? planSummaryCard(state.plan, true) : ''
    ].join('');
  }

  /* ---------- plan duel ------------------------------------------------------ */

  function renderCompare(state) {
    var pd = state.planDuel;
    if (!pd) {
      return '<section class="card"><h1>Compare two days</h1>' +
        '<p class="muted">Builds two genuinely different versions of your day so you can ' +
        'pick between them, rather than answering more questions about preferences.</p>' +
        btn('compare:build', 'Build two options', 'primary block') + '</section>';
    }

    function sideCard(entry, other, side) {
      var p = entry.plan;
      var c = PP.duels.contrast(entry, other);
      return '<section class="card">' +
        '<div class="q-meta">Option ' + side.toUpperCase() + '</div>' +
        '<h2>' + esc(entry.axis.label) + '</h2>' +
        '<p class="muted small">' + esc(entry.axis.blurb) + '</p>' +
        '<div class="stats">' +
          stat(p.counts.rides, 'attractions') +
          stat(p.counts.shows, 'shows') +
          stat(p.walkKm.toFixed(1) + ' km', 'walking') +
          stat(PP.fmtDur(p.queuedMin), 'queueing') +
        '</div>' +
        (c.onlyA.length
          ? '<p class="small"><strong>Only here:</strong> ' + esc(c.onlyA.join(', ')) + '</p>'
          : '') +
        '<details><summary class="small muted">See the route</summary><ol class="maplist">' +
          p.stops.map(function (s) {
            return '<li><b>' + PP.fmtTime(s.arrive) + '</b> ' +
              esc(s.spec.kind === 'break' ? 'Rest' : s.spec.item.name) + '</li>';
          }).join('') + '</ol></details>' +
        btn('compare:choose', 'Take this one', 'primary block', { 'data-axis': entry.axis.id }) +
        '</section>';
    }

    return [
      '<section class="card">',
        '<h1>Which day would you rather have?</h1>',
        '<p class="muted">Two real plans, not descriptions. Choosing one applies its ' +
        'trade-off to everything from here on.</p>',
      '</section>',
      sideCard(pd.a, pd.b, 'a'),
      sideCard(pd.b, pd.a, 'b'),
      '<section class="card">' + btn('compare:build', '↻ Show me two different options', 'block') +
      btn('screen:plan', 'Neither — back to my plan', 'block') + '</section>'
    ].join('');
  }

  function planSummaryCard(plan, compact) {
    return '<section class="card summary' + (compact ? ' compact' : '') + '">' +
      (compact ? '<div class="q-meta">Plan as it stands</div>' : '') +
      '<div class="stats">' +
        stat(plan.counts.rides, 'attractions') +
        stat(plan.counts.shows, 'shows') +
        stat(plan.walkKm.toFixed(1) + ' km', 'walking') +
        stat(PP.fmtDur(plan.queuedMin), 'queueing') +
      '</div>' +
      '<p class="muted small">Finishes at ' + PP.fmtTime(plan.endTime) +
        ', back at the gate by ' + PP.fmtTime(plan.exitAt) + '.</p>' +
      '</section>';
  }

  function stat(v, l) {
    return '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>';
  }

  /* ---------- plan --------------------------------------------------------- */

  function renderPlan(state) {
    var plan = state.plan;
    if (!plan) return '<section class="card"><p>No plan yet.</p>' +
      btn('plan:build', 'Build one', 'primary block') + '</section>';

    if (!plan.ok) {
      return '<section class="card"><h1>That day does not fit</h1>' +
        '<p class="muted">' + esc(explainFailure(plan.reason)) + '</p>' +
        btn('screen:interview', 'Adjust your answers', 'primary block') + '</section>';
    }

    var rows = plan.stops.map(function (stop, i) {
      var spec = stop.spec;
      var name = spec.kind === 'break' ? 'Rest & recharge'
        : spec.kind === 'food' ? spec.label + ' — ' + spec.item.name
        : spec.item.name;

      var meta = [];
      if (stop.waitMin > 0) meta.push(chip('queue ' + Math.round(stop.waitMin) + ' min', 'wait'));
      if (spec.kind === 'show') meta.push(chip('starts ' + PP.fmtTime(spec.startAt), 'show'));
      if (stop.travelMin >= 1) meta.push(chip('walk ' + Math.round(stop.travelMin) + ' min'));
      if (spec.item && spec.item.zone) meta.push(chip(spec.item.zone, 'zone'));

      return '<li class="stop">' +
        '<div class="stop-time">' + PP.fmtTime(stop.arrive) +
          '<span>' + PP.fmtDur(stop.end - stop.arrive) + '</span></div>' +
        '<div class="stop-body">' +
          '<div class="stop-head"><span class="i">' + icon(spec) + '</span>' +
            '<strong>' + esc(name) + '</strong></div>' +
          (meta.length ? '<div class="chips">' + meta.join('') + '</div>' : '') +
          (stop.why && stop.why.length
            ? '<ul class="why">' + stop.why.map(function (w) {
                return '<li>' + esc(w) + '</li>';
              }).join('') + '</ul>'
            : '') +
        '</div></li>';
    }).join('');

    var missed = plan.missed.filter(function (m) { return m.value > 0; }).slice(0, 6);
    var ruledOut = plan.missed.filter(function (m) { return m.value === 0; });

    var badge = UI.liveBadge(state);

    return [
      planSummaryCard(plan),
      badge ? '<section class="card tight">' + badge + '</section>' : '',
      plan.warnings && plan.warnings.length
        ? '<section class="card"><div class="note warn">' +
          plan.warnings.map(esc).join('<br>') + '</div></section>'
        : '',
      '<section class="card">',
        '<h2>Your route</h2>',
        '<ol class="timeline">' + rows +
          '<li class="stop end"><div class="stop-time">' + PP.fmtTime(plan.exitAt) + '</div>' +
          '<div class="stop-body"><div class="stop-head"><span class="i">🚪</span>' +
          '<strong>Back at the entrance</strong></div></div></li>' +
        '</ol>',
      '</section>',

      missed.length ? '<section class="card">' +
        '<h2>Did not fit</h2>' +
        '<ul class="missed">' + missed.map(function (m) {
          return '<li><span>' + esc(m.item.name) + '</span>' +
            btn('mustsee:add', 'Make room', 'small', { 'data-id': m.item.id }) + '</li>';
        }).join('') + '</ul>' +
        '<p class="muted small">Marking one as must-see rebuilds the day around it — ' +
        'something else will drop out.</p></section>' : '',

      ruledOut.length ? '<section class="card">' +
        '<h2>Ruled out by your answers</h2>' +
        '<p class="muted small">' + ruledOut.slice(0, 12).map(function (m) {
          return esc(m.item.name);
        }).join(' · ') + '</p></section>' : '',

      '<section class="card">',
        '<div class="stack">',
          btn('screen:live', '📍 Start the day', 'primary block'),
          btn('compare:build', '⚖️ Compare two versions of this day', 'block'),
          btn('screen:waits', '🟢 Live queue times', 'block'),
          btn('plan:rebuild', '🔄 Rebuild the plan', 'block'),
          btn('screen:interview', '❓ Answer more questions', 'block'),
        '</div>',
      '</section>'
    ].join('');
  }

  function explainFailure(reason) {
    return ({
      'late-for-show': 'A must-see show cannot be reached in time from everything else you asked for.',
      'past-departure': 'There is not enough time between arriving and leaving.',
      'over-walk-budget': 'Your walking cap is too tight for the must-sees you picked.',
      'missed-meal-window': 'The meal window cannot be met alongside the fixed showtimes.',
      'cannot-reach-exit': 'The day runs right up to your departure time with no room to walk back.',
      'day-over': 'Your departure time has already passed.'
    })[reason] || 'The constraints conflict.';
  }

  /* ---------- map ---------------------------------------------------------- */

  function renderMap(state) {
    var plan = state.plan;
    var p = state.park;
    var pins = '';

    if (plan && plan.ok) {
      pins = plan.stops.map(function (stop, i) {
        if (stop.spec.kind === 'break') return '';
        var it = stop.spec.item;
        return '<div class="pin' + (state.liveIndex === i ? ' now' : '') + '" style="left:' +
          (it.x * 100).toFixed(2) + '%;top:' + (it.y * 100).toFixed(2) + '%" ' +
          'title="' + esc(it.name) + ' · ' + PP.fmtTime(stop.arrive) + '">' +
          '<span class="pin-n">' + (i + 1) + '</span></div>';
      }).join('');
    }

    pins += '<div class="pin gate" style="left:' + (p.entrance.x * 100).toFixed(2) +
      '%;top:' + (p.entrance.y * 100).toFixed(2) + '%" title="Entrance"><span class="pin-n">🚪</span></div>';

    return [
      '<section class="card tight">',
        '<div class="map-wrap" id="map-wrap">',
          p.mapImage
            ? '<img class="map-img" src="' + p.mapImage + '" alt="Park map">'
            : '<div class="map-img schematic"></div>',
          '<svg class="map-route" id="map-route" preserveAspectRatio="none" viewBox="0 0 100 100"></svg>',
          pins,
        '</div>',
      '</section>',
      p.mapImage ? '' : '<section class="card"><p class="muted small">No map photo — ' +
        'pins are drawn on a blank grid using the coordinates in your park data.</p></section>',
      plan && plan.ok ? '<section class="card"><h2>Order</h2><ol class="maplist">' +
        plan.stops.filter(function (s) { return s.spec.kind !== 'break'; }).map(function (s) {
          return '<li><b>' + PP.fmtTime(s.arrive) + '</b> ' + esc(s.spec.item.name) + '</li>';
        }).join('') + '</ol></section>' : ''
    ].join('');
  }

  function drawRoute(state) {
    var svg = document.getElementById('map-route');
    var plan = state.plan;
    if (!svg || !plan || !plan.ok) return;
    var pts = [state.park.entrance];
    plan.stops.forEach(function (s) { if (s.spec.kind !== 'break') pts.push(s.spec.item); });
    pts.push(state.park.entrance);
    var d = pts.map(function (pt, i) {
      return (i ? 'L' : 'M') + (pt.x * 100).toFixed(2) + ' ' + (pt.y * 100).toFixed(2);
    }).join(' ');
    svg.innerHTML = '<path d="' + d + '" class="route-line"/>';
  }

  /* ---------- live --------------------------------------------------------- */

  function renderLive(state) {
    var plan = state.plan;
    if (!plan || !plan.ok) {
      return '<section class="card"><p>Build a plan first.</p>' +
        btn('screen:plan', 'Go to plan', 'primary block') + '</section>';
    }

    var now = state.clockOverride != null ? state.clockOverride : PP.nowMinutes();
    var idx = plan.stops.findIndex(function (s) { return s.end > now; });
    if (idx < 0) idx = plan.stops.length - 1;
    state.liveIndex = idx;

    var cur = plan.stops[idx];
    var next = plan.stops[idx + 1];
    var spec = cur.spec;
    var name = spec.kind === 'break' ? 'Rest & recharge'
      : spec.kind === 'food' ? spec.label + ' — ' + spec.item.name : spec.item.name;

    var status;
    if (now < cur.arrive) status = 'Head to it — ' + PP.fmtDur(cur.arrive - now) + ' walk';
    else if (now < cur.start) status = 'Queueing — about ' + PP.fmtDur(cur.start - now) + ' left';
    else status = 'In progress until ' + PP.fmtTime(cur.end);

    return [
      UI.liveBadge(state) ? '<section class="card tight">' + UI.liveBadge(state) + '</section>' : '',
      '<section class="card now">',
        '<div class="q-meta">Now · ' + PP.fmtTime(now) + '</div>',
        '<div class="now-head"><span class="i big">' + icon(spec) + '</span>',
          '<div><h1>' + esc(name) + '</h1>',
          '<p class="muted">' + esc(status) + '</p></div></div>',
        spec.kind === 'show'
          ? '<div class="note">Be seated by ' + PP.fmtTime(cur.deadline) + '.</div>' : '',
        '<div class="row gap">',
          btn('live:done', '✓ Done', 'primary', { 'data-id': spec.item.id }),
          btn('live:skip', '✕ Skip', '', { 'data-id': spec.item.id }),
        '</div>',
      '</section>',

      next ? '<section class="card"><div class="q-meta">Up next · ' + PP.fmtTime(next.arrive) + '</div>' +
        '<div class="now-head"><span class="i">' + icon(next.spec) + '</span>' +
        '<strong>' + esc(next.spec.kind === 'food' ? next.spec.item.name : next.spec.item.name) +
        '</strong></div>' +
        (next.travelMin >= 1 ? '<p class="muted small">' + Math.round(next.distMeters) +
          ' m walk from here</p>' : '') +
        '</section>' : '',

      '<section class="card">',
        '<h2>Something changed?</h2>',
        '<div class="stack">',
          '<label class="field"><span>Actual queue here, in minutes</span>',
            '<div class="row gap">',
              '<input type="number" id="obs-wait" min="0" max="300" placeholder="' +
                Math.round(cur.waitMin) + '">',
              btn('live:observe', 'Apply', '', { 'data-id': spec.item.id }),
            '</div></label>',
          '<label class="field"><span>Tell it what is going on</span>',
            '<textarea id="steer-text" rows="2" placeholder="we\'re shattered, cut the walking"></textarea></label>',
          btn('live:steer', PP.vision.configured() ? '🤖 Re-plan from that' : '↻ Re-plan from that', 'block'),
          btn('screen:waits', state.park.waitSource
            ? '🟢 Live queue times' : '🟢 Connect live queue times', 'block'),
          '<div class="row gap">',
            btn('live:late', 'Running 20 min late', 'block'),
            btn('live:replan', '🔄 Re-optimise now', 'primary block'),
          '</div>',
        '</div>',
        state.steerLog && state.steerLog.length
          ? '<div class="note">Applied: ' + esc(state.steerLog.join('; ')) + '</div>' : '',
      '</section>',

      '<section class="card">',
        '<h2>Rest of the day</h2>',
        '<ol class="maplist">' + plan.stops.slice(idx + 1).map(function (s) {
          return '<li><b>' + PP.fmtTime(s.arrive) + '</b> ' +
            esc(s.spec.kind === 'break' ? 'Rest' : s.spec.item.name) + '</li>';
        }).join('') + '</ol>',
      '</section>'
    ].join('');
  }

  /* ---------- live wait times ------------------------------------------------ */

  UI.liveBadge = function (state) {
    var park = state.park;
    if (!park || !park.waitSource) return '';
    var age = PP.waits.ageMinutes(park);
    var stale = age != null && age > 30;
    var closed = PP.waits.closedCount(park);
    return '<div class="note' + (stale ? ' warn' : '') + '">' +
      '🟢 Live queue times · ' + park.waitSource.matched + ' of ' +
      park.waitSource.total + ' attractions matched' +
      (age != null ? ' · read ' + (age < 1 ? 'just now' : age + ' min ago') : '') +
      (closed ? ' · ' + closed + ' closed' : '') +
      (stale ? ' — worth refreshing' : '') +
      ' ' + btn('waits:refresh', 'Refresh', 'small') +
      '</div>';
  };

  function renderWaits(state) {
    var park = state.park;
    var w = state.waitsUI || {};
    var connected = !!park.waitSource;

    var suggestions = (w.suggestions || []).map(function (s) {
      return '<button type="button" class="opt" data-action="waits:connect" ' +
        'data-pid="' + s.park.id + '" data-pname="' + esc(s.park.name) + '">' +
        '<span class="opt-label">' + esc(s.park.name) + '</span>' +
        '<span class="opt-hint">' + esc(s.park.company + ' · ' + s.park.country) +
        ' · ' + Math.round(s.score * 100) + '% name match</span></button>';
    }).join('');

    var report = '';
    if (w.matchReport) {
      var m = w.matchReport;
      var rate = m.matched.length / Math.max(1, park.attractions.length);
      report = '<section class="card">' +
        (rate < 0.25
          ? '<div class="note warn">Only ' + m.matched.length + ' of ' +
            park.attractions.length + ' attractions matched. That usually means this is the ' +
            'wrong park, or the names on your map differ from the feed. Disconnect and try ' +
            'another if so — a handful of matches will not improve the plan much.</div>'
          : '') +
        '<h2>What matched</h2>' +
        '<ul class="missed">' + m.matched.slice(0, 40).map(function (x) {
          return '<li><span>' + esc(x.attraction.name) +
            (x.score < 0.85 ? ' <span class="muted small">→ ' + esc(x.ride.name) + '</span>' : '') +
            '</span><span class="chip ' + (x.ride.open ? 'wait' : '') + '">' +
            (x.ride.open ? x.ride.wait + ' min' : 'closed') + '</span></li>';
        }).join('') + '</ul>' +
        (m.unmatched.length
          ? '<p class="muted small"><strong>No live figure for:</strong> ' +
            m.unmatched.map(function (u) { return esc(u.attraction.name); }).join(', ') +
            '. These keep their modelled estimate, corrected by the park-wide reading.</p>'
          : '') +
        '</section>';
    }

    return [
      '<section class="card">',
        '<h1>Live queue times</h1>',
        connected
          ? UI.liveBadge(state) +
            '<p class="muted small">Source: ' + esc(park.waitSource.provider === 'web'
              ? (park.waitSource.sourceUrl || 'web search')
              : 'queue-times.com') + '</p>' +
            '<div class="stack">' +
              btn('waits:refresh', '↻ Refresh now', 'primary block') +
              btn('waits:disconnect', 'Disconnect', 'block') +
            '</div>'
          : '<p class="muted">Around 140 major parks publish live queue times through ' +
            'queue-times.com — Disney, Universal, Merlin, Six Flags, Cedar Fair and more. ' +
            'No account or key needed.</p>' +
            '<label class="field"><span>Find your park</span>' +
              '<input type="text" id="waits-q" value="' + esc(w.query || park.name || '') +
              '" placeholder="Start typing the park name"></label>' +
            btn('waits:search', 'Search', 'primary block') +
            (suggestions ? '<div class="opts">' + suggestions + '</div>' : '') +
            (w.searched && !suggestions
              ? '<div class="note warn">No match in that list.</div>' : ''),
      '</section>',

      connected ? '' : '<section class="card">' +
        '<h2>Not on that list?</h2>' +
        '<p class="muted small">Claude can search the park\'s own site for a live wait-times ' +
        'page. Slower, costs an API call, and only works if the park actually publishes them.</p>' +
        btn('waits:web', '🔎 Search the web for this park', 'block' +
          (PP.vision.configured() ? '' : ' ')) +
        (PP.vision.configured() ? '' :
          '<p class="muted small">Needs an API key — add one in Settings.</p>') +
        '</section>',

      report,

      '<section class="card">',
        '<h2>How live times are used</h2>',
        '<p class="muted small">A live reading tells you about right now, not about 4pm. ' +
        'So rather than replacing the model, each reading corrects it — fully at the moment ' +
        'it was taken, fading back to the usual pattern for that attraction as the plan moves ' +
        'further away in time. Attractions reported closed are dropped from the route entirely, ' +
        'and rides with no live figure still benefit from the park-wide correction.</p>',
      '</section>'
    ].join('');
  }

  /* ---------- settings ----------------------------------------------------- */

  function renderSettings(state) {
    var s = PP.vision.settings();
    return [
      '<section class="card">',
        '<h1>Settings</h1>',
        '<label class="field"><span>How to reach Claude</span>',
          '<select data-setting="transport">',
            '<option value="direct"' + (s.transport === 'direct' ? ' selected' : '') + '>Direct from this browser</option>',
            '<option value="proxy"' + (s.transport === 'proxy' ? ' selected' : '') + '>Through my own proxy</option>',
          '</select></label>',

        s.transport === 'direct'
          ? '<label class="field"><span>Anthropic API key</span>' +
            '<input type="password" data-setting="apiKey" value="' + esc(s.apiKey) +
            '" placeholder="sk-ant-..." autocomplete="off"></label>' +
            '<div class="note warn">Stored in this browser only, and sent straight to Anthropic. ' +
            'Fine for your own phone; use proxy mode before sharing this with anyone else.</div>'
          : '<label class="field"><span>Proxy URL</span>' +
            '<input type="text" data-setting="proxyUrl" value="' + esc(s.proxyUrl) + '"></label>' +
            '<div class="note">Run <code>server/proxy.mjs</code> — it keeps the key server-side.</div>',

        '<label class="field"><span>Model</span>' +
          '<input type="text" data-setting="model" value="' + esc(s.model) + '"></label>',

        '<div class="stack">',
          btn('settings:test', '🔌 Test the connection', 'block'),
          btn('settings:save', 'Save', 'primary block'),
        '</div>',
        state.testResult ? '<div class="note ' + (state.testResult.ok ? '' : 'warn') + '">' +
          esc(state.testResult.msg) + '</div>' : '',
      '</section>',

      '<section class="card">',
        '<h2>Data</h2>',
        '<div class="stack">',
          '<label class="btn block" for="file-json">📂 Import a park (.json)</label>',
          '<input type="file" id="file-json" accept="application/json,.json" hidden>',
          btn('park:export', '💾 Export park + answers', 'block'),
          btn('park:sample', '🎪 Load the sample park', 'block'),
          btn('park:blank', '✏️ Build a park by hand', 'block'),
          btn('state:reset', '🗑️ Clear everything on this device', 'block danger'),
        '</div>',
        '<p class="muted small">No API key? Send your photos to Claude in a chat, ask for park ' +
        'JSON matching this app\'s schema, save it, and import it here.</p>',
      '</section>',

      '<section class="card">',
        '<h2>How the route is chosen</h2>',
        '<p class="muted small">Shows have fixed start times, so they are placed first and the ' +
        'rest of the day is threaded around them. Attractions are then added one at a time, ' +
        'always the one giving the most value per minute it costs — where cost is walking plus ' +
        'queueing plus riding, and queue length is scaled by the time of day. Finally a local ' +
        'search shuffles, swaps and re-times things a few hundred times, keeping anything that ' +
        'improves the day.</p>',
      '</section>'
    ].join('');
  }

})(window.PP || (window.PP = {}));
