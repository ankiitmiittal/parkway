/* ==========================================================================
   vision.js — turn photos of a park map and a showtimes board into structured
   park data, using Claude with structured outputs so the shape is guaranteed
   rather than scraped out of prose.

   Two transports:
     direct — browser calls api.anthropic.com with your own key. Needs the
              anthropic-dangerous-direct-browser-access header. The key lives
              in localStorage on this device only.
     proxy  — browser calls your own small server, which holds the key.
              Use this the moment more than one person uses the app.
   ========================================================================== */
(function (PP) {
  'use strict';

  var V = PP.vision = {};

  var API_URL = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2023-06-01';
  var DEFAULT_MODEL = 'claude-opus-5';
  var MAX_EDGE = 2576;            // Opus 5 high-res vision ceiling, long edge

  /* ---------- settings ---------------------------------------------------- */

  var LS_KEY = 'parkway.settings.v1';

  V.settings = function () {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* ignore */ }
    return Object.assign({
      transport: 'direct',        // 'direct' | 'proxy'
      apiKey: '',
      proxyUrl: 'http://localhost:8787/api/messages',
      model: DEFAULT_MODEL
    }, raw || {});
  };

  V.saveSettings = function (patch) {
    var s = Object.assign(V.settings(), patch || {});
    localStorage.setItem(LS_KEY, JSON.stringify(s));
    return s;
  };

  // The site's own key, served by netlify/functions/claude.js. Only exists
  // when the app is hosted; opening index.html from a file has no server.
  var SITE_PROXY = '/.netlify/functions/claude';

  V.siteProxyAvailable = function () {
    return location.protocol === 'http:' || location.protocol === 'https:';
  };

  /* Hosted, the site's own key covers everyone, so nobody has to bring one.
     A personal key in Settings still wins if it is set — useful for testing
     against your own account, and the only option from file://. */
  V.configured = function () {
    var s = V.settings();
    if (s.transport === 'proxy') return !!s.proxyUrl;
    if (s.apiKey) return true;
    return V.siteProxyAvailable();
  };

  // Which of the three routes a request will actually take.
  V.route = function () {
    var s = V.settings();
    if (s.transport === 'proxy') return 'your proxy';
    if (s.apiKey) return 'your own key';
    return V.siteProxyAvailable() ? "this site's key" : 'not configured';
  };

  /* ---------- image handling ---------------------------------------------- */

  // Read a File into a { media_type, data } base64 pair, downscaling only if
  // the image is bigger than the model's high-res ceiling.
  var MAX_PDF_BYTES = 12 * 1024 * 1024;   // the API caps the whole request at 32 MB
  var MAX_REQUEST_B64 = 24 * 1024 * 1024; // leave headroom for the rest of the body

  /* Pick the right reader for whatever was dropped in. */
  V.readFile = function (file) {
    if (/^application\/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
      return V.readPdf(file);
    }
    return V.readImage(file);
  };

  /* PDFs go to the model as-is — Claude reads them natively, and a vector
     park map is far crisper than a photograph of one.

     Note the asymmetry with images: an image is re-drawn through a canvas,
     which strips EXIF and GPS as a side effect. A PDF is forwarded byte for
     byte, so any metadata its author embedded (producing software, title,
     sometimes an author name) goes with it. */
  // A 50-page visitor guide is mostly marketing, and every page is billed as
  // an image. Worth telling people before they send one.
  V.BROCHURE_HINT_BYTES = 2 * 1024 * 1024;

  V.readPdf = function (file) {
    return new Promise(function (resolve, reject) {
      if (file.size > MAX_PDF_BYTES) {
        return reject(new Error(file.name + ' is ' + Math.round(file.size / 1048576) +
          ' MB. The limit is ' + (MAX_PDF_BYTES / 1048576) + ' MB — try the map pages on their own.'));
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read ' + file.name + '.')); };
      reader.onload = function () {
        var buf = reader.result;
        var bytes = new Uint8Array(buf);
        // Trust the bytes, not the extension.
        if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
          return reject(new Error(file.name + ' does not look like a PDF inside.'));
        }
        resolve({
          kind: 'pdf',
          name: file.name,
          media_type: 'application/pdf',
          data: bytesToBase64(bytes),
          sizeBytes: file.size,
          dataUrl: null            // nothing to show as a map backdrop
        });
      };
      reader.readAsArrayBuffer(file);
    });
  };

  // Chunked: String.fromCharCode.apply blows the stack on a whole large file.
  function bytesToBase64(bytes) {
    var chunk = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  V.readImage = function (file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) {
        return reject(new Error(file.name + ' is not an image.'));
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);

        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);

        // JPEG keeps photographed maps small; PNG would balloon the request.
        var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        resolve({
          kind: 'image',
          name: file.name,
          media_type: 'image/jpeg',
          data: dataUrl.split(',')[1],
          dataUrl: dataUrl,
          width: cw,
          height: ch,
          scaled: scale < 1
        });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not decode ' + file.name + '.'));
      };
      img.src = url;
    });
  };

  /* ---------- output schema ------------------------------------------------
     Structured outputs require every object to declare `required` and
     `additionalProperties: false`, and reject numeric range constraints —
     so ranges are stated in the descriptions instead.
     --------------------------------------------------------------------- */

  function obj(props, required) {
    return {
      type: 'object',
      properties: props,
      required: required || Object.keys(props),
      additionalProperties: false
    };
  }

  var TAG_ENUM = ['thrill', 'water', 'dark', 'spinning', 'heights', 'animals',
                  'kids', 'indoor', 'nature', 'interactive', 'shows', 'food', 'history'];

  var PARK_SCHEMA = obj({
    name: { type: 'string', description: 'Name of the park, if visible. Otherwise a sensible guess.' },
    openTime: { type: 'string', description: 'Opening time as 24h HH:MM. Use 09:00 if not shown.' },
    closeTime: { type: 'string', description: 'Closing time as 24h HH:MM. Use 18:00 if not shown.' },
    spanMeters: { type: 'number', description: 'Approximate real-world width the map covers, in metres. Typical zoo 800, large theme park 1600. Guess from any scale bar, walking-time labels, or the number of attractions.' },
    entrance: obj({
      x: { type: 'number', description: 'Normalised 0..1 horizontal position on the map image, 0 = left edge.' },
      y: { type: 'number', description: 'Normalised 0..1 vertical position, 0 = top edge.' }
    }),
    attractions: {
      type: 'array',
      description: 'Every ride, exhibit, walkthrough and play area on the map.',
      items: obj({
        name: { type: 'string' },
        kind: { type: 'string', enum: ['ride', 'walk', 'play', 'exhibit'] },
        x: { type: 'number', description: 'Normalised 0..1 horizontal position on the map image.' },
        y: { type: 'number', description: 'Normalised 0..1 vertical position on the map image.' },
        zone: { type: 'string', description: 'Themed land or area name, or "" if the map has none.' },
        durationMin: { type: 'number', description: 'Minutes spent experiencing it, excluding queueing.' },
        typicalWaitMin: { type: 'number', description: 'Typical mid-day queue in minutes. 0 for walkthroughs with no queue. Estimate from the attraction type if not posted.' },
        thrill: { type: 'number', description: 'Intensity 0 (gentle) to 5 (extreme).' },
        minHeightCm: { type: 'number', description: 'Minimum rider height in cm, 0 if none.' },
        tags: { type: 'array', items: { type: 'string', enum: TAG_ENUM } },
        iconic: { type: 'boolean', description: 'True for headline attractions a first-time visitor would prioritise.' }
      })
    },
    shows: {
      type: 'array',
      description: 'Anything with fixed start times: shows, feedings, keeper talks, parades.',
      items: obj({
        name: { type: 'string' },
        x: { type: 'number', description: 'Normalised 0..1 horizontal position of the venue.' },
        y: { type: 'number', description: 'Normalised 0..1 vertical position of the venue.' },
        zone: { type: 'string' },
        durationMin: { type: 'number' },
        times: { type: 'array', items: { type: 'string', description: '24h HH:MM start time.' } },
        arriveEarlyMin: { type: 'number', description: 'Minutes before start you must be seated. 5 for a small keeper talk, 25 for a popular parade.' },
        capacityRisk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How likely it is to fill up.' },
        tags: { type: 'array', items: { type: 'string', enum: TAG_ENUM } },
        iconic: { type: 'boolean' }
      })
    },
    food: {
      type: 'array',
      description: 'Restaurants, cafes and snack outlets.',
      items: obj({
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        zone: { type: 'string' },
        durationMin: { type: 'number', description: '40 for a sit-down restaurant, 20 for a quick counter.' }
      })
    },
    imageAssessments: {
      type: 'array',
      description: 'One entry for EVERY image supplied, in the order given, including any you could not read.',
      items: obj({
        index: { type: 'number', description: '1-based position of the attachment as it was supplied.' },
        documentType: {
          type: 'string',
          enum: ['wall_map', 'paper_map', 'pdf_map', 'pdf_brochure', 'showtimes_board',
                 'other_signage', 'screen', 'photo_of_people', 'scene_no_map',
                 'unreadable', 'other'],
          description: 'wall_map = a map or plan mounted on a wall, board or stand. paper_map = a photo of a printed handout, leaflet or foldout. pdf_map = a PDF that is essentially just a map or plan. pdf_brochure = a PDF that is a wider brochure, with marketing pages alongside any map. showtimes_board = a schedule board. screen = a photograph of a display or phone. photo_of_people = the subject is a person. scene_no_map = a scene with no map in it.'
        },
        humanPresence: {
          type: 'string',
          enum: ['none', 'hands_only', 'reflection', 'person_background', 'person_prominent', 'uncertain'],
          description: 'For a PDF, judge across every page. none = no trace of any person anywhere, in any photo, illustration or page. hands_only = fingers or a hand holding the map, no face or body. reflection = anyone reflected in glass or a screen. person_background = anyone visible however small, blurred or partial. uncertain = you cannot rule people out.'
        },
        isCleanMapDocument: {
          type: 'boolean',
          description: 'True only if this is a legible map, plan or schedule AND you are confident no identifiable person appears anywhere in it.'
        },
        confidence: { type: 'number', description: 'Your confidence in this assessment, 0 to 1.' },
        reason: { type: 'string', description: 'One short sentence a visitor would understand, e.g. "this looks like a photo of two people, not a map".' }
      })
    },
    notes: {
      type: 'array',
      description: 'Anything you were unsure about, so the visitor can correct it. One short sentence each.',
      items: { type: 'string' }
    }
  });

  var SYSTEM_PROMPT = [
    'You read photographs of theme-park and zoo maps and showtimes boards, and turn them into structured data for a route planner.',
    '',
    'Coordinates are the important part. For every attraction, show venue and eatery, give x and y as fractions of the FIRST image supplied (the map): x=0 is its left edge, x=1 its right edge, y=0 the top, y=1 the bottom. Read the position off the map symbol or label, not off a list. If an item appears only on a showtimes board and you cannot find it on the map, place it near the middle of the zone its name suggests and mention that in notes.',
    '',
    'Showtimes must come from the board when one is supplied; do not invent times, and do not carry over times from a different day. Give them in 24-hour HH:MM.',
    '',
    'Queue lengths and ride durations are usually not printed. Estimate them from what the attraction plainly is — a headline roller coaster queues far longer than a reptile house — and say in notes that they are estimates. It is more useful to give a reasoned estimate than a zero.',
    '',
    'Transcribe names exactly as printed. Do not invent attractions that are not in the images. If the map is partly illegible, extract what you can and list what you could not read in notes.',
    '',
    'Finally, assess every attachment in imageAssessments, one entry per attachment, in order. This assessment decides whether it may be retained beyond this trip, so judge it conservatively and independently of how useful it was to you:',
    '',
    '- Look specifically for people before answering. Check the edges and the background, not just the subject. Anyone counts however small, blurred, turned away or partially cropped.',
    '- For a PDF, judge the whole file, not just the map page. Marketing photographs of visitors anywhere in a brochure mean people are present.',
    '- A person reflected in glass, perspex or a screen counts as a person present.',
    '- Fingers or a hand holding a paper map, with no face or body visible, is hands_only.',
    '- If you cannot rule out a person, answer uncertain. Never guess none.',
    '- Set isCleanMapDocument true only when you would stake the answer on it. When you are in two minds, set it false and say why.',
    '',
    'Being wrong in the direction of rejecting a perfectly good map costs nothing. Being wrong the other way means keeping a photograph of somebody who never agreed to it.'
  ].join('\n');

  /* ---------- transport ----------------------------------------------------- */

  function requestBody(model, messages, schema) {
    var body = {
      model: model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: messages
    };
    if (schema) {
      body.output_config = { format: { type: 'json_schema', schema: schema } };
    }
    return body;
  }

  function send(body) {
    var s = V.settings();
    var url, headers = { 'content-type': 'application/json' };

    if (s.transport === 'proxy') {
      url = s.proxyUrl;
    } else if (s.apiKey) {
      url = API_URL;
      headers['x-api-key'] = s.apiKey;
      headers['anthropic-version'] = API_VERSION;
      // Required for calls made straight from a browser.
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (V.siteProxyAvailable()) {
      // No personal key, but we are hosted: use the site's own key. Same
      // origin, so no CORS and no key ever reaches the browser.
      url = SITE_PROXY;
    } else {
      return Promise.reject(new Error(
        'No API key set. Open Settings and add one — a local file has no server to borrow a key from.'));
    }

    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
          if (!res.ok) {
            var msg = (data && data.error && data.error.message) || text.slice(0, 300) ||
                      ('HTTP ' + res.status);
            throw new Error('API error ' + res.status + ': ' + msg);
          }
          return data;
        });
      })
      .catch(function (err) {
        if (err instanceof TypeError) {
          // fetch() rejects with TypeError on network/CORS failure.
          throw new Error(
            'Could not reach the API. If you opened this file directly, your browser may be ' +
            'blocking the cross-origin request — run the bundled proxy (see README) and switch ' +
            'Settings to Proxy mode.'
          );
        }
        throw err;
      });
  }

  // Pull the text out of a response, handling refusals explicitly.
  function readText(data) {
    if (!data) throw new Error('Empty response from the API.');
    if (data.stop_reason === 'refusal') {
      var cat = data.stop_details && data.stop_details.category;
      throw new Error('The model declined this request' + (cat ? ' (' + cat + ')' : '') + '.');
    }
    if (data.stop_reason === 'max_tokens') {
      throw new Error('The response was cut off before it finished. Try fewer or smaller photos.');
    }
    var blocks = (data.content || []).filter(function (b) { return b.type === 'text'; });
    if (!blocks.length) throw new Error('No text came back from the model.');
    return blocks.map(function (b) { return b.text; }).join('');
  }

  /* ---------- parsing photos into a park ------------------------------------ */

  /**
   * @param {Array} mapFiles    map attachments, images or PDFs; the first defines coordinates
   * @param {Array} boardFiles  showtimes boards / entertainment schedules, images or PDFs
   * @param {Object} hints      { name, date, openTime, closeTime } — anything the user typed
   */
  /* ---------- retention gate ------------------------------------------------
     Decides whether an image may be KEPT. It does not affect planning: a
     rejected photo is still used for the visitor's own trip, it just never
     becomes something you hold on to.

     Every rule below is a whitelist, and a missing or malformed assessment is
     a rejection. The failure mode we care about is keeping a picture of a
     person, so uncertainty resolves to "no".
     --------------------------------------------------------------------- */

  // A hand holding a leaflet is not an identifiable person. Set this to
  // ['none'] to reject held paper maps as well.
  V.ALLOWED_PRESENCE = ['none', 'hands_only'];

  // pdf_brochure is deliberately absent: a park's marketing PDF is usually
  // full of stock photographs of families, and a map page inside one is not
  // worth the risk of keeping the rest.
  V.KEEPABLE_TYPES = ['wall_map', 'paper_map', 'pdf_map', 'showtimes_board'];

  V.MIN_CONFIDENCE = 0.85;

  var PRESENCE_REASON = {
    reflection: 'Someone is reflected in the glass.',
    person_background: 'Someone is visible in the background.',
    person_prominent: 'There is a person in the photo.',
    uncertain: 'People could not be ruled out.'
  };

  var TYPE_REASON = {
    pdf_brochure: 'A brochure rather than a plain map — brochures usually carry photos of people.',
    photo_of_people: 'This is a photo of people, not a map.',
    scene_no_map: 'There is no map in this photo.',
    other_signage: 'Signage rather than a map or schedule.',
    screen: 'This is a photo of a screen.',
    unreadable: 'This could not be read.',
    other: 'This is not a map or schedule.'
  };

  // The model's own sentence, only when it is actually a sentence.
  function detail(a) {
    var r = a && typeof a.reason === 'string' ? a.reason.trim() : '';
    return r.length > 3 ? r : '';
  }

  V.gate = function (a) {
    if (!a || typeof a !== 'object') {
      return { keep: false, reason: 'No assessment came back for this image.' };
    }

    // People first: it is the whole reason this gate exists, and checking it
    // ahead of everything else means the message a person reads is the real
    // reason rather than whatever the free-text field happened to say.
    if (V.ALLOWED_PRESENCE.indexOf(a.humanPresence) < 0) {
      return { keep: false, reason: PRESENCE_REASON[a.humanPresence] ||
                                    'People could not be ruled out.' };
    }
    if (V.KEEPABLE_TYPES.indexOf(a.documentType) < 0) {
      return { keep: false, reason: TYPE_REASON[a.documentType] ||
                                    'This is not a map or schedule.' };
    }
    // Reached only when the structured fields all look fine, so the model's
    // own wording is the most informative thing left to show.
    if (a.isCleanMapDocument !== true) {
      // Prefixed, so a positive-sounding sentence can never read as approval.
      var d = detail(a);
      return { keep: false, reason: d ? 'Not confident this is a clean map — ' + d
                                      : 'Not confidently a clean map document.' };
    }
    if (typeof a.confidence !== 'number' || a.confidence < V.MIN_CONFIDENCE) {
      return { keep: false, reason: 'Not certain enough about this one.' };
    }
    return { keep: true, reason: detail(a) || 'Clean map document.' };
  };

  /* Pair each supplied image with its verdict. Images with no matching
     assessment are rejected rather than silently passed. */
  V.gateImages = function (images, assessments) {
    var byIndex = {};
    (assessments || []).forEach(function (a) {
      if (a && typeof a.index === 'number') byIndex[a.index] = a;
    });
    return images.map(function (img, i) {
      // Prefer the model's own 1-based index; fall back to position.
      var a = byIndex[i + 1] || (assessments || [])[i] || null;
      var verdict = V.gate(a);
      return {
        image: img,
        role: img.role || 'image',
        assessment: a,
        keep: verdict.keep,
        reason: verdict.reason
      };
    });
  };

  V.parsePark = function (mapFiles, boardFiles, hints) {
    hints = hints || {};
    mapFiles = mapFiles || [];
    boardFiles = boardFiles || [];
    if (!mapFiles.length && !boardFiles.length) {
      return Promise.reject(new Error('Add at least one photo or PDF first.'));
    }

    // One flat list in request order, so the model's 1-based attachment
    // indexes line up with what we gate afterwards.
    var ordered = mapFiles.map(function (f) { return Object.assign({ role: 'map' }, f); })
      .concat(boardFiles.map(function (f) { return Object.assign({ role: 'board' }, f); }));

    var totalB64 = ordered.reduce(function (n, f) { return n + (f.data ? f.data.length : 0); }, 0);
    if (totalB64 > MAX_REQUEST_B64) {
      return Promise.reject(new Error(
        'These files come to about ' + Math.round(totalB64 / 1048576) +
        ' MB encoded, over the ' + Math.round(MAX_REQUEST_B64 / 1048576) +
        ' MB request limit. Remove one, or use just the pages with the map on.'));
    }

    var hasPdf = ordered.some(function (f) { return f.kind === 'pdf'; });

    var intro = ['Here is what the visitor supplied on the way into the park.'];
    ordered.forEach(function (f, i) {
      intro.push('Attachment ' + (i + 1) + ' (' + (f.kind === 'pdf' ? 'PDF' : 'photo') + '): ' +
        (f.role === 'map' ? 'the park map' : 'a showtimes board') +
        (f.name ? ' — ' + f.name : '') + '.');
    });

    var content = [{ type: 'text', text: intro.join('\n') }];

    ordered.forEach(function (f) {
      if (f.kind === 'pdf') {
        // Claude reads PDFs natively; a vector map beats a photo of one.
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: f.data }
        });
      } else {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: f.media_type, data: f.data }
        });
      }
    });

    var ask = ['Extract the park into the required structure.', ''];
    ask.push(hasPdf
      ? 'Coordinates: x and y are fractions of attachment 1 — of the image itself, or, if attachment 1 is a PDF, of whichever page the map is drawn on. Use the same page for every coordinate.'
      : 'Remember: x and y are fractions of attachment 1, the map.');
    if (hasPdf) {
      ask.push('A PDF may be a whole brochure. Take the attractions from the map pages, and ignore marketing copy, prices and ticketing pages.');
    }
    if (hints.name) ask.push('The visitor says the park is called: ' + hints.name + '.');
    if (hints.date) ask.push('Today is ' + hints.date + ' — use only showtimes valid for that day.');
    if (hints.openTime) ask.push('The visitor says it opens at ' + hints.openTime + '.');
    if (hints.closeTime) ask.push('The visitor says it closes at ' + hints.closeTime + '.');
    if (!boardFiles.length) {
      ask.push('No separate showtimes board was supplied. Only include shows whose times are printed on the map or in the PDF; leave the times array empty for any show whose times you cannot see.');
    }

    content.push({ type: 'text', text: ask.join('\n') });

    var body = requestBody(V.settings().model, [{ role: 'user', content: content }], PARK_SCHEMA);

    return send(body).then(function (data) {
      var parsed = JSON.parse(readText(data));
      var gated = V.gateImages(ordered, parsed.imageAssessments);
      return {
        park: toPark(parsed, backdropFor(ordered)),
        notes: parsed.notes || [],
        gated: gated,
        keepable: gated.filter(function (g) { return g.keep; }),
        rejected: gated.filter(function (g) { return !g.keep; }),
        usage: data.usage || null
      };
    });
  };

  /* The Map screen needs a bitmap behind the pins. A PDF cannot be one, so
     fall back to the first real image supplied; with none, the map view uses
     its schematic grid and the route still draws correctly. */
  function backdropFor(ordered) {
    for (var i = 0; i < ordered.length; i++) {
      if (ordered[i].kind !== 'pdf' && ordered[i].dataUrl) return ordered[i];
    }
    return null;
  }

  // Convert the model's output into the app's internal park shape.
  function toPark(raw, mapImage) {
    var park = PP.newPark({
      name: raw.name || 'My park',
      openTime: PP.parseTime(raw.openTime) != null ? PP.parseTime(raw.openTime) : 9 * 60,
      closeTime: PP.parseTime(raw.closeTime) != null ? PP.parseTime(raw.closeTime) : 18 * 60,
      spanMeters: raw.spanMeters > 50 ? raw.spanMeters : 1100,
      mapImage: mapImage ? mapImage.dataUrl : null,
      entrance: {
        x: PP.clamp(num(raw.entrance && raw.entrance.x, 0.5), 0, 1),
        y: PP.clamp(num(raw.entrance && raw.entrance.y, 0.93), 0, 1)
      }
    });

    park.attractions = (raw.attractions || []).map(function (a) {
      return {
        id: PP.uid('a'),
        name: a.name || 'Unnamed',
        kind: a.kind || 'ride',
        x: PP.clamp(num(a.x, 0.5), 0, 1),
        y: PP.clamp(num(a.y, 0.5), 0, 1),
        zone: a.zone || '',
        durationMin: Math.max(1, num(a.durationMin, 10)),
        typicalWaitMin: Math.max(0, num(a.typicalWaitMin, 0)),
        thrill: PP.clamp(num(a.thrill, 0), 0, 5),
        minHeightCm: Math.max(0, num(a.minHeightCm, 0)),
        tags: (a.tags || []).slice(),
        iconic: !!a.iconic
      };
    });

    park.shows = (raw.shows || []).map(function (s) {
      return {
        id: PP.uid('s'),
        name: s.name || 'Unnamed show',
        kind: 'show',
        x: PP.clamp(num(s.x, 0.5), 0, 1),
        y: PP.clamp(num(s.y, 0.5), 0, 1),
        zone: s.zone || '',
        durationMin: Math.max(5, num(s.durationMin, 20)),
        times: (s.times || []).map(PP.parseTime).filter(function (t) { return t != null; })
          .sort(function (a, b) { return a - b; }),
        arriveEarlyMin: PP.clamp(num(s.arriveEarlyMin, 10), 0, 60),
        capacityRisk: s.capacityRisk || 'medium',
        tags: (s.tags || []).slice(),
        iconic: !!s.iconic
      };
    });

    park.food = (raw.food || []).map(function (f) {
      return {
        id: PP.uid('f'),
        name: f.name || 'Food outlet',
        kind: 'food',
        x: PP.clamp(num(f.x, 0.5), 0, 1),
        y: PP.clamp(num(f.y, 0.5), 0, 1),
        zone: f.zone || '',
        durationMin: Math.max(10, num(f.durationMin, 40)),
        typicalWaitMin: 10,
        tags: ['food']
      };
    });

    // A park with no eatery would make lunch unschedulable.
    if (!park.food.length) {
      park.food.push({
        id: PP.uid('f'), name: 'Food (location unknown)', kind: 'food',
        x: park.entrance.x, y: park.entrance.y, zone: '',
        durationMin: 40, typicalWaitMin: 10, tags: ['food']
      });
    }
    return park;
  }

  function num(v, dflt) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && isFinite(n) ? n : dflt;
  }

  /* ---------- model-assisted steering --------------------------------------
     Optional upgrade over the keyword rules in questions.js: turn a free-text
     request into a preference patch. Falls back to keywords on any failure.
     --------------------------------------------------------------------- */

  var PATCH_SCHEMA = obj({
    summary: { type: 'string', description: 'One short sentence describing what you changed, addressed to the visitor.' },
    thrillTolerance: { type: 'number', description: 'New 0-5 limit, or -1 to leave unchanged.' },
    walkBudgetMeters: { type: 'number', description: 'New walking cap in metres, 0 for unlimited, or -1 to leave unchanged.' },
    breakEveryMin: { type: 'number', description: 'Minutes between rest breaks, 0 for none, or -1 to leave unchanged.' },
    pace: { type: 'string', enum: ['slow', 'normal', 'fast', 'unchanged'] },
    departTime: { type: 'string', description: '24h HH:MM new departure time, or "" to leave unchanged.' },
    addAvoid: { type: 'array', items: { type: 'string', enum: TAG_ENUM }, description: 'Tags to rule out.' },
    removeAvoid: { type: 'array', items: { type: 'string', enum: TAG_ENUM }, description: 'Tags to stop ruling out.' },
    boostTags: { type: 'array', items: { type: 'string', enum: TAG_ENUM }, description: 'Tags to prioritise.' },
    dropTags: { type: 'array', items: { type: 'string', enum: TAG_ENUM }, description: 'Tags to de-prioritise.' },
    skipItems: { type: 'array', items: { type: 'string' }, description: 'Exact names of attractions or shows to drop from the rest of the day.' }
  });

  V.interpret = function (state, text) {
    var park = state.park;
    var inventory = PP.allItems(park).map(function (i) { return i.name; }).join(', ');
    var prompt = [
      'A visitor part-way through their day says:',
      '"' + text + '"',
      '',
      'Current settings — pace: ' + state.party.pace +
        ', thrill limit: ' + state.prefs.thrillTolerance +
        ', walking cap: ' + (state.prefs.walkBudgetMeters || 'none') +
        ', breaks every: ' + (state.prefs.breakEveryMin || 'never') +
        ', leaving at: ' + PP.fmtTime(state.prefs.depart) + '.',
      'Attractions in this park: ' + inventory + '.',
      '',
      'Translate what they said into changes to those settings. Change only what they actually asked for — use the "unchanged" sentinels for everything else.'
    ].join('\n');

    var body = requestBody(V.settings().model,
      [{ role: 'user', content: prompt }], PATCH_SCHEMA);
    body.max_tokens = 4000;
    delete body.system;

    return send(body).then(function (data) { return JSON.parse(readText(data)); });
  };

  // Apply an interpreted patch. Returns the list of changes made, for display.
  V.applyPatch = function (state, patch) {
    var changed = [];
    var p = state.prefs;

    if (patch.thrillTolerance >= 0 && patch.thrillTolerance !== p.thrillTolerance) {
      p.thrillTolerance = patch.thrillTolerance;
      changed.push('thrill limit → ' + patch.thrillTolerance);
    }
    if (patch.walkBudgetMeters >= 0 && patch.walkBudgetMeters !== p.walkBudgetMeters) {
      p.walkBudgetMeters = patch.walkBudgetMeters;
      changed.push('walking cap → ' + (patch.walkBudgetMeters ? patch.walkBudgetMeters + ' m' : 'none'));
    }
    if (patch.breakEveryMin >= 0 && patch.breakEveryMin !== p.breakEveryMin) {
      p.breakEveryMin = patch.breakEveryMin;
      changed.push('breaks → ' + (patch.breakEveryMin ? 'every ' + patch.breakEveryMin + ' min' : 'none'));
    }
    if (patch.pace && patch.pace !== 'unchanged' && patch.pace !== state.party.pace) {
      state.party.pace = patch.pace;
      changed.push('pace → ' + patch.pace);
    }
    var dep = PP.parseTime(patch.departTime);
    if (dep != null && dep !== p.depart) {
      p.depart = dep;
      changed.push('leaving at → ' + PP.fmtTime(dep));
    }
    (patch.addAvoid || []).forEach(function (t) {
      if (p.avoid.indexOf(t) < 0) { p.avoid.push(t); changed.push('avoiding ' + t); }
    });
    (patch.removeAvoid || []).forEach(function (t) {
      var i = p.avoid.indexOf(t);
      if (i >= 0) { p.avoid.splice(i, 1); changed.push('no longer avoiding ' + t); }
    });
    (patch.boostTags || []).forEach(function (t) {
      p.interests[t] = 2; changed.push('more ' + t);
    });
    (patch.dropTags || []).forEach(function (t) {
      p.interests[t] = -2; changed.push('less ' + t);
    });
    (patch.skipItems || []).forEach(function (name) {
      var item = PP.allItems(state.park).filter(function (i) {
        return i.name.toLowerCase() === String(name).toLowerCase();
      })[0];
      if (item && state.progress.skipped.indexOf(item.id) < 0) {
        state.progress.skipped.push(item.id);
        changed.push('skipping ' + item.name);
      }
    });
    return changed;
  };

  /* ---------- live waits via web search -------------------------------------
     For parks the Queue-Times feed does not cover. Uses the server-side web
     search tool, so Claude finds and reads the source itself. Server tools
     can stop with pause_turn when they hit their internal iteration cap, so
     the call is resumed a bounded number of times.
     --------------------------------------------------------------------- */

  var WAITS_SCHEMA = obj({
    found: { type: 'boolean', description: 'True only if you found genuinely live, current wait times.' },
    sourceUrl: { type: 'string', description: 'The page the figures came from, or "" if none.' },
    asOf: { type: 'string', description: 'Timestamp or freshness the source states, or "" if it does not say.' },
    waits: {
      type: 'array',
      description: 'One entry per attraction with a published current wait. Empty if none were found.',
      items: obj({
        name: { type: 'string', description: 'Attraction name exactly as the source writes it.' },
        waitMinutes: { type: 'number', description: 'Current posted wait in minutes. 0 for a walk-on.' },
        open: { type: 'boolean', description: 'False if the source says it is closed or down.' }
      })
    },
    notes: {
      type: 'array',
      description: 'Caveats worth showing the visitor - stale data, partial coverage, unofficial source.',
      items: { type: 'string' }
    }
  });

  V.findLiveWaits = function (state) {
    var park = state.park;
    var names = park.attractions.map(function (a) { return a.name; }).slice(0, 60);

    var prompt = [
      'Find the CURRENT live queue times for this theme park or zoo:',
      '',
      'Park: ' + park.name,
      'Attractions we care about: ' + names.join(', '),
      '',
      'Search for an official live wait-times page, app data, or a reputable queue-time',
      'tracker for this park. Report only figures that are genuinely live right now.',
      '',
      'If you cannot find live data, set found to false and return an empty waits array —',
      'do not estimate, guess, or fall back on typical waits. A wrong number here sends',
      'someone walking across a park for nothing, which is worse than no number at all.'
    ].join('\n');

    var body = {
      model: V.settings().model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      output_config: { format: { type: 'json_schema', schema: WAITS_SCHEMA } }
    };

    var messages = body.messages;
    var rounds = 0;

    function run() {
      return send(body).then(function (data) {
        // Server tools hit an iteration cap and ask to be resumed.
        if (data.stop_reason === 'pause_turn' && rounds++ < 3) {
          messages = messages.concat([{ role: 'assistant', content: data.content }]);
          body.messages = messages;
          return run();
        }
        var parsed = JSON.parse(readText(data));
        if (!parsed.found || !(parsed.waits || []).length) {
          var why = (parsed.notes || []).join(' ');
          throw new Error('No live wait times published for this park' + (why ? ' — ' + why : '.'));
        }
        return parsed;
      });
    }

    return run();
  };

  /* ---------- connection test ---------------------------------------------- */

  V.test = function () {
    return send({
      model: V.settings().model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }]
    }).then(function (data) {
      return readText(data).trim();
    });
  };

})(window.PP || (window.PP = {}));
