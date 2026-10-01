(function () {
  'use strict';
  var root = document.getElementById('view');
  var TYPES = { written: '필답형', practical: '작업형' };

  /* ───────── 저장소 ───────── */
  var KEY = 'ise.v1';
  var mem = null;
  function blank() {
    return { added: { written: [], practical: [] }, wrong: {}, mockRes: {}, bookmarks: {}, solved: {}, settings: { apiKey: '', model: 'claude-sonnet-5', rate: 1 } };
  }
  function load() {
    var d = blank();
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw) {
        d.added.written = (raw.added && raw.added.written) || [];
        d.added.practical = (raw.added && raw.added.practical) || [];
        d.wrong = raw.wrong || {};
        d.mockRes = raw.mockRes || {};
        d.bookmarks = raw.bookmarks || {};
        d.solved = raw.solved || {};
        d.settings = Object.assign(d.settings, raw.settings || {});
      }
    } catch (e) { if (mem) return mem; }
    return d;
  }
  var store = load();
  function save() {
    mem = store;
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  }

  /* ───────── 유틸 ───────── */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ansHTML(a) {
    // 줄마다 <span class="ln">으로 감싸 음성 듣기 때 읽는 줄을 하이라이트한다
    return String(a).split('\n').map(function (line) {
      return '<span class="ln">' + esc(line).replace(/\{\{([^}]+)\}\}/g, function (m, g) { return '<mark>' + g.split('|')[0].trim() + '</mark>'; }) + '</span>';
    }).join('\n');
  }
  function hasBlanks(q) { return /\{\{[^}]+\}\}/.test(q.a); }
  function mockAll() {
    var a = [];
    [1, 2, 3, 4, 5].forEach(function (n) { a = a.concat(QDATA.mock[n] || []); });
    return a;
  }
  function mockOpts(sel) {
    return [1, 2, 3, 4, 5].map(function (n) {
      return '<option value="mock:' + n + '"' + (sel === 'mock:' + n ? ' selected' : '') + '>모의고사 ' + n + '회</option>';
    }).join('');
  }
  function subjOk(q, subj) {
    if (!subj) return true;
    if (subj.indexOf('mock:') === 0) return String(q.mock) === subj.slice(5);
    return q.subject === subj;
  }
  function mockPAll() {
    var a = [];
    [1, 2, 3, 4, 5].forEach(function (n) { a = a.concat(QDATA.mockP[n] || []); });
    return a;
  }
  /* 모의고사 문항은 퀴즈·오답노트·목록과 별개로 관리한다 */
  function getList(type) { return QDATA[type].concat(store.added[type]); }
  function findQ(id) {
    var all = getList('written').concat(getList('practical'), mockAll(), mockPAll());
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function isBM(id) { return !!store.bookmarks[id]; }
  function toggleBM(id) {
    if (store.bookmarks[id]) delete store.bookmarks[id]; else store.bookmarks[id] = Date.now();
    save(); updateFAB();
  }
  function bmBtnHTML(id, withLabel) {
    var on = isBM(id);
    return '<button class="bmbtn' + (on ? ' on' : '') + '" data-bm="' + id + '" aria-label="책갈피" title="책갈피">' +
      (on ? '★' : '☆') + (withLabel ? ' 책갈피' : '') + '</button>';
  }
  function qNo(q) {
    if (q.mock) return 'M' + q.mock + '-' + (QDATA.mock[q.mock].indexOf(q) + 1);
    if (q.user) return 'U' + (store.added[q.type].indexOf(q) + 1);
    return String(QDATA[q.type].indexOf(q) + 1);
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }
  function subjects(type) {
    var s = [];
    getList(type).forEach(function (q) { if (s.indexOf(q.subject) < 0) s.push(q.subject); });
    return s;
  }
  function opts(arr, sel) {
    return arr.map(function (v) { return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
  }

  /* ───────── 메뉴 ───────── */
  var ROUTES = [
    { id: 'written', plate: '01', label: '필답형', view: function () { viewList('written'); }, cnt: function () { return QDATA.written.length + store.added.written.length; } },
    { id: 'practical', plate: '02', label: '작업형', view: function () { viewList('practical'); }, cnt: function () { return getList('practical').length; } },
    { id: 'mock', plate: '03', label: '모의고사', view: viewMock, cnt: function () { return mockAll().length + mockPAll().length; } },
    { id: 'gen', plate: '04', label: '문제생성', view: viewGen, cnt: function () { return ''; } },
    { id: 'quiz', plate: '05', label: '퀴즈', view: function () { viewQuiz('quiz'); }, cnt: function () { return getList('written').filter(hasBlanks).length + getList('practical').filter(hasBlanks).length; } },
    { id: 'note', plate: '06', label: '오답노트', view: function () { viewQuiz('note'); }, cnt: function () { return Object.keys(store.wrong).filter(function (id) { return findQ(id); }).length; } },
    { id: 'bookmarks', plate: '07', label: '북마크', view: viewBookmarks, cnt: function () { return Object.keys(store.bookmarks).length; } }
  ];
  function drawNav(cur) {
    document.getElementById('nav').innerHTML = ROUTES.map(function (r) {
      return '<a href="#' + r.id + '" class="' + (r.id === cur ? 'on' : '') + '"><span class="plate">' + r.plate + '</span><span>' + r.label + '</span><span class="cnt">' + r.cnt() + '</span></a>';
    }).join('');
  }
  function route() {
    var id = (location.hash || '#written').slice(1);
    var r = ROUTES.filter(function (x) { return x.id === id; })[0] || ROUTES[0];
    clearInterval(mockUI.timer);
    if (!floatState.auto) stopSpeak();
    if (r.id === 'written') keyNew = true; // 메인에 들어올 때마다 핵심 암기 새로 뽑기
    drawNav(r.id);
    r.view();
    updateFAB();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  function head(title, sub, right) {
    return '<div class="head"><div><h1>' + title + '</h1><p>' + sub + '</p></div><div>' + (right || '') + '</div></div>';
  }

  /* ───────── 필답형 / 작업형 목록 ───────── */
  var listUI = {};
  function spkBtnsHTML(id) {
    return '<button class="sm spk" data-spk="' + id + ':q" title="문제 듣기">🔊문제</button>' +
      '<button class="sm spk" data-spk="' + id + ':a" title="정답 듣기">🔊정답</button>';
  }
  var listRowBlanks = {};
  function blankRow(type, q) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-id', q.id);
    var extra = hasBlanks(q);
    var abHTML = '';
    tr.innerHTML = '<td class="no">' + qNo(q) + '</td>' +
      '<td class="sj">' + iconFor(q.subject) + '<span class="subj-chip">' + esc(q.subject) + '</span></td>' +
      '<td class="q">' + esc(q.q) + '</td>' +
      '<td class="a"><div class="blankslot" id="bs-' + q.id + '"></div>' +
      (!extra ? '<div class="ans">' + ansHTML(q.a) + '</div>' : '') +
      '<div class="rowbtns">' + (extra ? '<button class="sm pri" data-grade="' + q.id + '">채점</button>' : '') +
      spkBtnsHTML(q.id) + bmBtnHTML(q.id, true) +
      (q.user ? '<button class="sm danger" data-del="' + q.id + '">삭제</button>' : '') + '</div>' +
      (extra ? '<div class="reveal-inline"></div>' : '') + '</td>';
    if (extra) {
      var ab = buildAnswer(q);
      listRowBlanks[q.id] = ab.blanks;
      tr.querySelector('#bs-' + q.id).appendChild(ab.box);
    }
    return tr;
  }
  function fullRow(q) {
    return '<tr data-id="' + q.id + '"><td class="no">' + qNo(q) + '</td><td class="sj">' + iconFor(q.subject) + '<span class="subj-chip">' + esc(q.subject) + '</span></td>' +
      '<td class="q">' + esc(q.q) + '</td><td class="a"><div class="ans">' + ansHTML(q.a) + '</div><div class="hint-hide">클릭하면 정답이 보입니다</div>' +
      '<div class="rowbtns">' + spkBtnsHTML(q.id) + bmBtnHTML(q.id, true) + (q.user ? '<button class="sm danger" data-del="' + q.id + '">삭제</button>' : '') + '</div></td></tr>';
  }
  /* ───────── 메인 페이지: 오늘의 핵심 암기(필답형 1 + 작업형 1) ─────────
     메인(#written)에 들어올 때마다 새로 뽑는다. 최근에 보여 준 문항은 한동안 제외. */
  var keyPick = null, keyNew = true;
  function pickKey(type) {
    var base = QDATA[type], rk = 'ise.keyRecent.' + type, recent = [];
    try { recent = JSON.parse(localStorage.getItem(rk) || '[]'); } catch (e) {}
    var pool = base.filter(function (q) { return recent.indexOf(q.id) < 0; });
    if (!pool.length) pool = base;
    var q = pool[Math.floor(Math.random() * pool.length)];
    recent.push(q.id); recent = recent.slice(-Math.min(30, Math.max(1, base.length - 1)));
    try { localStorage.setItem(rk, JSON.stringify(recent)); } catch (e) {}
    return q;
  }
  function kcHTML(type, q) {
    return '<article class="kc" data-id="' + q.id + '"><div class="kc-h"><span class="kc-type">' + TYPES[type] + '</span>' + iconFor(q.subject) +
      '<span class="kc-sub">' + esc(q.subject) + ' · No.' + qNo(q) + '</span></div>' +
      '<p class="kc-q">' + esc(q.q) + '</p><div class="kc-a">' + ansHTML(q.a) + '</div>' +
      '<div class="kc-btns"><button class="sm pri spk" data-spk="' + q.id + ':qa" title="문제·정답 듣기">🔊 듣기</button>' + bmBtnHTML(q.id, true) +
      '<button class="sm" data-kcnext="' + type + '" title="다른 핵심 내용 보기">다른 내용 ↻</button></div></article>';
  }
  function keyPanelHTML() {
    if (keyNew || !keyPick) { keyPick = { written: pickKey('written'), practical: pickKey('practical') }; keyNew = false; }
    return '<section class="keyzone" id="keyzone" aria-label="오늘의 핵심 암기"><div class="keyzone-h"><b>오늘의 핵심 암기</b>' +
      '<span class="meta">접속할 때마다 필답형·작업형 1개씩 바뀝니다 · 🔊 듣기로 읽는 줄을 따라가며 외워 보세요</span></div>' +
      '<div class="keygrid">' + kcHTML('written', keyPick.written) + kcHTML('practical', keyPick.practical) + '</div></section>';
  }
  function bindKeyPanel() {
    var z = document.getElementById('keyzone'); if (!z) return;
    z.addEventListener('click', function (e) {
      var n = e.target.closest('[data-kcnext]');
      if (n) {
        var t = n.getAttribute('data-kcnext'), card = n.closest('.kc');
        if (card.classList.contains('speaking')) stopSpeak();
        keyPick[t] = pickKey(t); card.outerHTML = kcHTML(t, keyPick[t]); return;
      }
      var bm = e.target.closest('[data-bm]');
      if (bm) { toggleBM(bm.getAttribute('data-bm')); bm.outerHTML = bmBtnHTML(bm.getAttribute('data-bm'), true); drawNav('written'); }
    });
  }
  function viewList(type) {
    var ui = listUI[type] || (listUI[type] = { q: '', subj: '', hide: false, mode: 'blank' });
    var base = QDATA[type];
    root.innerHTML = (type === 'written' ? keyPanelHTML() : '') +
      head(TYPES[type] + ' 예상문제', type === 'written'
        ? '과목별 필답형 예상문제. 정답의 핵심어를 괄호 안 빈칸에 채워 넣으며 익힙니다. 🔊 버튼으로 듣거나 “전체 듣기”로 이어 들을 수 있습니다.'
        : '영상 상황형 작업형 예상문제. 위험요인·안전조치의 핵심어를 괄호 안 빈칸에 채워 넣으며 익힙니다. 🔊 버튼으로 듣거나 “전체 듣기”로 이어 들을 수 있습니다.',
        '<span class="tag">' + base.length + '문항</span>') +
      '<div class="seg seg-mode" id="lmode"><button data-m="blank" class="' + (ui.mode === 'blank' ? 'on' : '') + '">괄호 넣기</button><button data-m="full" class="' + (ui.mode === 'full' ? 'on' : '') + '">정답 전체보기</button></div>' +
      '<div class="bar">' +
      '<input type="search" id="fq" class="grow" placeholder="문제·정답 검색" value="' + esc(ui.q) + '">' +
      '<select id="fs"><option value="">전체 과목</option>' + opts(subjects(type), ui.subj) + '</select>' +
      (ui.mode === 'full' ? '<label class="chk"><input type="checkbox" id="fh"' + (ui.hide ? ' checked' : '') + '> 정답 가리기</label>' : '') +
      '<button class="sm" id="playAll" title="지금 표시된 문제를 문제→정답 순서로 이어 듣습니다">▶ 전체 듣기</button>' +
      '<button class="sm" id="playBM" title="이 화면에서 북마크한 문제만 이어 듣습니다">★ 북마크만 듣기</button>' +
      '<button class="sm rep-btn" data-rep title="한 문제를 몇 번 반복해서 읽을지 정합니다(누르면 1→3→5→10회)">' + repLabel() + '</button>' +
      '<span class="meta" id="fc"></span></div>' +
      '<div class="wrap"><table class="tbl list' + (ui.mode === 'full' && ui.hide ? ' hide' : '') + '" id="tb"><thead><tr><th>No</th><th>과목</th><th>문제</th><th>' + (ui.mode === 'blank' ? '괄호 넣기' : '정답') + '</th></tr></thead><tbody id="tbody"></tbody></table></div>';

    function computeLists() {
      var kw = ui.q.trim().toLowerCase();
      var pass = function (q) {
        return subjOk(q, ui.subj) && (!kw || (q.q + ' ' + q.a).toLowerCase().indexOf(kw) >= 0);
      };
      return { main: base.filter(pass), user: store.added[type].filter(pass) };
    }
    function draw() {
      var L = computeLists(), main = L.main, user = L.user;
      var tbody = document.getElementById('tbody');
      if (!main.length && !user.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty">조건에 맞는 문제가 없습니다.</td></tr>';
      } else if (ui.mode === 'blank') {
        listRowBlanks = {};
        tbody.innerHTML = '';
        var frag = document.createDocumentFragment();
        main.forEach(function (q) { frag.appendChild(blankRow(type, q)); });
        if (user.length) {
          var sec = document.createElement('tr'); sec.className = 'sec';
          sec.innerHTML = '<td colspan="4">[사용자추가] <span class="meta" style="color:#111">' + store.added[type].length + '문항</span></td>';
          frag.appendChild(sec);
          user.forEach(function (q) { frag.appendChild(blankRow(type, q)); });
        }
        tbody.appendChild(frag);
      } else {
        var h = main.map(fullRow).join('');
        if (user.length) h += '<tr class="sec"><td colspan="4">[사용자추가] <span class="meta" style="color:#111">' + store.added[type].length + '문항</span></td></tr>' + user.map(fullRow).join('');
        tbody.innerHTML = h;
      }
      document.getElementById('fc').textContent = (main.length + user.length) + '개 표시';
    }
    draw();
    if (type === 'written') bindKeyPanel();
    document.getElementById('playAll').addEventListener('click', function () {
      var L = computeLists(), ids = L.main.concat(L.user).map(function (q) { return q.id; });
      openFloat(ids, ids[0], true);
    });
    document.getElementById('playBM').addEventListener('click', function () {
      var L = computeLists(), ids = L.main.concat(L.user).filter(function (q) { return isBM(q.id); }).map(function (q) { return q.id; });
      if (!ids.length) { toast('북마크한 문제가 없습니다. ☆ 책갈피 버튼으로 먼저 담아보세요.'); return; }
      openFloat(ids, ids[0], true);
    });
    document.getElementById('lmode').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-m]'); if (!b) return;
      ui.mode = b.getAttribute('data-m'); viewList(type);
    });
    document.getElementById('fq').addEventListener('input', function (e) { ui.q = e.target.value; draw(); });
    document.getElementById('fs').addEventListener('change', function (e) { ui.subj = e.target.value; draw(); });
    var fh = document.getElementById('fh');
    if (fh) fh.addEventListener('change', function (e) {
      ui.hide = e.target.checked;
      document.getElementById('tb').classList.toggle('hide', ui.hide);
    });
    document.getElementById('tbody').addEventListener('click', function (e) {
      var g = e.target.closest('[data-grade]');
      if (g) {
        var gid = g.getAttribute('data-grade'), blanks = listRowBlanks[gid], q = findQ(gid);
        if (!blanks || !q) return;
        var okc = gradeBlanks(q, blanks), all = okc === blanks.length;
        blanks.forEach(function (b) { b.inp.classList.toggle('ok', b.ok); b.inp.classList.toggle('ng', !b.ok); });
        var rv = g.closest('tr').querySelector('.reveal-inline');
        rv.className = 'reveal-inline ' + (all ? 'ok' : 'ng');
        rv.textContent = (all ? '정답입니다! ' : '오답이 있습니다. ') + okc + ' / ' + blanks.length + ' 빈칸';
        return;
      }
      var bm = e.target.closest('[data-bm]');
      if (bm) {
        toggleBM(bm.getAttribute('data-bm'));
        bm.outerHTML = bmBtnHTML(bm.getAttribute('data-bm'), true);
        drawNav(type); return;
      }
      var d = e.target.closest('[data-del]');
      if (d) {
        if (!confirm('이 사용자추가 문제를 삭제할까요?')) return;
        var id = d.getAttribute('data-del');
        store.added[type] = store.added[type].filter(function (q) { return q.id !== id; });
        delete store.wrong[id]; delete store.bookmarks[id]; save(); drawNav(type); updateFAB(); viewList(type); return;
      }
      var td = e.target.closest('td.a');
      if (td && ui.mode === 'full' && ui.hide) td.parentNode.classList.toggle('shown');
    });
  }

  /* ───────── 모의고사 (필답형 / 작업형) ───────── */
  var mockUI = { type: 'written', n: 1, running: false, hide: false, only: false, t0: 0, elapsed: 0, timer: null };
  var MTYPE = {
    written: { label: '필답형', src: 'mock' },
    practical: { label: '작업형', src: 'mockP' }
  };
  function mockList(type, n) { return QDATA[MTYPE[type].src][n] || []; }
  function fmtT(ms) {
    var t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), r = t % 60;
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return (h ? h + ':' + p(m) : String(m)) + ':' + p(r);
  }
  function mockStat(type, n) {
    var o = 0, x = 0, l = mockList(type, n);
    l.forEach(function (q) { var r = store.mockRes[q.id]; if (r === 'o') o++; else if (r === 'x') x++; });
    return { o: o, x: x, t: l.length };
  }
  function viewMock() {
    var ui = mockUI, type = ui.type, n = ui.n, list = mockList(type, n), mt = MTYPE[type];
    root.innerHTML =
      head('모의고사', '시험처럼 풀어 보는 메뉴입니다(빈칸 퀴즈와는 별개). 필답형은 회당 20문항, 작업형은 영상 상황형 회당 10문항이며 “시작”을 누르면 정답을 가리고 시간을 잽니다. 끝나면 정답을 확인하고 문항별로 맞음/틀림을 표시해 채점하세요.',
        '<span class="tag">' + mt.label + ' · 5회 × ' + list.length + '문항</span>') +
      '<div class="seg seg-type" id="tseg"><button data-t="written" class="' + (type === 'written' ? 'on' : '') + '">필답형 모의고사</button><button data-t="practical" class="' + (type === 'practical' ? 'on' : '') + '">작업형 모의고사</button></div>' +
      '<div class="seg" id="seg"></div>' +
      '<div class="bar"><button class="pri" id="mstart"></button><button id="mshow">정답 확인·채점</button>' +
      '<label class="chk"><input type="checkbox" id="monly"' + (ui.only ? ' checked' : '') + '> 틀린 문제만</label>' +
      '<button class="danger sm" id="mreset">채점 초기화</button><span class="meta" id="mtime"></span></div>' +
      '<div class="stat" id="msum" style="margin-bottom:12px"></div>' +
      '<div class="wrap"><table class="tbl list" id="tb"><thead><tr><th>No</th><th>' + (type === 'written' ? '과목' : '분야') + '</th><th>문제</th><th>정답 · 채점</th></tr></thead><tbody id="tbody"></tbody></table></div>';

    function drawSeg() {
      document.getElementById('seg').innerHTML = [1, 2, 3, 4, 5].map(function (k) {
        var s = mockStat(type, k);
        return '<button data-n="' + k + '" class="' + (k === n ? 'on' : '') + '">' + k + '회<small>' + s.o + '/' + s.t + '</small></button>';
      }).join('');
    }
    function drawSum() {
      var s = mockStat(type, n), un = s.t - s.o - s.x;
      document.getElementById('msum').innerHTML = mt.label + ' ' + n + '회 — 맞음 <b>' + s.o + '</b> · 틀림 <b>' + s.x + '</b> · 미채점 <b>' + un + '</b> · 정답률 <b>' + Math.round(s.o / s.t * 100) + '%</b>';
    }
    function drawTime() {
      var el = document.getElementById('mtime');
      if (ui.running) el.textContent = '경과 ' + fmtT(Date.now() - ui.t0);
      else el.textContent = ui.elapsed ? '소요 ' + fmtT(ui.elapsed) : '';
    }
    function drawBtns() {
      document.getElementById('mstart').textContent = ui.running ? '다시 시작' : '모의고사 시작';
      document.getElementById('tb').classList.toggle('hide', ui.hide);
      drawTime();
    }
    function row(q, i) {
      var r = store.mockRes[q.id] || '';
      return '<tr data-id="' + q.id + '" class="' + (r ? 'r-' + r : '') + '"><td class="no">' + (i + 1) + '</td><td class="sj">' + iconFor(q.subject) + '<span class="subj-chip">' + esc(q.subject) + '</span></td>' +
        '<td class="q">' + esc(q.q) + '</td><td class="a"><div class="ans">' + ansHTML(q.a) + '</div><div class="hint-hide">클릭하면 정답이 보입니다</div>' +
        '<div class="mk"><button class="o' + (r === 'o' ? ' on' : '') + '" data-mk="o">맞음</button><button class="x' + (r === 'x' ? ' on' : '') + '" data-mk="x">틀림</button>' +
        '<button class="spk" data-spk="' + q.id + ':qa" title="문제·정답 듣기">🔊</button>' + bmBtnHTML(q.id, false) + '</div></td></tr>';
    }
    function drawRows() {
      var h = '';
      list.forEach(function (q, i) { if (!ui.only || store.mockRes[q.id] === 'x') h += row(q, i); });
      if (!h) h = '<tr><td colspan="4" class="empty">' + (ui.only ? '틀림으로 표시한 문제가 없습니다.' : '문제가 없습니다.') + '</td></tr>';
      document.getElementById('tbody').innerHTML = h;
    }
    function startTimer() { clearInterval(ui.timer); ui.timer = setInterval(drawTime, 1000); }
    function resetState() { clearInterval(ui.timer); ui.running = false; ui.hide = false; ui.elapsed = 0; ui.only = false; }

    drawRows(); drawSeg(); drawSum(); drawBtns();
    if (ui.running) startTimer();

    document.getElementById('tseg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-t]'); if (!b) return;
      resetState(); ui.type = b.getAttribute('data-t'); ui.n = 1; viewMock();
    });
    document.getElementById('seg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-n]'); if (!b) return;
      resetState(); ui.n = parseInt(b.getAttribute('data-n'), 10); viewMock();
    });
    document.getElementById('mstart').addEventListener('click', function () {
      ui.running = true; ui.hide = true; ui.only = false; ui.t0 = Date.now(); ui.elapsed = 0;
      document.getElementById('monly').checked = false; drawRows();
      startTimer(); drawBtns(); toast(mt.label + ' ' + n + '회 시작! 정답을 가리고 시간을 잽니다.');
      window.scrollTo(0, 0);
    });
    document.getElementById('mshow').addEventListener('click', function () {
      if (ui.running) { ui.elapsed = Date.now() - ui.t0; ui.running = false; clearInterval(ui.timer); toast('소요 시간 ' + fmtT(ui.elapsed)); }
      ui.hide = false; drawBtns();
    });
    document.getElementById('monly').addEventListener('change', function (e) { ui.only = e.target.checked; drawRows(); });
    document.getElementById('mreset').addEventListener('click', function () {
      if (!confirm(mt.label + ' ' + n + '회 채점 기록을 초기화할까요?')) return;
      list.forEach(function (q) { delete store.mockRes[q.id]; });
      save(); viewMock();
    });
    document.getElementById('tbody').addEventListener('click', function (e) {
      var bm = e.target.closest('[data-bm]');
      if (bm) { toggleBM(bm.getAttribute('data-bm')); bm.outerHTML = bmBtnHTML(bm.getAttribute('data-bm'), false); drawNav('bookmarks'); return; }
      var mk = e.target.closest('button[data-mk]');
      if (mk) {
        var tr = mk.closest('tr'), id = tr.getAttribute('data-id'), v = mk.getAttribute('data-mk');
        if (store.mockRes[id] === v) delete store.mockRes[id]; else store.mockRes[id] = v;
        save();
        var cur = store.mockRes[id] || '';
        tr.className = (cur ? 'r-' + cur : '') + (tr.classList.contains('shown') ? ' shown' : '');
        tr.querySelector('button.o').classList.toggle('on', cur === 'o');
        tr.querySelector('button.x').classList.toggle('on', cur === 'x');
        drawSeg(); drawSum();
        return;
      }
      var td = e.target.closest('td.a');
      if (td && ui.hide) td.parentNode.classList.toggle('shown');
    });
  }

  /* ───────── 문제생성 ───────── */
  var genState = { type: 'written', q: '', a: '' };
  var SYS = {
    written: '당신은 한국 산업안전기사 실기(필답형) 시험 전문 강사입니다. 사용자가 입력한 문제에 대해 시험 답안 형식으로 정답을 작성하세요. ' +
      '산업안전보건법령·산업안전보건기준에 관한 규칙 등의 수치와 기준을 정확히 쓰고, 항목이 여러 개면 ①②③ 번호를 붙여 줄바꿈하세요. ' +
      '계산 문제는 식과 결과를 함께 쓰세요. 서론, 마크다운 기호(**, #)는 쓰지 마세요. ' +
      '퀴즈 빈칸용으로 핵심 용어와 수치는 {{핵심어}} 형태로 감싸고, 인정되는 다른 표현이 있으면 {{정답|다른표현}}으로 쓰세요. 답안 본문만 출력하세요.',
    practical: '당신은 한국 산업안전기사 실기(작업형) 시험 전문 강사입니다. 사용자가 입력한 영상 상황 또는 문제에 대해 시험 답안 형식으로 작성하세요. ' +
      '반드시 "▶ 위험요인 :" 한 줄과 "▶ 안전조치 :" 항목(①②③ 번호, 줄바꿈)으로 구성하고, 관련 법령 수치·기준은 정확히 쓰세요. ' +
      '서론과 마크다운 기호(**, #)는 쓰지 마세요. ' +
      '퀴즈 빈칸용으로 핵심 용어와 수치는 {{핵심어}} 형태로 감싸세요. 답안 본문만 출력하세요.'
  };
  function viewGen() {
    var s = store.settings;
    root.innerHTML =
      head('문제생성', '문제를 입력하면 Claude가 정답을 만들고, 원하는 목록 하단의 [사용자추가]에 넣을 수 있습니다.') +
      '<div class="grid2">' +
      '<section class="card"><h2><span class="n">1</span>문제 입력</h2>' +
      '<div class="bar" style="margin-bottom:10px"><select id="gt"><option value="written">필답형</option><option value="practical">작업형</option></select></div>' +
      '<textarea id="gq" rows="4" placeholder="예) 산업안전보건법령상 안전보건관리책임자의 업무 5가지를 쓰시오.">' + esc(genState.q) + '</textarea>' +
      '<div class="row"><button class="pri" id="gs">send</button><span class="status" id="gst"></span></div></section>' +
      '<section class="card"><h2><span class="n">2</span>정답 표시란</h2>' +
      '<textarea id="ga" rows="10" placeholder="send를 누르면 정답이 여기에 표시됩니다. 직접 수정하거나 직접 입력할 수도 있습니다.">' + esc(genState.a) + '</textarea>' +
      '<div class="row"><button class="dark" id="gadd">문제목록추가</button><span class="note">선택한 유형의 목록 하단 [사용자추가]에 등록됩니다.</span></div></section>' +
      '</div>' +
      '<details class="set" open><summary>🔊 음성 읽기 속도</summary>' +
      '<div class="field"><label for="rateSel">문제·정답을 읽어줄 때의 속도</label>' +
      '<select id="rateSel">' + RATES.map(function (r) { return '<option value="' + r + '"' + (r === (s.rate || 1) ? ' selected' : '') + '>' + r + '배속</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="repSel">반복 듣기(한 문제를 이어서 읽는 횟수)</label>' +
      '<select id="repSel">' + REPEATS.map(function (n) { return '<option value="' + n + '"' + (n === repeatCount() ? ' selected' : '') + '>' + (n === 1 ? '1회(반복 안 함)' : n + '회 반복') + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="voiceSel">목소리</label><select id="voiceSel"></select></div>' +
      '<div class="row"><button class="sm" id="voiceTest">🔊 들어 보기</button><span class="note">"방호장치 4가지, 2~3m, 1:29:300"을 "네 가지, 2에서 3 미터, 1 대 29 대 300"처럼 읽습니다.</span></div>' +
      '<p class="note">필답형·작업형·퀴즈·북마크·화면 위 고정 보기 창의 🔊 버튼과 전체 듣기에 모두 적용됩니다. 고정 보기 창의 속도 버튼(예: 1x)을 눌러도 바뀝니다. 목소리 목록은 기기·브라우저마다 다르며, Edge의 "Natural", 크롬의 "Google 한국의" 음성이 가장 자연스럽습니다.</p></details>' +
      '<details class="set"' + (s.apiKey ? '' : ' open') + '><summary>Claude 연결 설정 · 데이터 백업</summary>' +
      '<div class="field"><label for="gk">Anthropic API 키</label><input type="password" id="gk" autocomplete="off" placeholder="sk-ant-..." value="' + esc(s.apiKey) + '"></div>' +
      '<div class="field"><label for="gm">모델</label><input type="text" id="gm" value="' + esc(s.model) + '"></div>' +
      '<p class="note">API 키는 이 브라우저의 저장소에만 보관되며, send를 누를 때 Anthropic API로만 전송됩니다. 키 없이도 정답표시란에 직접 입력해 추가할 수 있습니다.</p>' +
      '<div class="row"><button id="gsave">설정 저장</button><button id="gexp">백업 내려받기</button><button id="gimp">백업 불러오기</button><input type="file" id="gfile" accept="application/json" hidden></div></details>';

    document.getElementById('gt').value = genState.type;
    document.getElementById('rateSel').addEventListener('change', function (e) { setSpeechRate(parseFloat(e.target.value)); toast('음성 속도를 ' + e.target.value + '배속으로 저장했습니다.'); });
    fillVoiceSel();
    document.getElementById('repSel').addEventListener('change', function (e) { setRepeat(parseInt(e.target.value, 10)); toast(repeatCount() > 1 ? '한 문제를 ' + repeatCount() + '번 반복해서 읽습니다.' : '반복 듣기를 껐습니다.'); });
    document.getElementById('voiceSel').addEventListener('change', function (e) { store.settings.voice = e.target.value; save(); toast(e.target.value ? '목소리를 저장했습니다.' : '목소리를 자동 선택으로 바꿨습니다.'); });
    document.getElementById('voiceTest').addEventListener('click', function (e) {
      var q = { id: '_test', q: '크레인 방호장치 4가지를 쓰시오.', a: '작업발판 폭 40cm 이상, 난간 간격 2~3m, 재해 비율 1:29:300' };
      if (e.currentTarget.classList.contains('playing')) { stopSpeak(); return; }
      speakQ(q, 'qa', null, null, e.currentTarget);
    });
    var st = document.getElementById('gst');
    function setStatus(msg, err) { st.className = 'status' + (err ? ' err' : ''); st.innerHTML = msg; }
    document.getElementById('gt').addEventListener('change', function (e) { genState.type = e.target.value; });
    document.getElementById('gq').addEventListener('input', function (e) { genState.q = e.target.value; });
    document.getElementById('ga').addEventListener('input', function (e) { genState.a = e.target.value; });

    document.getElementById('gsave').addEventListener('click', function () {
      store.settings.apiKey = document.getElementById('gk').value.trim();
      store.settings.model = document.getElementById('gm').value.trim() || 'claude-sonnet-5';
      save(); toast('설정을 저장했습니다.');
    });
    document.getElementById('gs').addEventListener('click', function () {
      var q = genState.q.trim();
      if (!q) { setStatus('문제를 입력하세요.', true); return; }
      var key = document.getElementById('gk').value.trim() || store.settings.apiKey;
      if (!key) { setStatus('API 키가 없습니다. 아래 설정에 입력하거나 정답을 직접 입력하세요.', true); document.querySelector('details.set').open = true; return; }
      store.settings.apiKey = key; store.settings.model = document.getElementById('gm').value.trim() || store.settings.model; save();
      var btn = document.getElementById('gs'); btn.disabled = true;
      setStatus('<span class="spin"></span>Claude가 정답을 작성 중입니다…');
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': key,
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: store.settings.model, max_tokens: 1200, system: SYS[genState.type],
          messages: [{ role: 'user', content: q }]
        })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error((res.j && res.j.error && res.j.error.message) || '요청에 실패했습니다.');
          var text = (res.j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
          if (!text) throw new Error('빈 응답이 반환되었습니다.');
          genState.a = text; document.getElementById('ga').value = text; setStatus('정답이 생성되었습니다. 필요하면 수정한 뒤 추가하세요.');
        })
        .catch(function (e) { setStatus('오류: ' + esc(e.message), true); })
        .then(function () { btn.disabled = false; });
    });
    document.getElementById('gadd').addEventListener('click', function () {
      var q = genState.q.trim(), a = genState.a.trim(), type = genState.type;
      if (!q || !a) { toast('문제와 정답을 모두 입력하세요.'); return; }
      if (getList(type).some(function (x) { return x.q === q; })) { toast('이미 같은 문제가 목록에 있습니다.'); return; }
      store.added[type].push({ id: 'U' + Date.now().toString(36), type: type, subject: '사용자추가', q: q, a: a, unordered: false, user: true });
      save(); drawNav('gen');
      toast(TYPES[type] + ' 목록 하단 [사용자추가]에 추가했습니다.');
      genState.q = ''; genState.a = '';
      document.getElementById('gq').value = ''; document.getElementById('ga').value = ''; setStatus('');
    });
    document.getElementById('gexp').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'safety-exam-backup.json'; a.click();
    });
    document.getElementById('gimp').addEventListener('click', function () { document.getElementById('gfile').click(); });
    document.getElementById('gfile').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          store.added = { written: (d.added && d.added.written) || [], practical: (d.added && d.added.practical) || [] };
          store.wrong = d.wrong || {}; store.mockRes = d.mockRes || {}; save(); drawNav('gen'); toast('백업을 불러왔습니다.');
        } catch (err) { toast('올바른 백업 파일이 아닙니다.'); }
      };
      rd.readAsText(f);
    });
  }

  /* ───────── 퀴즈 / 오답노트 ───────── */
  var quizUI = {
    quiz: { type: 'written', levelByType: { written: 1, practical: 1 }, pool: null, i: 0, tried: 0, correct: 0 },
    note: { type: 'written', subj: '', rand: false, pool: null, i: 0, tried: 0, correct: 0 }
  };
  function norm(s) { return String(s).toLowerCase().replace(/[\s·・,.\-()\[\]「」'"“”‘’~∙:;]/g, ''); }

  /* 퀴즈 레벨 : 기본 100문항을 원래 순서대로 20개씩 5레벨로 나눈다 */
  var LEVEL_SIZE = 20;
  /* 문항이 늘면 레벨이 자동으로 늘어난다. 마지막 남는 문항이 10개 미만이면 마지막 레벨에 합친다 */
  function levelCount(type) { var n = QDATA[type].length; return Math.max(1, n % LEVEL_SIZE >= LEVEL_SIZE / 2 ? Math.ceil(n / LEVEL_SIZE) : Math.floor(n / LEVEL_SIZE)); }
  function baseLevels(type) {
    var base = QDATA[type], out = [];
    for (var i = 0, lc = levelCount(type); i < lc; i++) {
      out.push(base.slice(i * LEVEL_SIZE, i === lc - 1 ? base.length : (i + 1) * LEVEL_SIZE).map(function (q) { return q.id; }));
    }
    return out;
  }
  function levelIds(type, lv) { return lv === 'bonus' ? store.added[type].filter(hasBlanks).map(function (q) { return q.id; }) : (baseLevels(type)[lv - 1] || []); }
  function levelSolvedCount(type, lv) {
    var ids = levelIds(type, lv);
    return ids.filter(function (id) { return !!store.solved[id]; }).length;
  }
  function levelComplete(type, lv) {
    var ids = levelIds(type, lv);
    return ids.length > 0 && ids.every(function (id) { return !!store.solved[id]; });
  }
  function levelUnlocked(type, lv) {
    if (lv === 'bonus' || lv <= 1) return true;
    return levelComplete(type, lv - 1);
  }

  function buildPool(mode) {
    var ui = quizUI[mode];
    if (mode === 'quiz') {
      ui.pool = shuffle(levelIds(ui.type, ui.levelByType[ui.type]));
      ui.i = 0;
      return;
    }
    var ids = getList(ui.type).filter(function (q) {
      return hasBlanks(q) && subjOk(q, ui.subj) && store.wrong[q.id];
    }).map(function (q) { return q.id; });
    ui.pool = ui.rand ? shuffle(ids) : ids;
    ui.i = 0;
  }

  function buildAnswer(q) {
    var box = document.createElement('div'); box.className = 'ans-box';
    var blanks = [];
    q.a.split('\n').forEach(function (line) {
      var d = document.createElement('div'); d.className = 'ans-line';
      var last = 0, m, re = /\{\{([^}]+)\}\}/g;
      while ((m = re.exec(line))) {
        d.appendChild(document.createTextNode(line.slice(last, m.index)));
        var accepts = m[1].split('|').map(function (s) { return s.trim(); });
        var inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'blank'; inp.autocomplete = 'off'; inp.spellcheck = false;
        var w = Math.max.apply(null, accepts.map(function (s) { return s.length; }));
        inp.style.width = Math.min(Math.max(w * 1.9 + 3, 6), 34) + 'ch';
        inp.style.maxWidth = '68vw';
        var b = { inp: inp, accepts: accepts, corr: null };
        blanks.push(b);
        d.appendChild(document.createTextNode('('));
        d.appendChild(inp);
        d.appendChild(document.createTextNode(')'));
        last = m.index + m[0].length;
      }
      d.appendChild(document.createTextNode(line.slice(last)));
      box.appendChild(d);
    });
    return { box: box, blanks: blanks };
  }

  function gradeBlanks(q, blanks) {
    var ok = 0;
    if (q.unordered) {
      var used = {};
      blanks.forEach(function (b) {
        var v = norm(b.inp.value), hit = -1;
        if (v) for (var j = 0; j < blanks.length; j++) {
          if (!used[j] && blanks[j].accepts.some(function (a) { return norm(a) === v; })) { hit = j; break; }
        }
        if (hit >= 0) used[hit] = true;
        b.ok = hit >= 0;
      });
    } else {
      blanks.forEach(function (b) {
        var v = norm(b.inp.value);
        b.ok = !!v && b.accepts.some(function (a) { return norm(a) === v; });
      });
    }
    blanks.forEach(function (b) { if (b.ok) ok++; });
    return ok;
  }

  function levelBtnsHTML(type, curLv) {
    var html = '';
    for (var n = 1; n <= levelCount(type); n++) {
      var unlocked = levelUnlocked(type, n), complete = levelComplete(type, n);
      var cls = (n === curLv ? 'on' : '') + (unlocked ? '' : ' locked') + (complete ? ' done' : '');
      html += '<button data-lv="' + n + '" class="' + cls + '"' + (unlocked ? '' : ' aria-disabled="true"') + '>' +
        (unlocked ? (complete ? '✓ ' : '') : '🔒 ') + n + '레벨<small>' + levelSolvedCount(type, n) + '/' + (levelIds(type, n).length || LEVEL_SIZE) + '</small></button>';
    }
    if (store.added[type].filter(hasBlanks).length) {
      html += '<button data-lv="bonus" class="' + (curLv === 'bonus' ? 'on' : '') + '">사용자추가<small>' + levelIds(type, 'bonus').length + '</small></button>';
    }
    return html;
  }
  function viewQuiz(mode) {
    var ui = quizUI[mode];
    var isNote = mode === 'note';
    function qcount(t) {
      return getList(t).filter(function (q) { return hasBlanks(q) && (!isNote || store.wrong[q.id]); }).length;
    }
    if (isNote) {
      /* 오답노트는 들어올 때마다 최신 오답 목록으로 다시 만들고, 보던 문제는 유지 */
      var keepId = ui.pool && ui.pool[ui.i];
      buildPool(mode);
      if (keepId) { var kk = ui.pool.indexOf(keepId); if (kk >= 0) ui.i = kk; }
      /* 현재 유형에 오답이 없고 다른 유형에 있으면 그쪽으로 자동 전환 */
      var other = ui.type === 'written' ? 'practical' : 'written';
      if (!ui.pool.length && !ui.subj && qcount(other) > 0) { ui.type = other; buildPool(mode); }
    } else {
      /* 퀴즈는 이 메뉴에 들어올 때마다(레벨·유형 전환 포함) 새로 섞는다 */
      buildPool(mode);
    }
    var subs = subjects(ui.type);
    var curLv = isNote ? null : ui.levelByType[ui.type];
    root.innerHTML =
      head(TYPES[ui.type] + (isNote ? ' 오답노트' : ' 퀴즈'),
        isNote ? TYPES[ui.type] + ' 퀴즈에서 틀린 문제만 모아 다시 풉니다. 이해했다면 “오답 해제”로 목록에서 뺄 수 있습니다.'
          : (ui.type === 'written' ? '필답형 예상문제를 레벨별로 20문항씩 풉니다. 메뉴를 열 때마다 순서를 섞고, 한 레벨을 모두 맞혀야 다음 레벨이 열립니다.' : '작업형 예상문제를 레벨별로 20문항씩 풉니다. 메뉴를 열 때마다 순서를 섞고, 한 레벨을 모두 맞혀야 다음 레벨이 열립니다.'),
        '<span class="tag" id="qtag"></span>') +
      '<div class="qwrap"><div class="seg seg-type" id="qtseg">' +
      ['written', 'practical'].map(function (t) {
        return '<button data-t="' + t + '" class="' + (t === ui.type ? 'on' : '') + '">' + TYPES[t] + (isNote ? ' 오답노트' : ' 퀴즈') + '<small style="margin-left:8px">' + qcount(t) + '</small></button>';
      }).join('') + '</div>' +
      (isNote ? '' : '<div class="seg seg-level" id="qlv">' + levelBtnsHTML(ui.type, curLv) + '</div>') +
      '<div class="bar">' +
      (isNote ? '<select id="qs"><option value="">전체 과목</option>' + opts(subs, ui.subj) + '</select>' +
        '<select id="qo"><option value="seq">순서대로</option><option value="rand"' + (ui.rand ? ' selected' : '') + '>무작위</option></select>' +
        '<button class="danger sm" id="qclear">전체 해제</button>' : '') +
      '<div class="stat" id="qstat"></div></div>' +
      '<div class="prog"><i id="qbar"></i></div><div id="qbody"></div></div>';

    if (isNote) {
      document.getElementById('qs').addEventListener('change', function (e) { ui.subj = e.target.value; buildPool(mode); viewQuiz(mode); });
      document.getElementById('qo').addEventListener('change', function (e) { ui.rand = e.target.value === 'rand'; buildPool(mode); viewQuiz(mode); });
      document.getElementById('qclear').addEventListener('click', function () {
        if (!Object.keys(store.wrong).length) return;
        if (!confirm('오답노트를 모두 비울까요?')) return;
        store.wrong = {}; save(); drawNav('note'); buildPool(mode); viewQuiz(mode);
      });
    } else {
      document.getElementById('qlv').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-lv]'); if (!b) return;
        var lv = b.getAttribute('data-lv'); lv = lv === 'bonus' ? 'bonus' : parseInt(lv, 10);
        if (lv !== 'bonus' && !levelUnlocked(ui.type, lv)) { toast((lv - 1) + '레벨을 모두 맞혀야 열립니다.'); return; }
        ui.levelByType[ui.type] = lv; ui.tried = 0; ui.correct = 0;
        viewQuiz(mode);
      });
    }
    document.getElementById('qtseg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-t]'); if (!b) return;
      ui.type = b.getAttribute('data-t'); ui.subj = ''; ui.tried = 0; ui.correct = 0;
      viewQuiz(mode);
    });
    function drawLevels() {
      if (isNote) return;
      var el = document.getElementById('qlv'); if (!el) return;
      el.innerHTML = levelBtnsHTML(ui.type, ui.levelByType[ui.type]);
    }
    drawQ();

    function drawStat() {
      document.getElementById('qstat').innerHTML = '풀이 <b>' + ui.tried + '</b> · 정답 <b>' + ui.correct + '</b> · 정답률 <b>' + (ui.tried ? Math.round(ui.correct / ui.tried * 100) : 0) + '%</b>';
      document.getElementById('qtag').textContent = ui.pool.length ? (ui.i + 1) + ' / ' + ui.pool.length : '0 / 0';
      document.getElementById('qbar').style.width = ui.pool.length ? ((ui.i + 1) / ui.pool.length * 100) + '%' : '0';
    }

    function drawQ() {
      var body = document.getElementById('qbody');
      drawStat();
      if (!ui.pool.length) {
        body.innerHTML = '<div class="qcard"><div class="empty">' + (isNote
          ? '오답노트가 비어 있습니다.<br>퀴즈에서 틀린 문제는 자동으로 이곳에 담깁니다.'
          : '조건에 맞는 문제가 없습니다.') + '</div></div>';
        return;
      }
      if (ui.i >= ui.pool.length) ui.i = ui.pool.length - 1;
      if (ui.i < 0) ui.i = 0;
      var q = findQ(ui.pool[ui.i]);
      var ab = buildAnswer(q);
      var card = document.createElement('div'); card.className = 'qcard';
      card.innerHTML =
        '<div class="qh"><span>' + iconFor(q.subject) + '<span class="no">' + (q.user ? qNo(q) : 'No.' + qNo(q)) + '</span> · ' + esc(q.subject) + (q.mock ? ' · 모의고사 ' + q.mock + '회' : '') + '</span><span id="wf"></span></div>' +
        '<div class="qb"><p class="qtext">' + esc(q.q) + '</p><div id="abox"></div>' +
        '<div class="banner" id="bn"></div><div id="rv"></div>' +
        '<div class="qact"><button class="pri" id="bg">채점</button><button id="bs">정답 보기</button><button id="br">다시 풀기</button>' +
        '<button class="spk" data-spk="' + q.id + ':q" title="문제 듣기">🔊문제</button><button class="spk" data-spk="' + q.id + ':a" title="정답 듣기">🔊정답</button>' +
        '<button id="bbm"></button><button id="bw"></button></div></div>' +
        '<div class="qnav"><button id="bp">◀ 이전</button><div class="jump"><input type="number" id="bj" min="1" max="' + ui.pool.length + '" placeholder="번호"><button id="bjg" class="sm">이동</button></div><button id="bn2" class="dark">다음 ▶</button></div>';
      body.innerHTML = ''; body.appendChild(card);
      card.querySelector('#abox').appendChild(ab.box);

      var graded = false, counted = false;
      function flag() {
        var w = !!store.wrong[q.id];
        card.querySelector('#wf').innerHTML = w ? '<span class="wrongflag">오답노트 등록</span>' : '';
        card.querySelector('#bw').textContent = w ? '오답 해제' : '오답노트에 담기';
        drawNav(mode);
      }
      function flagBM() {
        var b = card.querySelector('#bbm'), on = isBM(q.id);
        b.textContent = (on ? '★' : '☆') + ' 책갈피'; b.classList.toggle('bmbtn', true); b.classList.toggle('on', on);
      }
      flag(); flagBM();
      card.querySelector('#bbm').addEventListener('click', function () { toggleBM(q.id); flagBM(); drawNav(mode); });

      function reveal() {
        card.querySelector('#rv').innerHTML = '<div class="reveal"><b>정답</b>' + ansHTML(q.a) + '</div>';
      }
      card.querySelector('#bg').addEventListener('click', function () {
        var okc = gradeBlanks(q, ab.blanks), all = okc === ab.blanks.length;
        ab.blanks.forEach(function (b) {
          b.inp.classList.toggle('ok', b.ok); b.inp.classList.toggle('ng', !b.ok);
          if (!b.ok && !q.unordered && !b.corr) {
            var s = document.createElement('span'); s.className = 'corr'; s.textContent = '(' + b.accepts[0] + ')';
            b.inp.parentNode.insertBefore(s, b.inp.nextSibling); b.corr = s;
          }
        });
        var bn = card.querySelector('#bn');
        bn.className = 'banner ' + (all ? 'ok' : 'ng');
        bn.textContent = (all ? '정답입니다! ' : '오답이 있습니다. ') + okc + ' / ' + ab.blanks.length + ' 빈칸';
        reveal();
        if (!counted) { ui.tried++; if (all) ui.correct++; counted = true; }
        if (!all && !store.wrong[q.id]) { store.wrong[q.id] = Date.now(); save(); flag(); }
        if (all) {
          var wasSolved = !!store.solved[q.id];
          if (!wasSolved) { store.solved[q.id] = Date.now(); save(); }
          if (isNote) {
            toast('정답입니다. 이해했다면 “오답 해제”를 눌러 목록에서 뺄 수 있습니다.');
          } else {
            var lvNow = ui.levelByType[ui.type];
            if (lvNow !== 'bonus' && !wasSolved && levelComplete(ui.type, lvNow)) {
              toast(lvNow < levelCount(ui.type) ? (lvNow + '레벨을 모두 맞혔습니다! ' + (lvNow + 1) + '레벨이 열렸습니다.') : '모든 레벨을 완료했습니다!');
            }
            drawLevels();
          }
        }
        drawStat(); graded = true;
      });
      card.querySelector('#bs').addEventListener('click', reveal);
      card.querySelector('#br').addEventListener('click', function () { drawQ(); });
      card.querySelector('#bw').addEventListener('click', function () {
        if (store.wrong[q.id]) {
          delete store.wrong[q.id]; save();
          if (isNote) {
            ui.pool.splice(ui.i, 1); toast('오답노트에서 해제했습니다.'); drawNav(mode); drawQ(); return;
          }
        } else { store.wrong[q.id] = Date.now(); save(); }
        flag();
      });
      card.querySelector('#bp').addEventListener('click', function () { if (ui.i > 0) { ui.i--; drawQ(); } else toast('첫 문제입니다.'); });
      card.querySelector('#bn2').addEventListener('click', function () { if (ui.i < ui.pool.length - 1) { ui.i++; drawQ(); } else toast('마지막 문제입니다.'); });
      function jump() {
        var n = parseInt(card.querySelector('#bj').value, 10);
        if (n >= 1 && n <= ui.pool.length) { ui.i = n - 1; drawQ(); }
      }
      card.querySelector('#bjg').addEventListener('click', jump);
      card.querySelector('#bj').addEventListener('keydown', function (e) { if (e.key === 'Enter') jump(); });
      ab.blanks.forEach(function (b, k) {
        b.inp.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (ab.blanks[k + 1] && !graded) ab.blanks[k + 1].inp.focus(); else card.querySelector('#bg').click();
        });
      });
      if (ab.blanks[0]) ab.blanks[0].inp.focus({ preventScroll: true });
    }
  }


  /* ───────── 북마크 ───────── */
  var bmUI = { type: '', q: '' };
  function viewBookmarks() {
    var ui = bmUI;
    var ids = Object.keys(store.bookmarks).sort(function (a, b) { return store.bookmarks[b] - store.bookmarks[a]; });
    var items = ids.map(findQ).filter(Boolean);
    if (items.length !== ids.length) {
      /* 원본 문제가 삭제된 책갈피는 조용히 정리한다 */
      var validIds = items.map(function (q) { return q.id; });
      ids.forEach(function (id) { if (validIds.indexOf(id) < 0) delete store.bookmarks[id]; });
      save();
    }
    root.innerHTML =
      head('북마크', '표시해 둔 문제를 모아봅니다. “고정 보기”를 누르면 화면 위에 작은 창으로 띄워, 다른 문제를 풀거나 스크롤하면서도 함께 볼 수 있습니다.',
        '<span class="tag">' + items.length + '개</span>') +
      '<div class="bar">' +
      '<input type="search" id="bq" class="grow" placeholder="문제·정답 검색" value="' + esc(ui.q) + '">' +
      '<select id="bt"><option value="">전체 유형</option>' +
      '<option value="written"' + (ui.type === 'written' ? ' selected' : '') + '>필답형</option>' +
      '<option value="practical"' + (ui.type === 'practical' ? ' selected' : '') + '>작업형</option>' +
      '<option value="mock"' + (ui.type === 'mock' ? ' selected' : '') + '>모의고사</option></select>' +
      '<button class="sm" id="bmPlayAll" title="지금 표시된 북마크를 문제→정답 순서로 이어 듣습니다">▶ 전체 듣기</button>' +
      '<button class="sm rep-btn" data-rep title="한 문제를 몇 번 반복해서 읽을지 정합니다(누르면 1→3→5→10회)">' + repLabel() + '</button>' +
      '<span class="meta" id="bc"></span></div>' +
      '<div class="wrap"><table class="tbl list" id="tb"><thead><tr><th>No</th><th>유형</th><th>문제</th><th>정답 · 관리</th></tr></thead><tbody id="tbody"></tbody></table></div>';

    function kindOf(q) { return q.mock ? 'mock' : q.type; }
    function kindLabel(q) { return q.mock ? (TYPES[q.type] + ' 모의 ' + q.mock + '회') : TYPES[q.type]; }
    function row(q) {
      return '<tr data-id="' + q.id + '"><td class="no">' + qNo(q) + '</td>' +
        '<td class="sj">' + iconFor(q.subject) + '<span class="subj-chip">' + esc(kindLabel(q)) + '</span><br><span class="meta" style="font-size:12px">' + esc(q.subject) + '</span></td>' +
        '<td class="q">' + esc(q.q) + '</td><td class="a"><div class="ans">' + ansHTML(q.a) + '</div>' +
        '<div class="rowbtns"><button class="sm" data-float="' + q.id + '">📌 고정 보기</button>' + spkBtnsHTML(q.id) + '<button class="sm danger" data-bm="' + q.id + '">해제</button></div></td></tr>';
    }
    var visibleIds = [];
    function draw() {
      var kw = ui.q.trim().toLowerCase();
      var list = items.filter(function (q) {
        return (!ui.type || kindOf(q) === ui.type) && (!kw || (q.q + ' ' + q.a).toLowerCase().indexOf(kw) >= 0);
      });
      visibleIds = list.map(function (q) { return q.id; });
      document.getElementById('tbody').innerHTML = list.length ? list.map(row).join('')
        : '<tr><td colspan="4" class="empty">북마크한 문제가 없습니다.<br>필답형·작업형·모의고사·퀴즈 화면의 ☆ 책갈피 버튼을 눌러 보세요.</td></tr>';
      document.getElementById('bc').textContent = list.length + '개 표시';
    }
    draw();
    document.getElementById('bq').addEventListener('input', function (e) { ui.q = e.target.value; draw(); });
    document.getElementById('bt').addEventListener('change', function (e) { ui.type = e.target.value; draw(); });
    document.getElementById('bmPlayAll').addEventListener('click', function () {
      if (!visibleIds.length) { toast('들을 북마크가 없습니다.'); return; }
      openFloat(visibleIds, visibleIds[0], true);
    });
    document.getElementById('tbody').addEventListener('click', function (e) {
      var f = e.target.closest('[data-float]');
      if (f) { openFloat(visibleIds, f.getAttribute('data-float')); return; }
      var d = e.target.closest('[data-bm]');
      if (d) {
        var id = d.getAttribute('data-bm');
        toggleBM(id);
        items = items.filter(function (q) { return q.id !== id; });
        draw(); drawNav('bookmarks');
        return;
      }
    });
  }

  /* ───────── 플로팅 뷰(화면 위 고정 창) ─────────
     휴대폰 브라우저는 앱 전환 후에도 유지되는 유튜브식 PiP를 일반 웹페이지에
     지원하지 않으므로, 이 앱 화면 안에서 끌어서 옮기고 크기를 조절할 수 있는
     작은 창으로 구현한다. 다른 화면(퀴즈·목록 등)을 오가거나 스크롤해도 유지된다. */
  var floatPanel = null;
  var floatState = { ids: [], i: 0, auto: false };
  function ensureFloat() {
    if (floatPanel) return floatPanel;
    var p = document.createElement('div');
    p.id = 'floatPanel'; p.className = 'float-panel'; p.hidden = true;
    p.innerHTML =
      '<div class="fp-head" id="fpHead"><span class="fp-drag">⠿⠿</span><span class="fp-title" id="fpTitle"></span>' +
      '<div class="fp-btns"><button id="fpBM" aria-label="책갈피" title="책갈피">☆</button>' +
      '<button id="fpAuto" aria-label="전체 듣기" title="전체 듣기(문제→정답 이어 듣기)">▶</button>' +
      '<button id="fpSpk" aria-label="한 문제만 듣기" title="한 문제만 듣기">🔊</button>' +
      '<button id="fpRate" aria-label="속도" title="읽는 속도(누르면 바뀝니다)">1x</button>' +
      '<button class="rep-btn" data-rep aria-label="반복 횟수" title="반복 횟수(누르면 1→3→5→10회)">' + repLabel(true) + '</button>' +
      '<button id="fpPrev" aria-label="이전" title="이전 문제">⏮</button><button id="fpNext" aria-label="다음" title="다음 문제">⏭</button>' +
      '<button id="fpClose" aria-label="닫기" title="닫기">✕</button></div></div>' +
      '<div class="fp-body" id="fpBody"></div><div class="fp-resize" id="fpResize" aria-hidden="true"></div>';
    document.body.appendChild(p);
    floatPanel = p;

    var head = p.querySelector('#fpHead'), drag = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      drag = { sx: e.clientX, sy: e.clientY, ox: p.offsetLeft, oy: p.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var nx = drag.ox + (e.clientX - drag.sx), ny = drag.oy + (e.clientY - drag.sy);
      nx = Math.max(4, Math.min(window.innerWidth - p.offsetWidth - 4, nx));
      ny = Math.max(4, Math.min(window.innerHeight - p.offsetHeight - 4, ny));
      p.style.left = nx + 'px'; p.style.top = ny + 'px'; p.style.right = 'auto'; p.style.bottom = 'auto';
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) { head.addEventListener(ev, function () { drag = null; }); });

    var rs = p.querySelector('#fpResize'), resize = null;
    rs.addEventListener('pointerdown', function (e) {
      resize = { sx: e.clientX, sy: e.clientY, w: p.offsetWidth, h: p.offsetHeight };
      rs.setPointerCapture(e.pointerId); e.stopPropagation();
    });
    rs.addEventListener('pointermove', function (e) {
      if (!resize) return;
      var nw = Math.max(240, Math.min(window.innerWidth - 16, resize.w + (e.clientX - resize.sx)));
      var nh = Math.max(160, Math.min(window.innerHeight - 16, resize.h + (e.clientY - resize.sy)));
      p.style.width = nw + 'px'; p.style.height = nh + 'px';
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) { rs.addEventListener(ev, function () { resize = null; }); });

    p.querySelector('#fpClose').addEventListener('click', closeFloat);
    p.querySelector('#fpPrev').addEventListener('click', function () { floatStep(-1); });
    p.querySelector('#fpNext').addEventListener('click', function () { floatStep(1); });
    p.querySelector('#fpSpk').addEventListener('click', function () {
      var q = findQ(floatState.ids[floatState.i]);
      var fb = p.querySelector('#fpSpk');
      if (fb.classList.contains('playing')) { stopSpeak(); return; }
      if (floatState.auto) { floatState.auto = false; updateFpAuto(); }
      if (q) speakQ(q, 'qa', floatPanel, null, fb);
    });
    p.querySelector('#fpBM').addEventListener('click', function () {
      toggleBM(floatState.ids[floatState.i]); updateFpBM();
    });
    p.querySelector('#fpAuto').addEventListener('click', floatAutoToggle);
    p.querySelector('#fpRate').addEventListener('click', cycleRate);
    p.querySelector('#fpRate').textContent = speechRate() + 'x';
    return p;
  }
  function floatRender() {
    var id = floatState.ids[floatState.i], q = findQ(id);
    if (!floatPanel) return;
    if (!q) { floatPanel.querySelector('#fpBody').innerHTML = '<div class="empty">문제를 찾을 수 없습니다.</div>'; return; }
    floatPanel.querySelector('#fpTitle').textContent = (floatState.i + 1) + ' / ' + floatState.ids.length + ' · ' + q.subject;
    floatPanel.querySelector('#fpBody').innerHTML = '<p class="fp-q">' + esc(q.q) + '</p><div class="fp-a">' + ansHTML(q.a) + '</div>';
    updateFpBM();
  }
  function updateFpBM() {
    if (!floatPanel) return;
    var on = isBM(floatState.ids[floatState.i]);
    var b = floatPanel.querySelector('#fpBM');
    b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on); b.title = on ? '책갈피 해제' : '책갈피 추가';
  }
  function updateFpAuto() {
    if (!floatPanel) return;
    var b = floatPanel.querySelector('#fpAuto');
    b.textContent = floatState.auto ? '⏸' : '▶'; b.classList.toggle('on', floatState.auto);
    b.title = floatState.auto ? '전체 듣기 정지' : '전체 듣기(문제→정답 이어 듣기)';
  }
  function floatPlayCurrent() {
    var q = findQ(floatState.ids[floatState.i]);
    if (!q) { floatState.auto = false; updateFpAuto(); return; }
    speakQ(q, 'qa', floatPanel, function () {
      if (!floatState.auto) return;
      if (floatState.i < floatState.ids.length - 1) {
        floatState.i++; floatRender(); floatPlayCurrent();
      } else {
        floatState.auto = false; updateFpAuto(); toast('전체 듣기를 마쳤습니다.');
      }
    });
  }
  function floatAutoToggle() {
    floatState.auto = !floatState.auto;
    updateFpAuto();
    if (floatState.auto) floatPlayCurrent(); else stopSpeak();
  }
  function floatStep(d) {
    if (!floatState.ids.length) return;
    floatState.i = (floatState.i + d + floatState.ids.length) % floatState.ids.length;
    floatRender();
    if (floatState.auto) floatPlayCurrent();
  }
  function openFloat(ids, startId, autoStart) {
    if (!ids || !ids.length) { toast('들을 문제가 없습니다.'); return; }
    ensureFloat();
    floatState.ids = ids.slice();
    var idx = floatState.ids.indexOf(startId);
    floatState.i = idx >= 0 ? idx : 0;
    if (!floatPanel.style.left && !floatPanel.style.right) {
      floatPanel.style.right = '14px'; floatPanel.style.bottom = 'calc(88px + env(safe-area-inset-bottom))';
    }
    floatPanel.hidden = false;
    floatRender(); updateFAB();
    floatState.auto = !!autoStart; updateFpAuto();
    if (floatState.auto) floatPlayCurrent();
  }
  function closeFloat() {
    floatState.auto = false; stopSpeak();
    if (floatPanel) floatPanel.hidden = true;
    updateFAB();
  }

  var bmFab = document.createElement('button');
  bmFab.id = 'bmFab'; bmFab.className = 'bm-fab'; bmFab.type = 'button'; bmFab.hidden = true;
  document.body.appendChild(bmFab);
  bmFab.addEventListener('click', function () {
    if (floatPanel && !floatPanel.hidden) { closeFloat(); return; }
    var ids = Object.keys(store.bookmarks).sort(function (a, b) { return store.bookmarks[b] - store.bookmarks[a]; });
    openFloat(ids, ids[0]);
  });
  function updateFAB() {
    var n = Object.keys(store.bookmarks).length;
    var open = !!(floatPanel && !floatPanel.hidden);
    bmFab.hidden = n === 0 && !open;
    bmFab.textContent = open ? '✕' : '📌';
    bmFab.title = open ? '고정 보기 닫기' : (n + '개 책갈피 보기');
  }


  /* ───────── 음성으로 듣기(TTS) ─────────
     기기에 이미 설치된 음성 엔진을 쓰는 브라우저 내장 기능이라 별도 설치나
     인터넷 연결 없이 오프라인에서도 동작한다(단말기에 한국어 음성이 없으면
     다른 억양으로 읽힐 수 있다). */
  var ttsOn = 'speechSynthesis' in window;
  /* 한국어 읽기 다듬기: 기계식 읽기("사가지") 대신 사람이 읽듯 바꾼다.
     - 고유어 수사가 붙는 단위(가지·개·명·건·시간·번째 …)는 "네 가지", "두 명"처럼 읽는다.
     - 기호·단위(①, ·, 【】, m, kV, %, ℃, 1:29 …)를 말로 풀어 쓴다. */
  var NATIVE_U = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
  var NATIVE_T = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
  function nativeNum(n) { // 1~99 → 관형형 고유어 수(한, 두, … 스무, 스물한 …)
    n = +n; if (!(n >= 1 && n <= 99) || n % 1) return null;
    var t = Math.floor(n / 10), u = n % 10;
    if (n === 20) return '스무';
    return NATIVE_T[t] + NATIVE_U[u];
  }
  var ORD = ['', '첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째', '일곱째', '여덟째', '아홉째', '열째', '열한째', '열두째', '열셋째', '열넷째', '열다섯째', '열여섯째', '열일곱째', '열여덟째', '열아홉째', '스무째'];
  // 고유어로 읽는 단위(개월·개소·개걸이 등 한자어 결합은 제외)
  var NATIVE_CNT = '가지|개(?!월|소|년|걸이|층|국)|명|사람|건|시간|번째|군데|곳|마리|벌|켤레|줄|장|권|살|차례|달|그루|척|배(?=\\s|$|[^가-힣])|대(?=\\s|$|[^가-힣])|번(?=\\s*(?:이상|이내|이하|정도|씩|마다|까지|반복|더|째))';
  var UNITS = [
    [/(\d)\s*vol\s*%/gi, '$1 볼륨 퍼센트'], [/(\d)\s*%/g, '$1 퍼센트'],
    [/(\d)\s*(?:℃|°C|°c)/g, '$1 도'], [/(\d)\s*°/g, '$1 도'],
    [/(\d)\s*(?:㎡|m²|m2)(?![a-z])/g, '$1 제곱미터'], [/(\d)\s*(?:㎥|m³|m3)(?![a-z])/g, '$1 세제곱미터'],
    [/(\d)\s*m\/s(?:ec)?\b/g, '$1 미터 매 초'], [/(\d)\s*m\/min\b/g, '$1 미터 매 분'], [/(\d)\s*km\/h\b/g, '$1 킬로미터 매 시'],
    [/(\d)\s*(?:㎜|mm)(?![a-zA-Z])/g, '$1 밀리미터'], [/(\d)\s*(?:㎝|cm)(?![a-zA-Z])/g, '$1 센티미터'], [/(\d)\s*km(?![a-zA-Z])/g, '$1 킬로미터'],
    [/(\d)\s*m(?![a-zA-Zµ²³\/])/g, '$1 미터'],
    [/(\d)\s*(?:㎏|kg)(?![a-zA-Z])/g, '$1 킬로그램'], [/(\d)\s*kgf(?![a-zA-Z])/g, '$1 킬로그램힘'], [/(\d)\s*mg(?![a-zA-Z])/g, '$1 밀리그램'],
    [/(\d)\s*kV(?![a-zA-Z])/g, '$1 킬로볼트'], [/(\d)\s*V(?![a-zA-Z])/g, '$1 볼트'],
    [/(\d)\s*mA(?![a-zA-Z])/g, '$1 밀리암페어'], [/(\d)\s*A(?![a-zA-Z])/g, '$1 암페어'],
    [/(\d)\s*MΩ/g, '$1 메가옴'], [/(\d)\s*kΩ/g, '$1 킬로옴'], [/(\d)\s*Ω/g, '$1 옴'],
    [/(\d)\s*kW(?![a-zA-Z])/g, '$1 킬로와트'], [/(\d)\s*W(?![a-zA-Z])/g, '$1 와트'],
    [/(\d)\s*MPa(?![a-zA-Z])/g, '$1 메가파스칼'], [/(\d)\s*kPa(?![a-zA-Z])/g, '$1 킬로파스칼'], [/(\d)\s*Pa(?![a-zA-Z])/g, '$1 파스칼'],
    [/(\d)\s*ms(?![a-zA-Z])/g, '$1 밀리초'], [/(\d)\s*pF(?![a-zA-Z])/g, '$1 피코패럿'], [/(\d)\s*mJ(?![a-zA-Z])/g, '$1 밀리줄'],
    [/(\d)\s*ppm(?![a-zA-Z])/gi, '$1 피피엠'], [/(\d)\s*dB(?:\(A\))?/g, '$1 데시벨'], [/(\d)\s*(?:lux|lx)(?![a-zA-Z])/gi, '$1 럭스'],
    [/(\d)\s*Hz(?![a-zA-Z])/g, '$1 헤르츠'], [/(\d)\s*L(?![a-zA-Z])/g, '$1 리터'], [/(\d)\s*t(?![a-zA-Z])/g, '$1 톤']
  ];
  function koreanize(s) {
    s = String(s);
    s = s.replace(/[①-⑳]/g, function (c) { return ' ' + ORD[c.charCodeAt(0) - 0x245F] + ', '; });
    s = s.replace(/[【\[]([^】\]]*)[】\]]/g, '$1. ');
    s = s.replace(/[▶►◇□○■●※]/g, ' ').replace(/[“”"]/g, '');
    s = s.replace(/[₀-₉]/g, function (c) { return String(c.charCodeAt(0) - 0x2080); });
    s = s.replace(/½/g, '2분의 1').replace(/√/g, '루트 ').replace(/π/g, '파이');
    s = s.replace(/(\d+)([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, function (m, b, e) {   // 10⁶ → 10의 6제곱, m² → 제곱
      var d = e.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g, function (c) { return c === '⁻' ? '마이너스 ' : '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c); });
      return d === '2' ? b + ' 제곱' : d === '3' ? b + ' 세제곱' : b + '의 ' + d + '제곱';
    });
    // 범위: 3~5명 → 세 명에서 다섯 명, 3~5m → 3에서 5 m
    s = s.replace(new RegExp('(\\d+)\\s*[~∼]\\s*(\\d+)\\s*(' + NATIVE_CNT + ')', 'g'), function (m, a, b, c) {
      var na = nativeNum(a), nb = nativeNum(b);
      return na && nb ? na + ' ' + c + '에서 ' + nb + ' ' + c : a + ' ' + c + '에서 ' + b + ' ' + c;
    });
    s = s.replace(/(\d)\s*[~∼]\s*(\d)/g, '$1에서 $2');
    UNITS.forEach(function (u) { s = s.replace(u[0], u[1]); });
    // 고유어 수사 + 단위 (1,000처럼 쉼표·소수 뒤 숫자는 제외)
    s = s.replace(new RegExp('(^|[^\\d.,])(\\d{1,2})\\s*(' + NATIVE_CNT + ')', 'g'), function (m, pre, n, c) {
      if (c === '번째') return pre + (+n === 1 ? '첫' : nativeNum(n)) + ' 번째';
      if ((c === '대' || c === '배') && +n > 10) return m;
      var k = nativeNum(n); return k ? pre + k + ' ' + c : m;
    });
    s = s.replace(/(\d)\s*:\s*(?=\d)/g, '$1 대 ');           // 1:29:300 → 1 대 29 대 300
    s = s.replace(/\s*[×✕]\s*/g, ' 곱하기 ').replace(/\s*÷\s*/g, ' 나누기 ').replace(/\s*≈\s*/g, ' 약 ')
      .replace(/\s*=\s*/g, ' 은 ').replace(/(\d)\s*\+\s*(?=\d)/g, '$1 더하기 ').replace(/(\d)\s*[−–]\s*(?=\d)/g, '$1 빼기 ');
    s = s.replace(/\s*→\s*/g, '. ').replace(/\s*—\s*/g, ', ');
    s = s.replace(/·/g, ', ').replace(/\s*:\s*/g, ', ');      // 추락·끼임 → 추락, 끼임 / "위험요인 :" → "위험요인,"
    s = s.replace(/\bNo\.\s*/g, '번호 ');
    return s;
  }
  function cleanForSpeech(s) {
    s = String(s).replace(/\{\{([^}|]+)(\|[^}]*)?\}\}/g, '$1');
    return koreanize(s)
      .replace(/\n+/g, '. ')
      .replace(/\s*([,.])(\s*[,.])+/g, '$1 ')
      .replace(/^[\s,.]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  /* 한국어 음성 고르기: 설정에서 고른 음성 → 자연스러운 음성(Natural·Neural·Google·Yuna 등) → 아무 한국어 음성 */
  function koVoices() {
    try { return window.speechSynthesis.getVoices().filter(function (v) { return /^ko([-_]|$)/i.test(v.lang); }); } catch (e) { return []; }
  }
  function pickVoice() {
    var vs = koVoices(); if (!vs.length) return null;
    var want = store.settings.voice;
    if (want) { var w = vs.filter(function (v) { return v.name === want; })[0]; if (w) return w; }
    var pref = [/natural|neural|online/i, /google/i, /yuna|유나/i, /sunhi|선희|injoon|인준|heami|해미/i];
    for (var i = 0; i < pref.length; i++) { var f = vs.filter(function (v) { return pref[i].test(v.name); })[0]; if (f) return f; }
    return vs[0];
  }
  if (ttsOn && 'onvoiceschanged' in window.speechSynthesis) {
    window.speechSynthesis.addEventListener ? window.speechSynthesis.addEventListener('voiceschanged', fillVoiceSel) : (window.speechSynthesis.onvoiceschanged = fillVoiceSel);
  }
  function fillVoiceSel() {
    var sel = document.getElementById('voiceSel'); if (!sel) return;
    var vs = koVoices(), cur = store.settings.voice || '', auto = pickVoice();
    sel.innerHTML = '<option value="">자동 선택' + (auto && !cur ? ' (' + esc(auto.name) + ')' : '') + '</option>' +
      vs.map(function (v) { return '<option value="' + esc(v.name) + '"' + (v.name === cur ? ' selected' : '') + '>' + esc(v.name) + '</option>'; }).join('');
    if (!vs.length) sel.innerHTML = '<option value="">이 기기에 한국어 음성이 없습니다</option>';
  }
  var RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
  function speechRate() { return store.settings.rate || 1; }
  function setSpeechRate(r) {
    store.settings.rate = r; save();
    var b = floatPanel && floatPanel.querySelector('#fpRate');
    if (b) b.textContent = r + 'x';
    var sel = document.getElementById('rateSel');
    if (sel) sel.value = String(r);
  }
  function cycleRate() {
    var i = RATES.indexOf(speechRate());
    setSpeechRate(RATES[(i + 1) % RATES.length]);
  }
  /* 반복 듣기 : 한 문제(문제→정답)를 1·3·5·10회 이어서 읽는다. 전체 듣기에서는 문제마다 정한 횟수만큼 반복한 뒤 다음 문제로 넘어간다.
     설정은 store.settings.repeat에 저장되고, 목록·북마크 머리글, 고정 보기 창, 읽는 중 막대, 문제생성 설정의 🔁 버튼이 모두 같은 값을 쓴다. */
  var REPEATS = [1, 3, 5, 10];
  function repeatCount() { var n = store.settings.repeat; return REPEATS.indexOf(n) >= 0 ? n : 1; }
  function repLabel(short) { var n = repeatCount(); return short ? '🔁' + n : (n > 1 ? '🔁 ' + n + '회 반복' : '🔁 반복 끔'); }
  function updateRepUI() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-rep]'), function (b) {
      b.textContent = repLabel(!!b.closest('.float-panel')); b.classList.toggle('on', repeatCount() > 1);
    });
    var sel = document.getElementById('repSel'); if (sel) sel.value = String(repeatCount());
    if (ttsLabel) ttsLabel();
  }
  function setRepeat(n) { store.settings.repeat = n; save(); updateRepUI(); }
  function cycleRepeat() {
    var i = REPEATS.indexOf(repeatCount());
    setRepeat(REPEATS[(i + 1) % REPEATS.length]);
    toast(repeatCount() > 1 ? '한 문제를 ' + repeatCount() + '번 반복해서 읽습니다.' : '반복 듣기를 껐습니다.');
  }
  document.addEventListener('click', function (e) { if (e.target.closest('[data-rep]')) { e.preventDefault(); cycleRepeat(); } });
  /* 읽는 내용 하이라이트
     - 문제·정답이 보이는 곳(목록 행, 퀴즈 카드, 플로팅 창, 메인 핵심 암기 카드)을 모두 찾아
       읽는 동안 그 영역에 .speaking(노란 테두리), 지금 읽는 문제 문장 또는 정답의 한 줄에 .say(노란 배경),
       이미 읽은 줄에 .said(옅은 밑줄)를 붙인다.
     - 정답은 줄 단위로 끊어 읽으므로 음성 엔진의 단어 위치 이벤트가 없어도 정확히 따라간다.
     - 기기에 따라 onend/onerror가 너무 이르거나 오지 않아도 예상 시간·speaking 상태로 보정한다. */
  var ttsTok = null, ttsTimers = [];
  function later(fn, ms) { var t = setTimeout(fn, ms); ttsTimers.push(t); return t; }
  function clearTTSTimers() { ttsTimers.forEach(clearTimeout); ttsTimers = []; }
  function clearSay() {
    Array.prototype.forEach.call(document.querySelectorAll('.say,.said,.speaking'), function (el) { el.classList.remove('say', 'said', 'speaking'); });
  }
  function estMs(text) { return (text.replace(/\s/g, '').length * 150 + 400) / speechRate(); }
  var BOX_SEL = 'tr, .qcard, .float-panel, .kc', Q_SEL = 'td.q, .qtext, .fp-q, .kc-q', A_SEL = '.ans, .ans-box, .reveal, .fp-a, .kc-a';
  function boxesFor(q, ctx) {
    var boxes = [];
    function add(el) { if (el && boxes.indexOf(el) < 0) boxes.push(el); }
    if (ctx) add(ctx.matches && ctx.matches(BOX_SEL) ? ctx : ctx.closest(BOX_SEL));
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-id="' + q.id + '"], .kc[data-id="' + q.id + '"]'), add);
    if (floatPanel && !floatPanel.hidden && floatState.ids[floatState.i] === q.id) add(floatPanel);
    var qc = document.querySelector('.qcard'); if (qc && qc.querySelector('[data-spk^="' + q.id + ':"]')) add(qc);
    return boxes.filter(function (b) { return b.querySelector(Q_SEL) || b.querySelector(A_SEL); });
  }
  function segmentsFor(q, which, boxes) {
    var segs = [];
    if (which !== 'a') segs.push({ text: q.q, els: boxes.map(function (b) { return b.querySelector(Q_SEL); }).filter(Boolean) });
    if (which !== 'q') {
      var groups = [];
      boxes.forEach(function (b) { Array.prototype.forEach.call(b.querySelectorAll(A_SEL), function (g) { groups.push(g.querySelectorAll('.ln, .ans-line')); }); });
      q.a.split('\n').forEach(function (line, j) {
        segs.push({ text: line, els: groups.map(function (g) { return g[j]; }).filter(Boolean) });
      });
    }
    return segs.filter(function (sg) { return cleanForSpeech(sg.text).replace(/[.\s]/g, ''); });
  }
  function ttsFail(code) {
    toast('음성이 재생되지 않았습니다(' + code + '). 기기 설정에서 한국어 음성(TTS)을 확인하세요.');
    stopSpeak();
    if (floatState.auto) { floatState.auto = false; updateFpAuto(); }
  }
  function speakOne(text, tok, cb) {
    var clean = cleanForSpeech(text), est = estMs(clean), t0 = Date.now(), fin = false, retried = false, g;
    function complete() { if (fin || ttsTok !== tok) return; fin = true; clearTimeout(g); cb(); }
    function guard() {
      if (fin || ttsTok !== tok) return;
      var sp = false; try { sp = window.speechSynthesis.speaking; } catch (e) {}
      if (sp && Date.now() - t0 < est * 3 + 8000) { g = later(guard, 400); return; }
      complete();
    }
    g = later(guard, est + 1500);
    function make() {
      var u = new SpeechSynthesisUtterance(clean);
      u.lang = 'ko-KR'; u.rate = speechRate();
      try { var v = pickVoice(); if (v) u.voice = v; } catch (e) {}
      u.onend = function () {
        if (ttsTok !== tok || fin) return;
        var left = est * 0.5 - (Date.now() - t0); // 너무 이른 종료 신호는 예상 시간 절반까지 표시 유지
        if (left > 0) { clearTimeout(g); g = later(complete, left); } else complete();
      };
      u.onerror = function (e) {
        if (ttsTok !== tok || fin) return;
        var c = (e && e.error) || '';
        if (!retried && /interrupted|canceled/.test(c) && Date.now() - t0 < 800) {
          retried = true; later(function () { if (ttsTok === tok && !fin) { try { window.speechSynthesis.speak(make()); } catch (_) {} } }, 150); return;
        }
        if (c && !/interrupted|canceled/.test(c)) { fin = true; ttsFail(c); return; }
        complete();
      };
      return u;
    }
    // cancel 직후 바로 speak하면 일부 크롬에서 무시되므로 잠깐 쉬었다 시작
    later(function () { if (ttsTok === tok && !fin) { try { window.speechSynthesis.speak(make()); } catch (e) { complete(); } } }, 80);
  }
  /* 멈춤: 누른 🔊 버튼이 ⏹ 멈춤으로 바뀌고, 읽는 동안 화면 아래에 멈춤 막대가 뜬다(Esc 키도 멈춤). */
  var ttsBar = document.createElement('div');
  ttsBar.id = 'ttsBar'; ttsBar.className = 'tts-bar'; ttsBar.hidden = true; ttsBar.setAttribute('role', 'status');
  ttsBar.innerHTML = '<span class="tts-dot" aria-hidden="true"></span><span class="tts-lbl">읽는 중</span>' +
    '<button type="button" id="ttsPause" title="잠시 멈춤(같은 줄부터 이어 읽기)">⏸ 일시정지</button>' +
    '<button type="button" class="rep-btn" data-rep title="반복 횟수(누르면 1→3→5→10회)">' + '🔁' + '</button>' +
    '<button type="button" id="ttsStop" title="듣기 종료(Esc)">⏹ 멈춤</button>';
  document.body.appendChild(ttsBar);
  ttsBar.querySelector('#ttsStop').addEventListener('click', function () { stopSpeak(); toast('듣기를 멈췄습니다.'); });
  ttsBar.querySelector('#ttsPause').addEventListener('click', function () { if (ttsPaused) resumeSpeak(); else pauseSpeak(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ttsTok) stopSpeak(); });
  /* 일시정지 : 기기마다 speechSynthesis.pause()가 불안정(특히 안드로이드)하므로 직접 구현한다.
     지금 읽던 줄 위치를 기억하고 음성을 취소했다가, 계속을 누르면 그 줄부터 다시 읽는다(반복 회차도 유지). */
  var ttsPaused = false, ttsResume = null, ttsLabel = null;
  function setPauseUI() {
    var b = ttsBar.querySelector('#ttsPause');
    b.textContent = ttsPaused ? '▶ 계속' : '⏸ 일시정지'; b.classList.toggle('on', ttsPaused);
    ttsBar.classList.toggle('paused', ttsPaused);
  }
  function pauseSpeak() {
    if (!ttsTok || ttsPaused || !ttsResume) return;
    ttsPaused = true; ttsTok = { paused: true }; clearTTSTimers();
    try { window.speechSynthesis.cancel(); } catch (e) {}
    setPauseUI(); if (ttsLabel) ttsLabel();
  }
  function resumeSpeak() { if (ttsPaused && ttsResume) ttsResume(); }
  function markPlaying(btn) {
    if (!btn || btn.classList.contains('playing')) return;
    btn.setAttribute('data-orig', btn.innerHTML);
    btn.innerHTML = btn.textContent.trim() === '🔊' ? '⏹' : '⏹ 멈춤';
    btn.classList.add('playing'); btn.setAttribute('aria-pressed', 'true');
  }
  function endTTSUI() {
    Array.prototype.forEach.call(document.querySelectorAll('.playing[data-orig]'), function (b) {
      b.innerHTML = b.getAttribute('data-orig'); b.removeAttribute('data-orig'); b.classList.remove('playing'); b.removeAttribute('aria-pressed');
    });
    ttsBar.hidden = true;
  }
  function speakQ(q, which, ctx, onDone, btn) {
    if (!ttsOn) { toast('이 브라우저는 음성 읽기를 지원하지 않습니다.'); if (onDone) onDone(); return; }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    clearTTSTimers(); clearSay(); endTTSUI();
    var tok = {}; ttsTok = tok; ttsPaused = false;
    markPlaying(btn); ttsBar.hidden = false; setPauseUI(); updateRepUI();
    var boxes = boxesFor(q, ctx), segs = segmentsFor(q, which, boxes), i = 0, cur = 0, round = 1;
    ttsLabel = function () {
      var t = floatState.auto ? '전체 듣기 중 · ' + (floatState.i + 1) + '/' + floatState.ids.length : '읽는 중';
      if (repeatCount() > 1) t += ' · 반복 ' + Math.min(round, repeatCount()) + '/' + repeatCount();
      ttsBar.querySelector('.tts-lbl').textContent = (ttsPaused ? '일시정지 · ' : '') + t;
    };
    ttsLabel();
    boxes.forEach(function (b) { b.classList.add('speaking'); });
    function next() {
      if (ttsTok !== tok) return;
      boxes.forEach(function (b) { Array.prototype.forEach.call(b.querySelectorAll('.say'), function (el) { el.classList.remove('say'); el.classList.add('said'); }); });
      if (i >= segs.length) {
        if (round < repeatCount()) { // 반복 : 잠깐 쉬었다가 처음 줄부터 다시
          round++; i = 0; ttsLabel();
          later(function () {
            if (ttsTok !== tok) return;
            Array.prototype.forEach.call(document.querySelectorAll('.said'), function (el) { el.classList.remove('said'); });
            next();
          }, 700);
          return;
        }
        ttsResume = null;
        later(function () { if (ttsTok === tok) { clearSay(); endTTSUI(); ttsTok = null; ttsLabel = null; } }, 500);
        if (onDone) onDone(); return;
      }
      cur = i;
      var sg = segs[i++];
      sg.els.forEach(function (el) {
        el.classList.remove('said'); el.classList.add('say');
        if (el.closest('.float-panel')) el.scrollIntoView({ block: 'nearest' }); // 플로팅 창 안에서 읽는 줄 따라가기
      });
      speakOne(sg.text, tok, next);
    }
    ttsResume = function () { // 일시정지했던 줄부터 다시 읽는다
      tok = {}; ttsTok = tok; ttsPaused = false; i = cur;
      setPauseUI(); ttsLabel(); next();
    };
    next();
  }
  function stopSpeak() {
    ttsTok = null; ttsPaused = false; ttsResume = null; ttsLabel = null; clearTTSTimers();
    if (ttsOn) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    clearSay(); endTTSUI();
    if (floatState.auto) { floatState.auto = false; updateFpAuto(); }
  }
  document.addEventListener('click', function (e) {
    var sp = e.target.closest('[data-spk]');
    if (!sp) return;
    var parts = sp.getAttribute('data-spk').split(':'), id = parts[0], which = parts[1];
    if (sp.classList.contains('playing')) { stopSpeak(); return; } // 읽는 중인 버튼을 다시 누르면 멈춤
    var q = findQ(id);
    if (!q) return;
    if (floatState.auto) { floatState.auto = false; updateFpAuto(); }
    speakQ(q, which === 'q' || which === 'a' ? which : 'qa', sp, null, sp);
  });

  /* ───────── 과목·분야 참고 아이콘 ─────────
     실제 시험의 사진·영상 자료는 저작권이 있어 그대로 옮길 수 없으므로,
     과목/분야를 한눈에 알아볼 수 있도록 직접 그린 단순 선 아이콘을 붙인다. */
  var ICONS = {
    '산업안전관리론': '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
    '안전보건교육': '<path d="M3 8l9-4 9 4-9 4-9-4z"/><path d="M7 10v5c0 1.5 2.5 3 5 3s5-1.5 5-3v-5"/>',
    '인간공학·시스템안전': '<circle cx="12" cy="8" r="3"/><path d="M5 21c0-4 3-6 7-6s7 2 7 6"/><path d="M2 12h3M19 12h3"/>',
    '기계위험방지기술': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    '전기위험방지기술': '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    '화학설비위험방지기술': '<path d="M9 2h6M10 2v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V2"/>',
    '건설안전기술': '<path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6"/>',
    '건설안전': '<path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6"/>',
    '기계안전': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    '전기안전': '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    '화학안전': '<path d="M9 2h6M10 2v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V2"/>',
    '보호구·표지': '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
    '기타': '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.5 1-1.5 2.2M12 17h.01"/>',
    '사용자추가': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'
  };
  function iconFor(subject) {
    var p = ICONS[subject];
    if (!p) return '';
    return '<svg class="subj-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  /* ───────── 앱(PWA) 설치 · 오프라인 ───────── */
  var deferredPrompt = null;
  var installBtn = document.getElementById('install');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferredPrompt = e; installBtn.hidden = false;
  });
  installBtn.addEventListener('click', function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); deferredPrompt = null; installBtn.hidden = true;
  });
  window.addEventListener('appinstalled', function () { installBtn.hidden = true; toast('앱이 설치되었습니다.'); });

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  var hintKey = 'ise.ioshint';
  var hinted = false;
  try { hinted = localStorage.getItem(hintKey) === '1'; } catch (e) {}
  if (isIOS && !standalone && !hinted && /^https?:$/.test(location.protocol)) {
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.innerHTML = '<span>홈 화면에 추가하면 앱처럼 쓰고 오프라인에서도 공부할 수 있어요. Safari의 <b>공유</b> 버튼 → <b>홈 화면에 추가</b></span><button class="sm" aria-label="닫기">닫기</button>';
    hint.querySelector('button').addEventListener('click', function () {
      hint.remove(); try { localStorage.setItem(hintKey, '1'); } catch (e) {}
    });
    document.body.insertBefore(hint, document.querySelector('.hazard'));
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  updateFAB();
  route();
})();
