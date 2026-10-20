/* Palimpsest Studio — source, writing and share panels around the Writing Record.
 *
 * Runs after the Writing Record's own script, so its globals are in scope:
 * $, CONFIG, EV, META, RP, ingest(), ac(), syncMusicUI(), syncConfigText().
 * The recorder writes the same event shape as Palimpsest's reading copy
 * (build_reading_copy.py REC.push), so a studio .jsonl opens in the full app. */
(function () {
  "use strict";
  var SECTION = '1';
  var source = null;           // {kind:'gutenberg'|'paste', id?, title, author?}

  function show(el, on) { el.hidden = !on; }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ------------------------------------------------------------- source ---
  var tabs = document.querySelectorAll('.sttabs [data-tab]');
  function selectTab(name) {
    tabs.forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'); });
    document.querySelectorAll('.stpane').forEach(function (p) { show(p, p.dataset.pane === name); });
    if (name === 'none') setSource(null, '');
  }
  tabs.forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });

  // The source is shown a page of words at a time; a whole novel in one box is
  // unreadable on a phone. Words keep their trailing whitespace, so line breaks survive.
  var PAGE_WORDS = 500, words = [], page = 0;
  function setSource(meta, text) {
    source = meta;
    show($('st-ref'), !!meta);
    $('st-reftitle').textContent = meta ? meta.title + (meta.author ? ' — ' + meta.author : '') : '';
    words = (text || '').match(/\S+\s*/g) || [];
    showPage(0);
  }
  function showPage(n) {
    var pages = Math.max(1, Math.ceil(words.length / PAGE_WORDS));
    page = Math.max(0, Math.min(n, pages - 1));
    var from = page * PAGE_WORDS, to = Math.min(words.length, from + PAGE_WORDS);
    $('st-reftext').textContent = words.slice(from, to).join('');
    $('st-reftext').scrollTop = 0;
    show($('st-refnav'), pages > 1);
    $('st-refpos').textContent = 'words ' + (from + 1).toLocaleString() + '–' + to.toLocaleString() +
      ' of ' + words.length.toLocaleString();
    $('st-refback').disabled = page === 0;
    $('st-refnext').disabled = page === pages - 1;
  }
  $('st-refback').addEventListener('click', function () { showPage(page - 1); });
  $('st-refnext').addEventListener('click', function () { showPage(page + 1); });
  $('st-refclose').addEventListener('click', function () { selectTab('none'); });

  var results = $('st-gresults');
  function say(msg) { results.innerHTML = ''; var li = document.createElement('li'); li.className = 'empty'; li.textContent = msg; results.appendChild(li); }
  function loadBook(id) {
    say('Loading…');
    api('/api/gutenberg/text/' + id).then(function (b) {
      results.innerHTML = '';
      setSource({ kind: 'gutenberg', id: b.id, title: b.title, author: b.author }, b.text);
    }).catch(function (e) { say('Could not load that book: ' + e.message); });
  }
  $('st-gsearch').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = $('st-gq').value.trim(); if (!q) return;
    var m = q.match(/gutenberg\.org\/(?:ebooks|files|cache\/epub)\/(\d+)/) || q.match(/^#?(\d+)$/);
    if (m) { loadBook(m[1]); return; }
    say('Searching…');
    api('/api/gutenberg/search?q=' + encodeURIComponent(q)).then(function (j) {
      results.innerHTML = '';
      if (!j.results.length) { say('No matches.'); return; }
      j.results.forEach(function (b) {
        var li = document.createElement('li'), btn = document.createElement('button');
        btn.textContent = b.title; btn.title = 'Gutenberg #' + b.id;
        var by = document.createElement('span'); by.textContent = b.author || '';
        btn.appendChild(by);
        btn.addEventListener('click', function () { loadBook(b.id); });
        li.appendChild(btn); results.appendChild(li);
      });
    }).catch(function (e) { say('Search failed: ' + e.message); });
  });

  $('st-usepaste').addEventListener('click', function () {
    var t = $('st-paste').value; if (!t.trim()) return;
    setSource({ kind: 'paste', title: 'Pasted text' }, t);
  });
  $('st-srcfile').addEventListener('change', function (e) {
    var f = e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { $('st-paste').value = rd.result; setSource({ kind: 'paste', title: f.name }, rd.result); };
    rd.readAsText(f);
  });

  // ----------------------------------------------------------- recorder ---
  var ta = $('st-text'), rec = null, clock = null, sel = [0, 0];

  function newSession() {
    return { sid: Date.now() + '-' + Math.random().toString(36).slice(2, 8), all: [], last: 0, t0: Date.now() };
  }
  function push(ev) {
    var t = Date.now();
    ev.section = SECTION; ev.v = 1; ev.session = rec.sid; ev.t = t; ev.pt = Math.round(performance.now());
    ev.dt = rec.last ? t - rec.last : 0; rec.last = t;
    rec.all.push(ev);
  }
  function begin() {
    rec = newSession();
    push({ type: 'editstart', text0: ta.value, len: ta.value.length });
    clock = setInterval(tick, 250); tick();
    $('st-done').disabled = false; $('st-restart').disabled = false;
  }
  function tick() {
    var s = Math.floor((Date.now() - rec.t0) / 1000);
    $('st-clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  ta.addEventListener('keydown', function (e) {
    if (!rec) begin();
    push({ type: 'keydown', key: e.key, code: e.code, len: ta.value.length, caret: ta.selectionStart });
  });
  // Typing over a selection is a delete then an insert; the replay applies one
  // op per event, so emit the delete it would otherwise miss.
  var prevLen = 0;
  ta.addEventListener('beforeinput', function () { if (!rec) begin(); sel = [ta.selectionStart, ta.selectionEnd]; prevLen = ta.value.length; });
  ta.addEventListener('input', function (e) {
    if (!rec) begin();
    var it = e.inputType || '', len = ta.value.length, caret = ta.selectionStart, data = e.data;
    if (it.indexOf('insert') === 0) {
      var cut = Math.max(0, sel[1] - sel[0]);
      if (cut) push({ type: 'input', inputType: 'deleteContentBackward', data: null, len: prevLen - cut, caret: sel[0] });
      // a textarea reports pastes and drops with data === null; recover the text
      if (data == null && it !== 'insertLineBreak' && it !== 'insertParagraph')
        data = ta.value.slice(Math.max(0, caret - (len - (prevLen - cut))), caret);
    }
    push({ type: 'input', inputType: it, data: data == null ? null : data, len: len, caret: caret });
  });
  ta.addEventListener('focus', function () { document.body.classList.add('st-writing'); });
  ta.addEventListener('blur', function () { document.body.classList.remove('st-writing'); });
  // On a phone, leaving the textarea re-expands the source panel above it, which
  // would slide these buttons out from under the finger mid-tap. Keep the focus
  // through the press; each handler lets go of it afterwards.
  ['st-done', 'st-restart', 'st-refback', 'st-refnext'].forEach(function (id) {
    $(id).addEventListener('pointerdown', function (e) { if (document.activeElement === ta) e.preventDefault(); });
  });

  function stopReplay() { if (typeof RP !== 'undefined' && RP && RP.playing) $('play').click(); }

  $('st-done').addEventListener('click', function () {
    if (!rec) return;
    // Wake the synth inside this tap: ingest() awaits, and iOS only lets audio
    // start from the gesture itself.
    var a = ac(); if (a && a.state !== 'running') a.resume().catch(function () {});
    clearInterval(clock); ta.blur();
    push({ type: 'editend', len: ta.value.length, text: ta.value });
    var events = rec.all.slice();
    stopReplay();
    ingest(events, { session: rec.sid, source: 'studio' }).then(function () {
      show($('st-play'), true); hideShare();
      $('st-play').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('rewind').click(); $('play').click();
    });
  });

  $('st-restart').addEventListener('click', function () {
    stopReplay(); clearInterval(clock);
    rec = null; ta.value = ''; $('st-clock').textContent = '0:00';
    $('st-done').disabled = true; $('st-restart').disabled = true;
    show($('st-play'), false); $('view').hidden = true;
    ta.focus();
  });

  // ----------------------------------------------------------- playback ---
  $('st-wav').addEventListener('click', function () { $('mrender').click(); });
  // the page reports render progress in #renderst, which sits in the dials drawer
  new MutationObserver(function () { $('st-wavst').textContent = $('renderst').textContent; })
    .observe($('renderst'), { childList: true, characterData: true, subtree: true });
  $('st-jsonl').addEventListener('click', function () { $('dlsession').click(); });
  $('st-dials').addEventListener('click', function () {
    var on = document.body.classList.toggle('st-dials-open');
    this.setAttribute('aria-expanded', on ? 'true' : 'false');
  });

  // -------------------------------------------------------------- share ---
  function hideShare() { show($('st-sharebox'), false); show($('st-pubrow'), true); show($('st-urlrow'), false); }
  $('st-share').addEventListener('click', function () { show($('st-sharebox'), true); });
  $('st-sharecancel').addEventListener('click', hideShare);
  $('st-publish').addEventListener('click', function () {
    var btn = this; btn.disabled = true; btn.textContent = 'Publishing…';
    api('/api/s', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, events: EV, music: CONFIG.music, source: source }) })
      .then(function (j) {
        $('st-shareurl').value = location.origin + '/s/' + j.id;
        show($('st-pubrow'), false); show($('st-urlrow'), true);
        $('st-sharemsg').textContent = 'Published. Anyone with this link can play it.';
      })
      .catch(function (e) { $('st-sharemsg').textContent = 'Could not publish: ' + e.message; })
      .then(function () { btn.disabled = false; btn.textContent = 'Publish'; });
  });
  $('st-copy').addEventListener('click', function () {
    var u = $('st-shareurl'), btn = this;
    (navigator.clipboard ? navigator.clipboard.writeText(u.value) : Promise.reject())
      .catch(function () { u.select(); document.execCommand('copy'); })
      .then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); });
  });

  // ------------------------------------------------- opened from a link ---
  // Shared settings come from a stranger. The page interpolates some of them into
  // markup, so each known key must have its default's type, strings carry no
  // markup characters, and a letter map is letters -> {deg: number, chord: name}.
  var SAFE = /^[^<>&"'`\\]{0,64}$/;
  function cleanAs(v, d) {
    if (v === undefined || v === null) return d === undefined ? undefined : JSON.parse(JSON.stringify(d));
    if (d === undefined) {                         // a key the defaults don't name
      if (typeof v === 'number') return isFinite(v) ? v : undefined;
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return SAFE.test(v) ? v : undefined;
      if (typeof v === 'object' && !Array.isArray(v)) return cleanObj(v, {});
      return undefined;
    }
    if (typeof d === 'number') return typeof v === 'number' && isFinite(v) ? v : d;
    if (typeof d === 'boolean') return typeof v === 'boolean' ? v : d;
    if (typeof d === 'string') return typeof v === 'string' && SAFE.test(v) ? v : d;
    if (typeof d === 'object' && !Array.isArray(d)) return typeof v === 'object' && !Array.isArray(v) ? cleanObj(v, d) : cleanAs(undefined, d);
    return cleanAs(undefined, d);
  }
  function cleanObj(v, d) {
    var o = {};
    Object.keys(d).forEach(function (k) { o[k] = cleanAs(v[k], d[k]); });
    Object.keys(v).forEach(function (k) {
      if (k in d || !SAFE.test(k)) return;
      var c = cleanAs(v[k], undefined); if (c !== undefined) o[k] = c;
    });
    return o;
  }
  function cleanMusic(m) {
    var out = cleanObj(m && typeof m === 'object' ? m : {}, DEFAULTS.music), lm = {};
    Object.keys((m && m.letterMap) || {}).forEach(function (k) {
      var e = m.letterMap[k];
      if (!/^[a-z]$/.test(k) || !e || typeof e.deg !== 'number' || !isFinite(e.deg)) return;
      lm[k] = { deg: Math.round(e.deg) };
      if (typeof e.chord === 'string' && SAFE.test(e.chord)) lm[k].chord = e.chord;
    });
    out.letterMap = lm;
    return out;
  }

  var m = location.pathname.match(/^\/s\/([A-Za-z0-9]+)$/);
  if (m) {
    document.body.classList.add('st-shared');
    show($('st-source'), false); show($('st-write'), false);
    api('/api/s/' + m[1]).then(function (s) {
      if (s.music) { CONFIG.music = cleanMusic(s.music); syncMusicUI(); syncConfigText(); }
      var src = s.source;
      $('st-sharedsrc').textContent = src && src.title
        ? 'Typed from ' + src.title + (src.author ? ' — ' + src.author : '') + '.' : '';
      show($('st-sharedfrom'), true); show($('st-play'), true);
      show($('st-share'), false);
      return ingest(s.events, { session: (s.events[0] || {}).session || m[1], source: 'share' });
    }).catch(function (e) {
      show($('st-sharedfrom'), true);
      $('st-sharedsrc').textContent = 'This link does not open a piece (' + e.message + ').';
    });
  }
})();
