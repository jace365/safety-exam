(function () {
  'use strict';
  var root = document.getElementById('view');
  var TYPES = { written: '필답형', practical: '작업형' };

  /* ───────── 저장소 ───────── */
  var KEY = 'ise.v1';
  var mem = null;
  function blank() {
    return { added: { written: [], practical: [] }, wrong: {}, mockRes: {}, bookmarks: {}, solved: {}, mockq: [], daily: {}, mockHist: [], updatedAt: 0, mqAt: 0, settings: { apiKey: '', model: 'claude-sonnet-5', rate: 1 } };
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
        d.mockq = Array.isArray(raw.mockq) ? raw.mockq : [];
        d.updatedAt = raw.updatedAt || 0;
        d.mqAt = raw.mqAt || 0;
        d.daily = raw.daily || {};
        d.mockHist = Array.isArray(raw.mockHist) ? raw.mockHist : [];
        d.settings = Object.assign(d.settings, raw.settings || {});
      }
    } catch (e) { if (mem) return mem; }
    return d;
  }
  var store = load();
  /* save()      : 학습 진행(오답·채점·북마크·레벨·설정·사용자추가) 저장 → DB progress 문서
     save('mq')  : 내가 입력한 모의고사 문제 저장 → DB mockbank 문서
     둘 다 이 브라우저(localStorage)에 먼저 쓰고, DB가 연결돼 있으면 잠시 뒤 묶어서 올린다. */
  function save(kind) {
    mem = store;
    if (kind === 'mq') store.mqAt = Date.now(); else store.updatedAt = Date.now();
    writeLocal();
    cloudSchedule(kind === 'mq' ? 'bank' : 'prog');
  }
  function writeLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
  }

  /* ───────── 학습 기록(로그) ─────────
     채점할 때마다 이벤트 1건 → 이 브라우저(최근 2000건) + DB(날짜·기기별 문서 1개에 묶어서) */
  function pad2(x) { return (x < 10 ? '0' : '') + x; }
  function dateKey(ts) { var d = new Date(ts || Date.now()); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  var DEV = (function () {
    var d = '';
    try { d = localStorage.getItem('ise.dev') || ''; if (!d) { d = Math.random().toString(36).slice(2, 8); localStorage.setItem('ise.dev', d); } } catch (e) { d = 'tmp' + Math.random().toString(36).slice(2, 5); }
    return d;
  })();
  var LOGKEY = 'ise.log';
  function localLog() { try { var a = JSON.parse(localStorage.getItem(LOGKEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function logEv(ev) {
    ev.ts = Date.now();
    var L = localLog(); L.push(ev); if (L.length > 2000) L = L.slice(-2000);
    try { localStorage.setItem(LOGKEY, JSON.stringify(L)); } catch (e) {}
    /* 일별 요약(store.daily)·모의고사 점수 이력(store.mockHist): 관리자 진도표가 progress 문서만 읽어도 되도록 */
    var dk = dateKey(ev.ts), D = store.daily[dk] = store.daily[dk] || { g: 0, ok: 0, m: 0, mo: 0 };
    if (ev.ok !== undefined && ev.k !== 'mockq') { D.g++; if (ev.ok) D.ok++; }
    if (ev.k === 'mockq') { D.m++; if (ev.ok) D.mo++; }
    if (ev.k === 'mark' && ev.r) { D.m++; if (ev.r === 'o') D.mo++; }
    if (ev.k === 'mock') { store.mockHist.push({ ts: ev.ts, t: ev.t, n: ev.n, o: ev.o, x: ev.x, tot: ev.tot, ms: ev.ms || 0, retry: !!ev.retry }); store.mockHist = store.mockHist.slice(-60); }
    var ks = Object.keys(store.daily).sort(); if (ks.length > 120) ks.slice(0, ks.length - 120).forEach(function (k) { delete store.daily[k]; });
    save();
    if ((Cloud.state === 'on' && Cloud.me) || Cloud.state === 'wait') { Cloud.logQ.push(ev); cloudSchedule('log'); }
  }

  /* ───────── 온라인 DB(claude.ai Artifact DB) + 사용자 계정 ─────────
     공유 경로(이 사이트에 접속하는 모든 사람이 같은 DB를 씀):
       accounts/<아이디>                 계정(이름·역할·비밀번호 해시·상태)
       progress/<아이디>                 진행 상황(오답·채점·북마크·레벨·일별 요약·모의 점수 이력)
       progress/<아이디>/logs/<날짜_기기>  학습 기록 이벤트
       mockbank/<아이디>                 내가 입력한 모의고사 문제
     관리자(role:'admin')는 accounts·progress 컬렉션 전체를 읽어 사용자별 진도를 본다.
     기본 관리자 admin / admin 은 DB에 계정이 하나도 없을 때 자동 생성되며 첫 로그인 때 비밀번호 변경을 요구한다.
     claude.ai 밖(파일로 열기)에서는 window.claude가 없어 로그인 없이 이 브라우저(localStorage)에만 저장한다. */
  var Cloud = { state: 'off', msg: '', warn: '', db: null, cuid: null, me: null, prog: null, bank: null, logs: null, sample: null, dl: null,
    timers: {}, busy: {}, again: {}, lastSave: 0, lastLoad: 0, today: '', todayEv: [], logQ: [], unsub: [] };
  var CLOUD_TXT = { off: '로컬 저장', local: '로컬 저장(이 브라우저)', wait: 'DB 연결 중…', login: '로그인 필요', on: '온라인 DB 연결됨' };
  var SESSKEY = 'ise.session';
  function isAdmin() { return !!(Cloud.me && Cloud.me.role === 'admin'); }
  function cloudLabel() { return (Cloud.state === 'on' ? '☁ ' : '💾 ') + CLOUD_TXT[Cloud.state] + (Cloud.me ? ' · ' + Cloud.me.id : '') + (Cloud.warn ? ' · ⚠' : ''); }
  function hm(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function setCloud(state, msg) {
    if (state) Cloud.state = state;
    if (msg !== undefined) Cloud.msg = msg;
    var f = document.getElementById('cloudFoot');
    if (f) f.innerHTML = '<span class="cdot ' + Cloud.state + (Cloud.warn ? ' warn' : '') + '"></span>' + esc(CLOUD_TXT[Cloud.state]) +
      (Cloud.state === 'on' && Cloud.lastSave ? '<br><small>마지막 저장 ' + hm(Cloud.lastSave) + '</small>' : '') +
      (Cloud.warn ? '<br><small class="cwarn">' + esc(Cloud.warn) + '</small>' : (Cloud.msg ? '<br><small>' + esc(Cloud.msg) + '</small>' : ''));
    var dot = document.getElementById('cloudDot');
    if (dot) { dot.className = 'cdot ' + Cloud.state + (Cloud.warn ? ' warn' : ''); dot.title = CLOUD_TXT[Cloud.state]; }
    var chip = document.getElementById('userChip');
    if (chip) { chip.hidden = !Cloud.me; if (Cloud.me) chip.innerHTML = '<span class="uav">' + esc((Cloud.me.name || Cloud.me.id).slice(0, 1)) + '</span><span class="unm">' + esc(Cloud.me.name || Cloud.me.id) + (isAdmin() ? ' <i>관리자</i>' : '') + '</span>'; }
    if (typeof drawCloudBox === 'function' && document.getElementById('cbox')) drawCloudBox();
  }
  function progPayload() {
    var st = Object.assign({}, store.settings); delete st.apiKey; // 비밀값은 DB에 올리지 않는다
    return { v: 2, uid: Cloud.me ? Cloud.me.id : '', dev: DEV, updatedAt: store.updatedAt, added: store.added, wrong: store.wrong, mockRes: store.mockRes,
      bookmarks: store.bookmarks, solved: store.solved, daily: store.daily, mockHist: store.mockHist, settings: st };
  }
  function bankPayload() { return { v: 2, uid: Cloud.me ? Cloud.me.id : '', dev: DEV, updatedAt: store.mqAt, items: store.mockq }; }
  function applyProg(d) {
    store.added = { written: (d.added && d.added.written) || [], practical: (d.added && d.added.practical) || [] };
    store.wrong = d.wrong || {}; store.mockRes = d.mockRes || {}; store.bookmarks = d.bookmarks || {}; store.solved = d.solved || {};
    store.daily = d.daily || {}; store.mockHist = Array.isArray(d.mockHist) ? d.mockHist : [];
    store.settings = Object.assign({}, store.settings, d.settings || {}, { apiKey: store.settings.apiKey });
    store.updatedAt = d.updatedAt || 0;
  }
  function applyBank(d) { store.mockq = Array.isArray(d.items) ? d.items : []; store.mqAt = d.updatedAt || 0; rebuildUserMocks(); }
  function cloudSchedule(kind) {
    if (Cloud.state !== 'on') return;
    clearTimeout(Cloud.timers[kind]);
    Cloud.timers[kind] = setTimeout(function () { cloudWrite(kind); }, kind === 'log' ? 4000 : 1200);
  }
  function cloudErr(e) {
    var code = (e && e.code) || '';
    if (['revoked', 'not_granted', 'capability_disabled', 'capability_removed'].indexOf(code) >= 0) {
      Cloud.warn = ''; setCloud('local', 'DB 연결이 끊겨 이 브라우저에만 저장합니다.'); return;
    }
    Cloud.warn = code === 'quota_exceeded' ? 'DB 용량이 가득 찼습니다. 오래된 기록을 정리해야 합니다.' :
      code === 'invalid_argument' ? '이 Claude 계정에는 DB 쓰기 권한이 없습니다. 사이트 소유자가 공유 설정에서 편집 권한을 줘야 합니다.' :
      code === 'too_big' ? (e.message || '문서가 너무 큽니다.') : 'DB 저장 실패(' + (code || '오류') + ') — 다음 변경 때 다시 시도합니다.';
    setCloud();
  }
  function retrying(fn) {
    return fn().catch(function (e) {
      if (e && e.code === 'unavailable') return new Promise(function (r) { setTimeout(r, 700 + Math.random() * 900); }).then(fn);
      throw e;
    });
  }
  function writeDoc(ref, data) {
    var size = JSON.stringify(data).length;
    if (size > 240000) return Promise.reject({ code: 'too_big', message: '저장할 내용이 DB 문서 한도(256KB)에 가깝습니다(' + Math.round(size / 1024) + 'KB). 오래된 사용자추가·입력 문제를 정리해 주세요.' });
    return retrying(function () { return ref.set(data); });
  }
  function writeLogs() {
    if (!Cloud.logQ.length) return Promise.resolve();
    var dk = dateKey();
    if (Cloud.today !== dk) { Cloud.today = dk; Cloud.todayEv = []; }
    var prev = Cloud.todayEv, take = Cloud.logQ.splice(0);
    Cloud.todayEv = prev.concat(take).slice(-2500);
    return writeDoc(Cloud.logs.doc(dk + '_' + DEV), { date: dk, dev: DEV, uid: Cloud.me.id, n: Cloud.todayEv.length, updatedAt: Date.now(), events: Cloud.todayEv })
      .catch(function (e) { Cloud.todayEv = prev; Cloud.logQ = take.concat(Cloud.logQ); throw e; });
  }
  function cloudWrite(kind) {
    if (Cloud.state !== 'on' || !Cloud.me) return Promise.resolve();
    if (Cloud.busy[kind]) { Cloud.again[kind] = true; return Cloud.busy[kind]; }
    clearTimeout(Cloud.timers[kind]);
    var p = kind === 'prog' ? writeDoc(Cloud.prog, progPayload()) : kind === 'bank' ? writeDoc(Cloud.bank, bankPayload()) : writeLogs();
    Cloud.busy[kind] = p.then(function () { Cloud.lastSave = Date.now(); Cloud.warn = ''; setCloud(); }, cloudErr)
      .then(function () { Cloud.busy[kind] = null; if (Cloud.again[kind]) { Cloud.again[kind] = false; return cloudWrite(kind); } });
    return Cloud.busy[kind];
  }
  function cloudSaveAll() { return Promise.all([cloudWrite('prog'), cloudWrite('bank'), cloudWrite('log')]); }
  function remoteRefresh(msg) {
    var cur = (location.hash || '#written').slice(1);
    drawNav(cur); updateFAB();
    if (['mock', 'bookmarks', 'stats'].indexOf(cur) >= 0 && !document.querySelector('#medit .medit') && !(mockUI.qs && mockUI.qs.stage === 'run')) {
      var r = ROUTES.filter(function (x) { return x.id === cur; })[0]; if (r) r.view();
    }
    if (msg) toast(msg);
  }
  /* DB에서 읽어 와 더 최신인 쪽으로 맞춘다(문서별 updatedAt 비교). force=true면 DB 값을 그대로 가져온다 */
  function cloudPull(force) {
    return Promise.all([Cloud.prog.get(), Cloud.bank.get()]).then(function (s) {
      var changed = false, push = [];
      var pd = s[0].exists ? s[0].data() : null, bd = s[1].exists ? s[1].data() : null;
      if (pd && (force || (pd.updatedAt || 0) > (store.updatedAt || 0))) { applyProg(pd); changed = true; }
      else if (!pd || (store.updatedAt || 0) > (pd.updatedAt || 0)) push.push('prog');
      if (bd && (force || (bd.updatedAt || 0) > (store.mqAt || 0))) { applyBank(bd); changed = true; }
      else if (!bd ? store.mockq.length : (store.mqAt || 0) > (bd.updatedAt || 0)) push.push('bank');
      if (changed) writeLocal();
      Cloud.lastLoad = Date.now();
      return { changed: changed, push: push, fresh: !pd && !bd };
    });
  }

  /* ── 비밀번호: PBKDF2-SHA256(6만 회) + 계정별 소금. DB에는 해시만 저장 ── */
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); }
  function newSalt() { var a = new Uint8Array(16); crypto.getRandomValues(a); return hex(a.buffer); }
  function hashPw(pw, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 60000, hash: 'SHA-256' }, k, 256);
    }).then(hex);
  }
  function pwFields(pw) { var salt = newSalt(); return hashPw(pw, salt).then(function (h) { return { salt: salt, hash: h }; }); }
  function accRef(id) { return Cloud.db.doc('accounts/' + id); }
  var ID_RE = /^[a-z0-9_.-]{3,20}$/;
  function ensureAdmin() {
    return accRef('admin').get().then(function (s) {
      if (s.exists) return;
      return Cloud.db.collection('accounts').limit(1).get().then(function (qs) {
        if (!qs.empty) return; // 다른 계정이 있으면 기본 관리자를 다시 만들지 않는다
        return pwFields('admin').then(function (pf) {
          return accRef('admin').set({ id: 'admin', name: '관리자', role: 'admin', salt: pf.salt, hash: pf.hash, mustChange: true, disabled: false, sv: 1, createdAt: Date.now(), createdBy: 'system' });
        });
      });
    }).catch(function () {});
  }
  function readSession() { try { return JSON.parse(localStorage.getItem(SESSKEY) || 'null'); } catch (e) { return null; } }
  function writeSession(o) { try { if (o) localStorage.setItem(SESSKEY, JSON.stringify(o)); else localStorage.removeItem(SESSKEY); } catch (e) {} }

  /* ── 로그인 화면 ── */
  function gateHTML(mode) {
    return '<div class="gate-box"><div class="hazard"></div><div class="gate-in">' +
      '<div class="brand"><div class="brand-mark" aria-hidden="true">!</div><div><div class="brand-title">산업안전기사 실기</div><div class="brand-sub" style="display:block">사용자 로그인 · 온라인 진도 관리</div></div></div>' +
      (mode === 'wait' ? '<p class="gate-msg"><span class="spin"></span>온라인 DB에 연결하는 중…</p>' :
       mode === 'nodb' ? '<p class="gate-msg err">온라인 DB를 쓸 수 없습니다. Claude에 로그인한 상태로 이 링크를 열어 주세요.<br>(' + esc(Cloud.msg || '') + ')</p><button id="gGuest">로그인 없이 이 기기에서만 사용</button>' :
       '<form id="gForm" autocomplete="on" onsubmit="return false">' +
       '<div class="field"><label for="gId">아이디</label><input type="text" id="gId" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="아이디"></div>' +
       '<div class="field"><label for="gPw">비밀번호</label><input type="password" id="gPw" autocomplete="current-password" placeholder="비밀번호"></div>' +
       '<p class="status err" id="gErr"></p>' +
       '<button class="pri" id="gLogin" type="submit">로그인</button></form>' +
       '<p class="note">계정은 관리자가 만들어 줍니다. 처음 설치했다면 관리자 <b>admin / admin</b>으로 로그인한 뒤 바로 비밀번호를 바꾸세요.</p>') +
      '</div></div>';
  }
  function showGate(mode) {
    var g = document.getElementById('gate');
    if (!g) { g = document.createElement('div'); g.id = 'gate'; document.body.appendChild(g); }
    g.innerHTML = gateHTML(mode); g.hidden = false; document.body.classList.add('gated');
    var gl = document.getElementById('gLogin');
    if (gl) {
      var idI = document.getElementById('gId'), pwI = document.getElementById('gPw'), er = document.getElementById('gErr');
      var last = (readSession() || {}).last; if (last) idI.value = last;
      (idI.value ? pwI : idI).focus();
      gl.addEventListener('click', function () {
        var id = idI.value.trim().toLowerCase(), pw = pwI.value;
        if (!id || !pw) { er.textContent = '아이디와 비밀번호를 입력하세요.'; return; }
        gl.disabled = true; er.textContent = ''; gl.innerHTML = '<span class="spin"></span>확인 중';
        login(id, pw).then(function (msg) { if (msg) { er.textContent = msg; gl.disabled = false; gl.textContent = '로그인'; pwI.select(); } });
      });
    }
    var gg = document.getElementById('gGuest');
    if (gg) gg.addEventListener('click', function () { hideGate(); setCloud('local', '로그인 없이 이 브라우저에만 저장합니다.'); });
  }
  function hideGate() { var g = document.getElementById('gate'); if (g) g.hidden = true; document.body.classList.remove('gated'); }
  function login(id, pw) {
    return accRef(id).get().then(function (s) {
      if (!s.exists) return '아이디 또는 비밀번호가 맞지 않습니다.';
      var a = s.data();
      if (a.disabled) return '사용이 중지된 계정입니다. 관리자에게 문의하세요.';
      return hashPw(pw, a.salt).then(function (h) {
        if (h !== a.hash) return '아이디 또는 비밀번호가 맞지 않습니다.';
        writeSession({ id: id, sv: a.sv || 1, last: id });
        retrying(function () { return accRef(id).update({ lastLogin: Date.now(), lastDev: DEV }); }).catch(cloudErr);
        return startSession(a).then(function () { return ''; });
      });
    }).catch(function (e) { return '로그인 실패: ' + ((e && (e.code || e.message)) || '오류'); });
  }
  function logout(silent) {
    var p = Cloud.state === 'on' ? cloudSaveAll() : Promise.resolve();
    return p.then(function () {
      Cloud.unsub.forEach(function (u) { try { u(); } catch (e) {} }); Cloud.unsub = [];
      var s = readSession() || {}; writeSession({ last: s.last || (Cloud.me && Cloud.me.id) });
      Cloud.me = null; Cloud.prog = Cloud.bank = Cloud.logs = null; Cloud.logQ = []; Cloud.todayEv = [];
      KEY = 'ise.v1'; store = load(); rebuildUserMocks(); mockUI.qs = null;
      setCloud('login', ''); closeModal(); route(); showGate('login');
      if (!silent) toast('로그아웃했습니다.');
    });
  }
  /* 로그인한 사용자의 저장소로 전환: 이 기기 사본(localStorage ise.v1.u.<id>) → DB와 비교해 최신으로 맞춤 */
  function startSession(acc) {
    Cloud.unsub.forEach(function (u) { try { u(); } catch (e) {} }); Cloud.unsub = [];
    Cloud.me = { id: acc.id, name: acc.name || acc.id, role: acc.role || 'user', sv: acc.sv || 1 };
    KEY = 'ise.v1.u.' + acc.id; store = load(); rebuildUserMocks(); mockUI.qs = null;
    Cloud.prog = Cloud.db.doc('progress/' + acc.id); Cloud.bank = Cloud.db.doc('mockbank/' + acc.id); Cloud.logs = Cloud.prog.collection('logs');
    Cloud.today = dateKey(); Cloud.logQ = [];
    return Promise.all([cloudPull(false), Cloud.logs.doc(Cloud.today + '_' + DEV).get()]).then(function (res) {
      var td = res[1].exists ? res[1].data() : null;
      Cloud.todayEv = td && Array.isArray(td.events) ? td.events.slice() : [];
      Cloud.state = 'on'; Cloud.warn = '';
      setCloud('on', '');
      hideGate(); drawNav('written'); route();
      res[0].push.forEach(function (k) { cloudWrite(k); });
      if (res[0].fresh) offerImport();
      toast((Cloud.me.name || Cloud.me.id) + '님, 환영합니다.');
      if (acc.mustChange) setTimeout(function () { openPwModal(true); }, 300);
      Cloud.unsub.push(Cloud.prog.onSnapshot(function (snap) {
        if (!snap.exists || snap.metadata.hasPendingWrites) return;
        var d = snap.data();
        if (d.dev === DEV || (d.updatedAt || 0) <= (store.updatedAt || 0)) return;
        applyProg(d); writeLocal(); remoteRefresh('다른 기기의 학습 기록을 반영했습니다.');
      }, function () {}));
      Cloud.unsub.push(Cloud.bank.onSnapshot(function (snap) {
        if (!snap.exists || snap.metadata.hasPendingWrites) return;
        var d = snap.data();
        if (d.dev === DEV || (d.updatedAt || 0) <= (store.mqAt || 0)) return;
        applyBank(d); writeLocal(); remoteRefresh('다른 기기에서 입력한 모의고사 문제를 반영했습니다.');
      }, function () {}));
      /* 비밀번호 변경·초기화·사용 중지·삭제가 되면 다른 기기는 자동 로그아웃 */
      Cloud.unsub.push(accRef(acc.id).onSnapshot(function (snap) {
        if (!Cloud.me || snap.metadata.hasPendingWrites) return;
        var a = snap.exists ? snap.data() : null;
        if (!a || a.disabled || (a.sv || 1) !== Cloud.me.sv) { toast(!a ? '계정이 삭제되었습니다.' : a.disabled ? '계정 사용이 중지되었습니다.' : '비밀번호가 바뀌어 다시 로그인해야 합니다.'); logout(true); return; }
        if (a.role !== Cloud.me.role || a.name !== Cloud.me.name) { Cloud.me.role = a.role; Cloud.me.name = a.name; setCloud(); drawNav((location.hash || '#written').slice(1)); }
      }, function () {}));
    });
  }
  /* 새 계정의 첫 로그인: 이전 버전(로그인 없이 저장된 기록)을 이 계정으로 가져올지 묻는다 */
  function offerImport() {
    var guest = null; try { guest = JSON.parse(localStorage.getItem('ise.v1') || 'null'); } catch (e) {}
    var cands = [];
    if (guest && (Object.keys(guest.wrong || {}).length || Object.keys(guest.solved || {}).length || (guest.mockq || []).length)) cands.push({ src: '이 기기', d: guest, b: { items: guest.mockq || [], updatedAt: guest.mqAt || 0 } });
    var legacy = Cloud.cuid ? Promise.all([Cloud.db.doc('data/users/' + Cloud.cuid + '/progress').get(), Cloud.db.doc('data/users/' + Cloud.cuid + '/mockbank').get()]).catch(function () { return null; }) : Promise.resolve(null);
    legacy.then(function (r) {
      if (r && r[0].exists) cands.unshift({ src: '이전 온라인 저장소', d: r[0].data(), b: r[1].exists ? r[1].data() : null });
      if (!cands.length) return;
      var c = cands[0], d = c.d;
      var msg = c.src + '에 로그인 없이 저장했던 기록이 있습니다.\n(오답 ' + Object.keys(d.wrong || {}).length + '개 · 퀴즈 정답 ' + Object.keys(d.solved || {}).length + '개 · 내 모의고사 ' + ((c.b && c.b.items) || []).length + '문항)\n\n이 계정(' + Cloud.me.id + ')으로 가져올까요?';
      if (!confirm(msg)) return;
      applyProg(Object.assign({}, d, { daily: d.daily || {}, mockHist: d.mockHist || [] }));
      if (c.b) applyBank(c.b);
      save(); save('mq'); remoteRefresh('이전 기록을 ' + Cloud.me.id + ' 계정으로 가져왔습니다.');
    });
  }
  function cloudInit() {
    var C = window.claude;
    if (!C || typeof C.use !== 'function') { setCloud('local', 'claude.ai 밖에서 열어 이 브라우저에만 저장합니다.'); return; }
    setCloud('wait', ''); showGate('wait');
    C.use('sample').then(function (x) { Cloud.sample = x; }, function () {});
    C.use('downloads').then(function (x) { Cloud.dl = x; }, function () {});
    Promise.all([C.use('db'), C.use('user')]).then(function (r) {
      var db = r[0], user = r[1];
      if (!db) { setCloud('local', 'DB 사용 불가(로그아웃 또는 권한 없음)'); showGate('nodb'); return; }
      Cloud.db = db;
      return (user ? user.id().catch(function () { return null; }) : Promise.resolve(null)).then(function (cuid) {
        Cloud.cuid = cuid;
        return ensureAdmin().then(function () {
          var s = readSession();
          if (!s || !s.id) { setCloud('login', ''); showGate('login'); return; }
          return accRef(s.id).get().then(function (snap) {
            var a = snap.exists ? snap.data() : null;
            if (!a || a.disabled || (a.sv || 1) !== s.sv) { writeSession({ last: s.id }); setCloud('login', ''); showGate('login'); return; }
            return startSession(a);
          });
        });
      });
    }).catch(function (e) {
      setCloud('local', 'DB 연결 실패(' + ((e && e.code) || '오류') + ')'); showGate('nodb');
    });
    window.addEventListener('pagehide', function () { if (Cloud.state === 'on') cloudSaveAll(); });
    document.addEventListener('visibilitychange', function () { if (document.hidden && Cloud.state === 'on') cloudSaveAll(); });
  }

  /* ── 모달(내 계정 · 비밀번호 변경) ── */
  function closeModal() { var m = document.getElementById('modal'); if (m) m.remove(); }
  function openModal(html, locked) {
    closeModal();
    var m = document.createElement('div'); m.id = 'modal';
    m.innerHTML = '<div class="mbox" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(m);
    if (!locked) m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-close]')) closeModal(); });
    return m;
  }
  function openAccount() {
    if (!Cloud.me) return;
    var m = openModal('<h2>내 계정</h2><table class="tbl kv"><tbody><tr><th>아이디</th><td>' + esc(Cloud.me.id) + '</td></tr><tr><th>이름</th><td>' + esc(Cloud.me.name) + '</td></tr><tr><th>권한</th><td>' + (isAdmin() ? '관리자(슈퍼유저)' : '일반 사용자') + '</td></tr><tr><th>저장소</th><td>' + esc(CLOUD_TXT[Cloud.state]) + '</td></tr></tbody></table>' +
      '<div class="row"><button class="pri" id="aPw">🔑 비밀번호 변경</button>' + (isAdmin() ? '<button id="aAdm">👥 사용자 관리</button>' : '') + '<button id="aOut" class="danger">로그아웃</button><button data-close>닫기</button></div>');
    m.querySelector('#aPw').addEventListener('click', function () { openPwModal(false); });
    m.querySelector('#aOut').addEventListener('click', function () { logout(false); });
    var ad = m.querySelector('#aAdm'); if (ad) ad.addEventListener('click', function () { closeModal(); location.hash = '#admin'; });
  }
  function openPwModal(forced) {
    var m = openModal('<h2>🔑 비밀번호 변경</h2>' + (forced ? '<p class="banner ng" style="display:block">처음 로그인했거나 관리자가 비밀번호를 초기화했습니다. 새 비밀번호로 바꿔야 계속할 수 있습니다.</p>' : '') +
      '<div class="field"><label for="pCur">현재 비밀번호</label><input type="password" id="pCur" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pNew">새 비밀번호 (4자 이상)</label><input type="password" id="pNew" autocomplete="new-password"></div>' +
      '<div class="field"><label for="pNew2">새 비밀번호 확인</label><input type="password" id="pNew2" autocomplete="new-password"></div>' +
      '<p class="status err" id="pErr"></p><div class="row"><button class="pri" id="pOk">변경</button>' + (forced ? '<button id="pOut">로그아웃</button>' : '<button data-close>취소</button>') + '</div>' +
      '<p class="note">비밀번호를 바꾸면 다른 기기에서는 자동으로 로그아웃됩니다. 다른 사이트에서 쓰는 비밀번호는 쓰지 마세요.</p>', forced);
    m.querySelector('#pCur').focus();
    var po = m.querySelector('#pOut'); if (po) po.addEventListener('click', function () { logout(false); });
    m.querySelector('#pOk').addEventListener('click', function () {
      var cur = m.querySelector('#pCur').value, nw = m.querySelector('#pNew').value, nw2 = m.querySelector('#pNew2').value, er = m.querySelector('#pErr');
      if (nw.length < 4) { er.textContent = '새 비밀번호는 4자 이상이어야 합니다.'; return; }
      if (nw !== nw2) { er.textContent = '새 비밀번호 확인이 일치하지 않습니다.'; return; }
      if (nw === cur) { er.textContent = '현재 비밀번호와 다른 비밀번호를 쓰세요.'; return; }
      if (Cloud.me.id === 'admin' && nw === 'admin') { er.textContent = '기본 비밀번호(admin)는 쓸 수 없습니다.'; return; }
      var btn = m.querySelector('#pOk'); btn.disabled = true; er.textContent = '';
      accRef(Cloud.me.id).get().then(function (s) {
        var a = s.data();
        return hashPw(cur, a.salt).then(function (h) {
          if (h !== a.hash) { er.textContent = '현재 비밀번호가 맞지 않습니다.'; btn.disabled = false; return; }
          return pwFields(nw).then(function (pf) {
            var sv = (a.sv || 1) + 1;
            Cloud.me.sv = sv; writeSession({ id: Cloud.me.id, sv: sv, last: Cloud.me.id });
            return retrying(function () { return accRef(Cloud.me.id).update({ salt: pf.salt, hash: pf.hash, mustChange: false, sv: sv, pwChangedAt: Date.now() }); }).then(function () {
              closeModal(); toast('비밀번호를 변경했습니다.');
            });
          });
        });
      }).catch(function (e) { er.textContent = '변경 실패: ' + ((e && (e.code || e.message)) || '오류'); btn.disabled = false; Cloud.me.sv = (readSession() || {}).sv; });
    });
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
  /* 회차 목록: 기본 1~5회 + 내가 입력한 문제로 생긴 6회 이후 */
  function roundsOf(src) {
    return Object.keys(QDATA[src]).map(Number).filter(function (n) { return n <= 5 || (QDATA[src][n] || []).length; }).sort(function (a, b) { return a - b; });
  }
  function mockAll() {
    var a = [];
    roundsOf('mock').forEach(function (n) { a = a.concat(QDATA.mock[n] || []); });
    return a;
  }
  /* 내가 입력한 모의고사 문제(store.mockq)를 QDATA.mock / QDATA.mockP의 해당 회차 뒤에 붙인다 */
  function rebuildUserMocks() {
    ['mock', 'mockP'].forEach(function (src) {
      Object.keys(QDATA[src]).forEach(function (n) {
        QDATA[src][n] = QDATA[src][n].filter(function (q) { return !q.umock; });
        if (+n > 5 && !QDATA[src][n].length) delete QDATA[src][n];
      });
    });
    (store.mockq || []).forEach(function (m) {
      var src = m.type === 'practical' ? 'mockP' : 'mock', n = parseInt(m.round, 10) || 1;
      (QDATA[src][n] = QDATA[src][n] || []).push({ id: m.id, type: m.type === 'practical' ? 'practical' : 'written', mock: n,
        subject: m.subject || '사용자추가', q: m.q, a: m.a, unordered: !!m.unordered, user: true, umock: true });
    });
  }
  rebuildUserMocks();
  function mockOpts(sel) {
    var rs = roundsOf('mock'); roundsOf('mockP').forEach(function (n) { if (rs.indexOf(n) < 0) rs.push(n); });
    return rs.sort(function (a, b) { return a - b; }).map(function (n) {
      return '<option value="mock:' + n + '"' + (sel === 'mock:' + n ? ' selected' : '') + '>모의고사 ' + n + '회</option>';
    }).join('');
  }
  function subjOk(q, subj) {
    if (!subj) return true;
    if (subj === 'mock:all') return !!q.mock;
    if (subj === 'base') return !q.mock;
    if (subj.indexOf('mock:') === 0) return String(q.mock) === subj.slice(5);
    return q.subject === subj;
  }
  function mockPAll() {
    var a = [];
    roundsOf('mockP').forEach(function (n) { a = a.concat(QDATA.mockP[n] || []); });
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
  /* 오답노트 담기: 어느 화면이든 data-wr 버튼 하나로 담고 빼기(전역 위임 리스너가 처리) */
  function isWrong(id) { return !!store.wrong[id]; }
  function toggleWrong(id) {
    if (store.wrong[id]) delete store.wrong[id]; else store.wrong[id] = Date.now();
    save(); return !!store.wrong[id];
  }
  function wrBtnHTML(id, short) {
    var on = isWrong(id);
    return '<button class="wrbtn' + (on ? ' on' : '') + '" data-wr="' + id + '"' + (short ? ' data-short="1"' : '') +
      ' title="' + (on ? '오답노트에서 빼기' : '오답노트에 담기') + '" aria-pressed="' + on + '">' +
      (short ? (on ? '✔📝' : '📝') : (on ? '✔ 오답노트' : '＋ 오답노트')) + '</button>';
  }
  function qNo(q) {
    if (q.mock) {
      var ml = q.type === 'practical' ? QDATA.mockP[q.mock] : QDATA.mock[q.mock];
      return (q.type === 'practical' ? 'MP' : 'M') + q.mock + '-' + (ml.indexOf(q) + 1);
    }
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
    { id: 'bookmarks', plate: '07', label: '북마크', view: viewBookmarks, cnt: function () { return Object.keys(store.bookmarks).length; } },
    { id: 'stats', plate: '08', label: '학습기록', view: viewStats, cnt: function () { return Cloud.state === 'on' ? '☁' : ''; } },
    { id: 'admin', plate: '09', label: '사용자', view: viewAdmin, cnt: function () { return ''; }, admin: true }
  ];
  function drawNav(cur) {
    document.getElementById('nav').innerHTML = ROUTES.filter(function (r) { return !r.admin || isAdmin(); }).map(function (r) {
      return '<a href="#' + r.id + '" class="' + (r.id === cur ? 'on' : '') + '"><span class="plate">' + r.plate + '</span><span>' + r.label + '</span><span class="cnt">' + r.cnt() + '</span></a>';
    }).join('');
  }
  function route() {
    var id = (location.hash || '#written').slice(1);
    var r = ROUTES.filter(function (x) { return x.id === id && (!x.admin || isAdmin()); })[0] || ROUTES[0];
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
      spkBtnsHTML(q.id) + bmBtnHTML(q.id, true) + wrBtnHTML(q.id) +
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
      '<div class="rowbtns">' + spkBtnsHTML(q.id) + bmBtnHTML(q.id, true) + wrBtnHTML(q.id) + (q.user ? '<button class="sm danger" data-del="' + q.id + '">삭제</button>' : '') + '</div></td></tr>';
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
      '<div class="kc-btns"><button class="sm pri spk" data-spk="' + q.id + ':qa" title="문제·정답 듣기">🔊 듣기</button>' + bmBtnHTML(q.id, true) + wrBtnHTML(q.id) +
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
      if (e.target.closest('[data-wr]')) return; // 전역 리스너가 처리
      var g = e.target.closest('[data-grade]');
      if (g) {
        var gid = g.getAttribute('data-grade'), blanks = listRowBlanks[gid], q = findQ(gid);
        if (!blanks || !q) return;
        var okc = gradeBlanks(q, blanks), all = okc === blanks.length;
        blanks.forEach(function (b) { b.inp.classList.toggle('ok', b.ok); b.inp.classList.toggle('ng', !b.ok); });
        logEv({ k: 'list', t: type, id: gid, ok: all, sc: [okc, blanks.length] });
        var rv = g.closest('tr').querySelector('.reveal-inline');
        rv.className = 'reveal-inline ' + (all ? 'ok' : 'ng');
        rv.textContent = (all ? '정답입니다! ' : '오답이 있습니다. ') + okc + ' / ' + blanks.length + ' 빈칸' +
          (!all && !isWrong(gid) ? ' · ＋ 오답노트로 담아 두세요' : '');
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
  var mockUI = { view: 'quiz', qs: null, type: 'written', n: 1, running: false, hide: false, only: false, t0: 0, elapsed: 0, timer: null };
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
  function mockRounds(type) { return roundsOf(MTYPE[type].src); }
  /* ───────── 모의고사: 퀴즈 형식(기본 화면) ─────────
     한 문제씩 카드로 풀고, 빈칸 채점 → store.mockRes 자동 표시 → 끝나면 결과 화면과 점수 자동 기록.
     mockUI.view === 'table'이면 예전 표 화면(viewMockTable). */
  function viewMock() { return mockUI.view === 'table' ? viewMockTable() : viewMockQuiz(); }
  function viewMockQuiz() {
    var ui = mockUI, type = ui.type, rounds = mockRounds(type);
    if (rounds.indexOf(ui.n) < 0) ui.n = rounds[0] || 1;
    var n = ui.n, list = mockList(type, n), mt = MTYPE[type], key = type + ':' + n;
    var S = ui.qs;
    if (!S || S.key !== key) S = ui.qs = { key: key, stage: 'ready', ids: [], i: 0, t0: 0, ms: 0, vals: {}, shown: {}, retry: false, recorded: false };
    S.ids = S.ids.filter(function (id) { return list.some(function (q) { return q.id === id; }); });
    root.innerHTML =
      head('모의고사', '실제 시험처럼 <b>한 문제씩 빈칸을 채워 푸는 퀴즈 형식</b>입니다. 채점하면 맞음/틀림이 자동으로 표시되고, 마지막 문제를 끝내면 점수가 학습기록' + (Cloud.state === 'on' ? '(DB)' : '') + '에 저장됩니다.',
        '<span class="tag">' + mt.label + ' ' + n + '회 · ' + list.length + '문항</span>') +
      '<div class="seg seg-type" id="tseg"><button data-t="written" class="' + (type === 'written' ? 'on' : '') + '">필답형 모의고사</button><button data-t="practical" class="' + (type === 'practical' ? 'on' : '') + '">작업형 모의고사</button></div>' +
      '<div class="seg seg-r" id="seg">' + rounds.map(function (k) {
        var s = mockStat(type, k), mine = mockList(type, k).some(function (q) { return q.umock; });
        return '<button data-n="' + k + '" class="' + (k === n ? 'on' : '') + '">' + k + '회' + (mine ? '<i class="mine">✏</i>' : '') + '<small>' + s.o + '/' + s.t + '</small></button>';
      }).join('') + '</div>' +
      '<div class="bar"><button class="sm" id="mview">📋 표로 보기</button><button class="sm dark" id="mnew">＋ 문제 입력</button><span class="meta" id="mtime"></span></div>' +
      '<div id="medit"></div><div id="mq" class="qwrap"></div>';

    function $(id) { return document.getElementById(id); }
    function tick() { var el = $('mtime'); if (el && S.stage === 'run') el.textContent = '경과 ' + fmtT(Date.now() - S.t0); }
    function startTimer() { clearInterval(ui.timer); ui.timer = setInterval(tick, 1000); tick(); }
    function q(i) { return findQ(S.ids[i]); }
    function res(id) { return store.mockRes[id] || ''; }
    function sessStat() {
      var o = 0, x = 0; S.ids.forEach(function (id) { var r = res(id); if (r === 'o') o++; else if (r === 'x') x++; });
      return { o: o, x: x, t: S.ids.length };
    }

    function drawReady() {
      clearInterval(ui.timer); $('mtime').textContent = '';
      var s = mockStat(type, n), xs = list.filter(function (q) { return res(q.id) === 'x'; }), un = s.t - s.o - s.x;
      var partial = s.o + s.x > 0 && un > 0;
      $('mq').innerHTML = '<div class="qcard mstart"><div class="qh"><span class="no">' + mt.label + ' 모의고사 ' + n + '회</span><span>' + list.length + '문항 · 빈칸 채우기</span></div><div class="qb">' +
        (list.length ? '<table class="tbl kv"><tbody>' +
          '<tr><th>문항 수</th><td>' + list.length + '문항 (' + (type === 'written' ? '필답형: 정답의 핵심어·수치' : '작업형: 위험요인·안전조치의 핵심 용어') + '를 빈칸에 입력)</td></tr>' +
          '<tr><th>지난 기록</th><td>맞음 <b>' + s.o + '</b> · 틀림 <b>' + s.x + '</b> · 미채점 <b>' + un + '</b>' + (s.o + s.x ? ' · 정답률 <b>' + Math.round(s.o / s.t * 100) + '%</b>' : '') + '</td></tr>' +
          '<tr><th>채점 방법</th><td>빈칸을 모두 맞혀야 “맞음”. Enter로 다음 빈칸 → 채점 → 다음 문제</td></tr></tbody></table>' +
          '<div class="qact"><button class="pri" id="qsNew">▶ 처음부터 풀기</button>' +
          (partial ? '<button id="qsCont">이어 풀기 (' + (s.o + s.x) + '/' + s.t + ')</button>' : '') +
          (xs.length ? '<button id="qsWrong">🔁 틀린 ' + xs.length + '문제만 다시</button>' : '') + '</div>'
          : '<p class="empty">이 회차에 문제가 없습니다. ＋ 문제 입력으로 추가하세요.</p>') +
        '</div></div>';
      if ($('qsNew')) $('qsNew').addEventListener('click', function () {
        var had = list.some(function (q) { return res(q.id); });
        if (had && !confirm(mt.label + ' ' + n + '회의 지난 채점 표시를 지우고 처음부터 풀까요?\n(학습기록에 남은 점수는 지워지지 않습니다)')) return;
        list.forEach(function (q) { delete store.mockRes[q.id]; }); save();
        begin(list.map(function (q) { return q.id; }), 0, false);
      });
      if ($('qsCont')) $('qsCont').addEventListener('click', function () {
        var ids = list.map(function (q) { return q.id; }), first = 0;
        for (var k = 0; k < ids.length; k++) if (!res(ids[k])) { first = k; break; }
        begin(ids, first, false);
      });
      if ($('qsWrong')) $('qsWrong').addEventListener('click', function () {
        var ids = xs.map(function (q) { return q.id; });
        ids.forEach(function (id) { delete store.mockRes[id]; }); save();
        begin(ids, 0, true);
      });
    }
    function begin(ids, i, retry) {
      S.ids = ids; S.i = i; S.stage = 'run'; S.t0 = Date.now(); S.ms = 0; S.vals = {}; S.shown = {}; S.retry = retry; S.recorded = false;
      startTimer(); drawQ(); window.scrollTo(0, 0);
    }
    function dotsHTML() {
      return '<div class="mdots">' + S.ids.map(function (id, k) {
        var r = res(id);
        return '<button data-j="' + k + '" class="' + (r ? r : '') + (k === S.i ? ' cur' : '') + '" title="' + (k + 1) + '번">' + (k + 1) + '</button>';
      }).join('') + '</div>';
    }
    function drawQ() {
      var cur = q(S.i); if (!cur) { finish(); return; }
      var st = sessStat(), blanks = hasBlanks(cur), r = res(cur.id);
      $('mq').innerHTML =
        '<div class="prog"><i style="width:' + Math.round((st.o + st.x) / st.t * 100) + '%"></i></div>' +
        '<div class="stat">' + (S.retry ? '틀린 문제 다시 · ' : '') + '맞음 <b>' + st.o + '</b> · 틀림 <b>' + st.x + '</b> · 남음 <b>' + (st.t - st.o - st.x) + '</b></div>' +
        dotsHTML() +
        '<div class="qcard" data-id="' + cur.id + '"><div class="qh"><span class="no">' + qNo(cur) + ' · ' + (S.i + 1) + ' / ' + S.ids.length + '</span><span>' + iconFor(cur.subject) + ' ' + esc(cur.subject) + (cur.umock ? ' · 내 입력' : '') + '</span></div>' +
        '<div class="qb"><p class="qtext">' + esc(cur.q) + '</p><div id="mab"></div><div class="banner" id="mbn"></div><div id="mrv"></div>' +
        '<div class="qact">' +
        (blanks ? '<button class="pri" id="mg">채점</button>' : '<button class="o-btn" data-self="o">맞음</button><button class="x-btn" data-self="x">틀림</button>') +
        '<button id="ms">정답 보기</button><button class="spk" data-spk="' + cur.id + ':q" title="문제 듣기">🔊문제</button>' + bmBtnHTML(cur.id, true) + wrBtnHTML(cur.id) + '</div></div>' +
        '<div class="qnav"><button id="mp">◀ 이전</button><button class="dark" id="mn">' + (S.i === S.ids.length - 1 ? '결과 보기 ▶' : '다음 ▶') + '</button><button class="sm danger" id="mend">시험 종료</button></div></div>';
      var ab = buildAnswer(cur); $('mab').appendChild(ab.box);
      var saved = S.vals[cur.id];
      if (saved) ab.blanks.forEach(function (b, k) { b.inp.value = saved[k] || ''; });
      function reveal() { $('mrv').innerHTML = '<div class="reveal"><b>정답</b>' + ansHTML(cur.a) + '</div>'; S.shown[cur.id] = true; }
      function showGrade(record) {
        var okc = gradeBlanks(cur, ab.blanks), all = okc === ab.blanks.length;
        ab.blanks.forEach(function (b) {
          b.inp.classList.toggle('ok', b.ok); b.inp.classList.toggle('ng', !b.ok);
          if (!b.ok && !cur.unordered && !b.corr) { var s = document.createElement('span'); s.className = 'corr'; s.textContent = '(' + b.accepts[0] + ')'; b.inp.parentNode.insertBefore(s, b.inp.nextSibling); b.corr = s; }
        });
        var bn = $('mbn'); bn.className = 'banner ' + (all ? 'ok' : 'ng');
        bn.textContent = (all ? '정답입니다! ' : '오답이 있습니다. ') + okc + ' / ' + ab.blanks.length + ' 빈칸 → ' + (all ? '맞음' : '틀림');
        reveal();
        if (record) {
          S.vals[cur.id] = ab.blanks.map(function (b) { return b.inp.value; });
          store.mockRes[cur.id] = all ? 'o' : 'x'; save();
          logEv({ k: 'mockq', t: type, n: n, id: cur.id, ok: all, sc: [okc, ab.blanks.length] });
          var d = document.querySelector('.mdots [data-j="' + S.i + '"]'); if (d) d.className = (all ? 'o' : 'x') + ' cur';
          var s2 = sessStat(); document.querySelector('#mq .stat').innerHTML = (S.retry ? '틀린 문제 다시 · ' : '') + '맞음 <b>' + s2.o + '</b> · 틀림 <b>' + s2.x + '</b> · 남음 <b>' + (s2.t - s2.o - s2.x) + '</b>';
          document.querySelector('#mq .prog i').style.width = Math.round((s2.o + s2.x) / s2.t * 100) + '%';
          $('mn').focus({ preventScroll: true });
        }
      }
      if (blanks && saved && r) showGrade(false);
      else if (r || S.shown[cur.id]) { reveal(); if (r) { var bn0 = $('mbn'); bn0.className = 'banner ' + (r === 'o' ? 'ok' : 'ng'); bn0.textContent = r === 'o' ? '맞음으로 채점됨' : '틀림으로 채점됨'; } }
      if ($('mg')) $('mg').addEventListener('click', function () {
        if (!ab.blanks.some(function (b) { return b.inp.value.trim(); })) { toast('빈칸에 답을 입력한 뒤 채점하세요. 모르면 “정답 보기”를 누르세요.'); ab.blanks[0].inp.focus(); return; }
        showGrade(true);
      });
      Array.prototype.forEach.call(document.querySelectorAll('#mq [data-self]'), function (b) {
        b.addEventListener('click', function () {
          var v = b.getAttribute('data-self'); store.mockRes[cur.id] = v; save(); reveal();
          logEv({ k: 'mark', t: type, n: n, id: cur.id, r: v }); drawQ();
        });
      });
      $('ms').addEventListener('click', function () {
        reveal();
        if (blanks && !res(cur.id)) { store.mockRes[cur.id] = 'x'; save(); logEv({ k: 'mockq', t: type, n: n, id: cur.id, ok: false, sc: [0, ab.blanks.length], peek: true }); toast('정답을 먼저 확인한 문제는 “틀림”으로 기록됩니다.'); drawQ(); }
      });
      $('mp').addEventListener('click', function () { if (S.i > 0) { S.i--; drawQ(); } else toast('첫 문제입니다.'); });
      $('mn').addEventListener('click', function () { if (S.i < S.ids.length - 1) { S.i++; drawQ(); window.scrollTo(0, 0); } else finish(); });
      $('mend').addEventListener('click', function () {
        var left = S.ids.filter(function (id) { return !res(id); }).length;
        if (left && !confirm('채점하지 않은 문제가 ' + left + '개 있습니다. 시험을 끝내고 결과를 볼까요?')) return;
        finish();
      });
      document.querySelector('#mq .mdots').addEventListener('click', function (e) {
        var b = e.target.closest('[data-j]'); if (!b) return; S.i = parseInt(b.getAttribute('data-j'), 10); drawQ();
      });
      var bmb = document.querySelector('#mq [data-bm]');
      if (bmb) bmb.addEventListener('click', function () { toggleBM(cur.id); bmb.outerHTML = bmBtnHTML(cur.id, true); drawNav('mock'); drawQ(); });
      ab.blanks.forEach(function (b, k) {
        b.inp.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return; e.preventDefault();
          if (res(cur.id)) { $('mn').click(); return; }
          if (ab.blanks[k + 1]) ab.blanks[k + 1].inp.focus(); else $('mg').click();
        });
      });
      if (!r && ab.blanks[0]) ab.blanks[0].inp.focus({ preventScroll: true });
    }
    function finish() {
      clearInterval(ui.timer);
      if (S.stage === 'run') S.ms = Date.now() - S.t0;
      S.stage = 'done';
      var st = sessStat();
      if (!S.recorded && st.o + st.x > 0) {
        S.recorded = true;
        logEv({ k: 'mock', t: type, n: n, o: st.o, x: st.x, tot: st.t, ms: S.ms, quiz: true, retry: S.retry });
        if (Cloud.state === 'on') cloudWrite('log');
      }
      drawDone();
    }
    function drawDone() {
      $('mtime').textContent = S.ms ? '소요 ' + fmtT(S.ms) : '';
      var st = sessStat(), un = st.t - st.o - st.x, pct = st.t ? Math.round(st.o / st.t * 100) : 0;
      var wrong = S.ids.filter(function (id) { return res(id) !== 'o'; }).map(findQ).filter(Boolean);
      $('mq').innerHTML = '<div class="qcard mresult"><div class="qh"><span class="no">' + mt.label + ' ' + n + '회 결과' + (S.retry ? ' (틀린 문제 다시)' : '') + '</span><span>' + (S.recorded ? (Cloud.state === 'on' ? '☁ 학습기록(DB)에 저장됨' : '💾 학습기록에 저장됨') : '채점한 문제 없음') + '</span></div><div class="qb">' +
        '<div class="score ' + (pct >= 60 ? 'pass' : 'fail') + '"><b>' + st.o + '</b> / ' + st.t + '<span>' + pct + '%</span><em>' + (pct >= 60 ? '합격선(60%) 이상' : '합격선(60%) 미만') + '</em></div>' +
        '<div class="stat">맞음 <b>' + st.o + '</b> · 틀림 <b>' + st.x + '</b> · 미채점 <b>' + un + '</b>' + (S.ms ? ' · 소요 <b>' + fmtT(S.ms) + '</b>' : '') + '</div>' +
        '<div class="qact">' + (wrong.length ? '<button class="pri" id="rdNote">📝 틀린·미채점 ' + wrong.length + '문제 오답노트에 담기</button><button id="rdRetry">🔁 틀린 문제만 다시</button>' : '') +
        '<button id="rdAgain">↺ 처음부터 다시</button><button id="rdTable">📋 표로 보기</button></div>' +
        (wrong.length ? '<h2 class="sub">다시 볼 문제</h2>' + wrong.map(function (q) {
          return '<div class="mwrong"><div class="mw-q"><span class="mono">' + qNo(q) + '</span> <span class="' + (res(q.id) === 'x' ? 'ngc' : 'note') + '">' + (res(q.id) === 'x' ? '틀림' : '미채점') + '</span> ' + esc(q.q) + '</div><div class="reveal">' + ansHTML(q.a) + '</div></div>';
        }).join('') : '<p class="banner ok">모두 맞혔습니다!</p>') +
        '</div></div>';
      if ($('rdNote')) $('rdNote').addEventListener('click', function () {
        var added = 0; wrong.forEach(function (q) { if (!store.wrong[q.id]) { store.wrong[q.id] = Date.now(); added++; } });
        save(); drawNav('mock'); toast(added ? added + '문제를 ' + mt.label + ' 오답노트에 담았습니다.' : '이미 모두 오답노트에 있습니다.');
      });
      if ($('rdRetry')) $('rdRetry').addEventListener('click', function () {
        var ids = wrong.map(function (q) { return q.id; }); ids.forEach(function (id) { delete store.mockRes[id]; }); save(); begin(ids, 0, true);
      });
      $('rdAgain').addEventListener('click', function () { S.stage = 'ready'; drawReady(); });
      $('rdTable').addEventListener('click', function () { ui.view = 'table'; viewMock(); });
    }

    if (S.stage === 'run') { startTimer(); drawQ(); } else if (S.stage === 'done') drawDone(); else drawReady();
    if (ui.editOpen) openMockEditor(ui.editOpen === true ? null : ui.editOpen);

    $('tseg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-t]'); if (!b || b.getAttribute('data-t') === type) return;
      if (S.stage === 'run' && !confirm('푸는 중인 시험을 멈추고 이동할까요? (채점한 문제는 저장되어 있습니다)')) return;
      ui.qs = null; ui.type = b.getAttribute('data-t'); ui.n = 1; ui.editOpen = false; clearInterval(ui.timer); viewMock();
    });
    $('seg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-n]'); if (!b) return;
      var k = parseInt(b.getAttribute('data-n'), 10); if (k === n) return;
      if (S.stage === 'run' && !confirm('푸는 중인 시험을 멈추고 ' + k + '회로 이동할까요? (채점한 문제는 저장되어 있습니다)')) return;
      ui.qs = null; ui.n = k; clearInterval(ui.timer); viewMock();
    });
    $('mview').addEventListener('click', function () { clearInterval(ui.timer); ui.view = 'table'; viewMock(); });
    $('mnew').addEventListener('click', function () { openMockEditor(null); });
  }

  var mockBlanks = {};
  function viewMockTable() {
    var ui = mockUI, type = ui.type, rounds = mockRounds(type);
    if (rounds.indexOf(ui.n) < 0) ui.n = rounds[0] || 1;
    var n = ui.n, list = mockList(type, n), mt = MTYPE[type];
    var userCnt = store.mockq.filter(function (m) { return (m.type === 'practical') === (type === 'practical'); }).length;
    root.innerHTML =
      head('모의고사 · 표로 보기', '한 화면에 전체 문항을 표로 보는 방식입니다. “시작”을 누르면 정답을 가리고 시간을 잽니다. <b>✏ 퀴즈로 풀기</b>를 켜면 정답의 핵심어가 빈칸으로 바뀌어 자동 채점되고, <b>＋ 문제 입력</b>으로 나만의 모의고사 문제를 빈칸 퀴즈 형식으로 넣을 수 있습니다.',
        '<span class="tag">' + mt.label + ' · ' + rounds.length + '회 · 이 회차 ' + list.length + '문항' + (userCnt ? ' · 내 입력 ' + userCnt : '') + '</span>') +
      '<div class="seg seg-type" id="tseg"><button data-t="written" class="' + (type === 'written' ? 'on' : '') + '">필답형 모의고사</button><button data-t="practical" class="' + (type === 'practical' ? 'on' : '') + '">작업형 모의고사</button></div>' +
      '<div class="seg seg-r" id="seg"></div>' +
      '<div class="bar"><button class="sm pri" id="mviewq">🧩 퀴즈 형식으로</button><button class="pri" id="mstart"></button><button id="mshow">정답 확인·채점</button>' +
      '<button id="mquiz" class="' + (ui.quiz ? 'on-t' : '') + '" aria-pressed="' + !!ui.quiz + '">✏ 퀴즈로 풀기' + (ui.quiz ? ' ON' : '') + '</button>' +
      '<label class="chk"><input type="checkbox" id="monly"' + (ui.only ? ' checked' : '') + '> 틀린 문제만</label>' +
      '<button class="sm" id="mwrong" title="이 회차에서 틀림으로 표시한 문제를 모두 오답노트에 담습니다">📝 틀린 문제 오답노트에 담기</button>' +
      '<button class="sm" id="mrec" title="현재 회차의 맞음/틀림 수와 소요 시간을 학습기록(DB)에 남깁니다">📊 점수 기록</button>' +
      '<button class="sm dark" id="mnew">＋ 문제 입력</button>' +
      '<button class="danger sm" id="mreset">채점 초기화</button><span class="meta" id="mtime"></span></div>' +
      '<div id="medit"></div>' +
      '<div class="stat" id="msum" style="margin-bottom:12px"></div>' +
      '<div class="wrap"><table class="tbl list" id="tb"><thead><tr><th>No</th><th>' + (type === 'written' ? '과목' : '분야') + '</th><th>문제</th><th>정답 · 채점</th></tr></thead><tbody id="tbody"></tbody></table></div>';

    function drawSeg() {
      document.getElementById('seg').innerHTML = rounds.map(function (k) {
        var s = mockStat(type, k), mine = mockList(type, k).some(function (q) { return q.umock; });
        return '<button data-n="' + k + '" class="' + (k === n ? 'on' : '') + '">' + k + '회' + (mine ? '<i class="mine">✏</i>' : '') + '<small>' + s.o + '/' + s.t + '</small></button>';
      }).join('');
    }
    function drawSum() {
      var s = mockStat(type, n), un = s.t - s.o - s.x;
      document.getElementById('msum').innerHTML = mt.label + ' ' + n + '회 — 맞음 <b>' + s.o + '</b> · 틀림 <b>' + s.x + '</b> · 미채점 <b>' + un + '</b> · 정답률 <b>' + (s.t ? Math.round(s.o / s.t * 100) : 0) + '%</b>';
    }
    function drawTime() {
      var el = document.getElementById('mtime'); if (!el) return;
      if (ui.running) el.textContent = '경과 ' + fmtT(Date.now() - ui.t0);
      else el.textContent = ui.elapsed ? '소요 ' + fmtT(ui.elapsed) : '';
    }
    function drawBtns() {
      document.getElementById('mstart').textContent = ui.running ? '다시 시작' : '모의고사 시작';
      document.getElementById('tb').classList.toggle('hide', ui.hide);
      drawTime();
    }
    function mkHTML(q, r) {
      return '<div class="mk"><button class="o' + (r === 'o' ? ' on' : '') + '" data-mk="o">맞음</button><button class="x' + (r === 'x' ? ' on' : '') + '" data-mk="x">틀림</button>' +
        '<button class="spk" data-spk="' + q.id + ':qa" title="문제·정답 듣기">🔊</button>' + bmBtnHTML(q.id, false) + wrBtnHTML(q.id, true) +
        (q.umock ? '<button class="sm" data-medit="' + q.id + '" title="내가 입력한 문제 수정">✎</button><button class="sm danger" data-mdel="' + q.id + '" title="삭제">✕</button>' : '') + '</div>';
    }
    function row(q, i) {
      var r = store.mockRes[q.id] || '', qz = ui.quiz && hasBlanks(q);
      return '<tr data-id="' + q.id + '" class="' + (r ? 'r-' + r : '') + (qz ? ' qz' : '') + '"><td class="no">' + (i + 1) + (q.umock ? '<span class="mine-tag">내 입력</span>' : '') + '</td><td class="sj">' + iconFor(q.subject) + '<span class="subj-chip">' + esc(q.subject) + '</span></td>' +
        '<td class="q">' + esc(q.q) + '</td><td class="a">' +
        (qz ? '<div class="blankslot" id="mbs-' + q.id + '"></div><div class="rowbtns"><button class="sm pri" data-mgrade="' + q.id + '">채점</button><button class="sm" data-mshowa="' + q.id + '">정답 보기</button></div><div class="reveal-inline"></div>'
          : '<div class="ans">' + ansHTML(q.a) + '</div><div class="hint-hide">클릭하면 정답이 보입니다</div>') +
        mkHTML(q, r) + '</td></tr>';
    }
    function drawRows() {
      var h = '', shown = [];
      list.forEach(function (q, i) { if (!ui.only || store.mockRes[q.id] === 'x') { h += row(q, i); shown.push(q); } });
      if (!h) h = '<tr><td colspan="4" class="empty">' + (ui.only ? '틀림으로 표시한 문제가 없습니다.' : '문제가 없습니다. ＋ 문제 입력으로 추가해 보세요.') + '</td></tr>';
      document.getElementById('tbody').innerHTML = h;
      mockBlanks = {};
      if (ui.quiz) shown.forEach(function (q) {
        var slot = document.getElementById('mbs-' + q.id); if (!slot) return;
        var ab = buildAnswer(q); mockBlanks[q.id] = ab.blanks; slot.appendChild(ab.box);
      });
    }
    function startTimer() { clearInterval(ui.timer); ui.timer = setInterval(drawTime, 1000); }
    function resetState() { clearInterval(ui.timer); ui.running = false; ui.hide = false; ui.elapsed = 0; ui.only = false; }
    function setRes(tr, id, v) {
      if (v) store.mockRes[id] = v; else delete store.mockRes[id];
      save();
      var cur = store.mockRes[id] || '';
      tr.classList.remove('r-o', 'r-x'); if (cur) tr.classList.add('r-' + cur);
      tr.querySelector('button.o').classList.toggle('on', cur === 'o');
      tr.querySelector('button.x').classList.toggle('on', cur === 'x');
      drawSeg(); drawSum();
      return cur;
    }

    drawRows(); drawSeg(); drawSum(); drawBtns();
    if (ui.running) startTimer();
    if (ui.editOpen) openMockEditor(ui.editOpen === true ? null : ui.editOpen);

    document.getElementById('tseg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-t]'); if (!b) return;
      resetState(); ui.type = b.getAttribute('data-t'); ui.n = 1; ui.editOpen = false; viewMock();
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
      if (ui.running) { ui.elapsed = Date.now() - ui.t0; ui.running = false; clearInterval(ui.timer); toast('소요 시간 ' + fmtT(ui.elapsed) + ' · 채점 후 📊 점수 기록을 누르면 학습기록에 남습니다.'); }
      ui.hide = false; drawBtns();
    });
    document.getElementById('mquiz').addEventListener('click', function () {
      ui.quiz = !ui.quiz; viewMock();
      toast(ui.quiz ? '퀴즈로 풀기: 빈칸을 채우고 채점하면 맞음/틀림이 자동 표시됩니다.' : '자가 채점 모드로 돌아왔습니다.');
    });
    document.getElementById('monly').addEventListener('change', function (e) { ui.only = e.target.checked; drawRows(); });
    document.getElementById('mwrong').addEventListener('click', function () {
      var xs = list.filter(function (q) { return store.mockRes[q.id] === 'x'; });
      if (!xs.length) { toast('틀림으로 표시한 문제가 없습니다. 채점에서 “틀림”을 먼저 눌러 주세요.'); return; }
      var added = 0;
      xs.forEach(function (q) { if (!store.wrong[q.id]) { store.wrong[q.id] = Date.now(); added++; } });
      save(); drawRows(); drawNav('mock');
      toast(added ? '틀린 문제 ' + added + '개를 ' + mt.label + ' 오답노트에 담았습니다.' : '이미 모두 오답노트에 담겨 있습니다.');
    });
    document.getElementById('mrec').addEventListener('click', function () {
      var s = mockStat(type, n);
      if (!s.o && !s.x) { toast('채점한 문항이 없습니다. 맞음/틀림을 먼저 표시하거나 퀴즈로 풀어 주세요.'); return; }
      var ms = ui.running ? Date.now() - ui.t0 : (ui.elapsed || 0);
      logEv({ k: 'mock', t: type, n: n, o: s.o, x: s.x, tot: s.t, ms: ms, quiz: !!ui.quiz });
      if (Cloud.state === 'on') cloudWrite('log');
      toast(mt.label + ' ' + n + '회 점수(' + s.o + '/' + s.t + ')를 학습기록' + (Cloud.state === 'on' ? '(DB)' : '') + '에 남겼습니다.');
    });
    document.getElementById('mnew').addEventListener('click', function () { openMockEditor(null); });
    document.getElementById('mviewq').addEventListener('click', function () { resetState(); ui.view = 'quiz'; ui.qs = null; viewMock(); });
    document.getElementById('mreset').addEventListener('click', function () {
      if (!confirm(mt.label + ' ' + n + '회 채점 기록을 초기화할까요?')) return;
      list.forEach(function (q) { delete store.mockRes[q.id]; });
      save(); viewMock();
    });
    document.getElementById('tbody').addEventListener('click', function (e) {
      if (e.target.closest('[data-wr]')) return; // 전역 리스너가 처리
      var bm = e.target.closest('[data-bm]');
      if (bm) { toggleBM(bm.getAttribute('data-bm')); bm.outerHTML = bmBtnHTML(bm.getAttribute('data-bm'), false); drawNav('bookmarks'); return; }
      var ed = e.target.closest('[data-medit]');
      if (ed) { openMockEditor(ed.getAttribute('data-medit')); return; }
      var dl = e.target.closest('[data-mdel]');
      if (dl) { deleteMockQ(dl.getAttribute('data-mdel')); return; }
      var g = e.target.closest('[data-mgrade]');
      if (g) {
        var gid = g.getAttribute('data-mgrade'), blanks = mockBlanks[gid], q = findQ(gid);
        if (!blanks || !q) return;
        var okc = gradeBlanks(q, blanks), all = okc === blanks.length, tr = g.closest('tr');
        blanks.forEach(function (b) { b.inp.classList.toggle('ok', b.ok); b.inp.classList.toggle('ng', !b.ok); });
        var rv = tr.querySelector('.reveal-inline');
        rv.className = 'reveal-inline ' + (all ? 'ok' : 'ng');
        rv.innerHTML = esc((all ? '정답입니다! ' : '오답이 있습니다. ') + okc + ' / ' + blanks.length + ' 빈칸 → ' + (all ? '맞음' : '틀림') + ' 표시') +
          (all ? '' : '<div class="reveal"><b>정답</b>' + ansHTML(q.a) + '</div>');
        setRes(tr, gid, all ? 'o' : 'x');
        logEv({ k: 'mockq', t: type, n: n, id: gid, ok: all, sc: [okc, blanks.length] });
        return;
      }
      var sa = e.target.closest('[data-mshowa]');
      if (sa) {
        var q2 = findQ(sa.getAttribute('data-mshowa')), rv2 = sa.closest('tr').querySelector('.reveal-inline');
        rv2.className = 'reveal-inline'; rv2.innerHTML = '<div class="reveal"><b>정답</b>' + ansHTML(q2.a) + '</div>';
        return;
      }
      var mk = e.target.closest('button[data-mk]');
      if (mk) {
        var tr2 = mk.closest('tr'), id = tr2.getAttribute('data-id'), v = mk.getAttribute('data-mk');
        var cur = setRes(tr2, id, store.mockRes[id] === v ? '' : v);
        logEv({ k: 'mark', t: type, n: n, id: id, r: cur });
        return;
      }
      var td = e.target.closest('td.a');
      if (td && ui.hide && !e.target.closest('input')) td.parentNode.classList.toggle('shown');
    });
    document.getElementById('tbody').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target.classList.contains('blank')) return;
      e.preventDefault();
      var tr = e.target.closest('tr'), ins = Array.prototype.slice.call(tr.querySelectorAll('input.blank')), k = ins.indexOf(e.target);
      if (ins[k + 1]) ins[k + 1].focus(); else { var gb = tr.querySelector('[data-mgrade]'); if (gb) gb.click(); }
    });
  }

  /* ───────── 모의고사 문제 입력(퀴즈 형식) ─────────
     store.mockq = [{ id, type, round, subject, q, a, unordered, createdAt, updatedAt }]
     정답의 {{핵심어}}가 빈칸이 되고, {{정답|다른표현}}으로 인정 답안을 여러 개 둔다. */
  function nextRound(type) { var rs = mockRounds(type); return (rs.length ? rs[rs.length - 1] : 5) + 1; }
  function deleteMockQ(id) {
    var m = store.mockq.filter(function (x) { return x.id === id; })[0]; if (!m) return;
    if (!confirm('내가 입력한 이 문제를 삭제할까요?\n' + m.q.slice(0, 60))) return;
    store.mockq = store.mockq.filter(function (x) { return x.id !== id; });
    delete store.wrong[id]; delete store.bookmarks[id]; delete store.mockRes[id];
    save('mq'); save(); rebuildUserMocks(); drawNav('mock'); updateFAB(); viewMock(); toast('삭제했습니다.');
  }
  function addMockQ(rec) {
    var dup = store.mockq.concat(mockAll(), mockPAll()).some(function (x) { return x.q === rec.q && x.id !== rec.id; });
    if (dup) return '이미 같은 문제 문장이 있습니다.';
    var i = -1;
    store.mockq.forEach(function (x, k) { if (x.id === rec.id) i = k; });
    if (i >= 0) store.mockq[i] = rec; else store.mockq.push(rec);
    return '';
  }
  function parseBulk(text) {
    var out = [];
    String(text).replace(/\r/g, '').split(/^\s*-{3,}\s*$/m).forEach(function (blk) {
      var cur = null, rec = { s: '', q: '', a: '', u: false };
      blk.split('\n').forEach(function (line) {
        var m = line.match(/^\s*(과목|분야|문제|정답|순서무관)\s*[:：]\s?(.*)$/);
        if (m) {
          cur = m[1];
          if (cur === '과목' || cur === '분야') rec.s = m[2].trim();
          else if (cur === '순서무관') rec.u = /^(예|o|y|yes|true|1)/i.test(m[2].trim());
          else rec[cur === '문제' ? 'q' : 'a'] = m[2];
        } else if (cur === '문제' || cur === '정답') rec[cur === '문제' ? 'q' : 'a'] += '\n' + line;
      });
      rec.q = rec.q.trim(); rec.a = rec.a.replace(/\s+$/, '').replace(/^\n+/, '');
      if (rec.q && rec.a) out.push(rec);
    });
    return out;
  }
  function openMockEditor(editId) {
    var ui = mockUI, box = document.getElementById('medit'); if (!box) return;
    var m = editId ? store.mockq.filter(function (x) { return x.id === editId; })[0] : null;
    ui.editOpen = m ? m.id : true;
    var type = m ? m.type : ui.type;
    var subjList = subjects(type).filter(function (s) { return s !== '사용자추가'; });
    box.innerHTML = '<section class="card medit">' +
      '<h2><span class="n">✏</span>' + (m ? '내 모의고사 문제 수정' : '모의고사 문제 입력 — 빈칸 퀴즈 형식') + '</h2>' +
      '<div class="mgrid">' +
      '<div class="field"><label for="me-t">유형</label><select id="me-t"><option value="written">필답형</option><option value="practical">작업형</option></select></div>' +
      '<div class="field"><label for="me-n">회차</label><select id="me-n"></select></div>' +
      '<div class="field"><label for="me-s">과목·분야</label><input type="text" id="me-s" list="me-sl" placeholder="예) 산업안전관리론"><datalist id="me-sl">' + subjList.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist></div>' +
      '</div>' +
      '<div class="field"><label for="me-q">문제</label><textarea id="me-q" rows="3" placeholder="예) 안전보건관리책임자의 업무를 3가지 쓰시오."></textarea></div>' +
      '<div class="field"><label for="me-a">정답 — 외울 핵심어를 드래그해 선택한 뒤 [빈칸 만들기]. 인정 답안은 {{정답|다른표현}}</label>' +
      '<textarea id="me-a" rows="6" placeholder="예) ① {{산업재해 예방계획}}의 수립\n② {{안전보건관리규정}}의 작성 및 변경"></textarea></div>' +
      '<div class="row"><button class="sm pri" id="me-blank">[ ] 선택 → 빈칸 만들기</button><button class="sm" id="me-alt">｜ 인정 답안 추가</button><button class="sm" id="me-unblank">선택 영역 빈칸 해제</button>' +
      '<label class="chk"><input type="checkbox" id="me-u"> 순서 무관 채점(나열형)</label><span class="meta" id="me-cnt"></span></div>' +
      '<div class="field"><label>미리 풀어 보기 (저장 전 빈칸이 제대로 나오는지 확인)</label><div id="me-prev" class="me-prev"></div>' +
      '<div class="row"><button class="sm" id="me-try">미리 채점</button><span class="status" id="me-st"></span></div></div>' +
      '<div class="row"><button class="pri" id="me-save">' + (m ? '수정 저장' : '저장') + '</button>' + (m ? '' : '<button id="me-more">저장 후 계속 입력</button>') + '<button id="me-close">닫기</button>' +
      '<span class="note">' + (Cloud.state === 'on' ? '☁ 저장하면 DB(본인 전용 영역)에 함께 기록됩니다.' : '💾 이 브라우저에 저장됩니다.') + '</span></div>' +
      (m ? '' : '<details class="set"><summary>여러 문항 한꺼번에 붙여넣기</summary>' +
        '<p class="note">문항 사이는 <code>---</code> 한 줄로 나눕니다. 위에서 고른 유형·회차로 모두 들어갑니다.</p>' +
        '<textarea id="me-bulk" rows="8" placeholder="과목: 산업안전관리론\n문제: 하인리히 재해 구성 비율을 쓰시오.\n정답: 중상 : 경상 : 무상해사고 = {{1:29:300}}\n---\n과목: 전기위험방지기술\n문제: 감전 방지용 누전차단기의 정격감도전류와 동작시간을 쓰시오.\n정답: {{30}}mA 이하, {{0.03}}초 이내"></textarea>' +
        '<div class="row"><button class="dark" id="me-import">가져오기</button><span class="status" id="me-bst"></span></div></details>') +
      '</section>';
    var $ = function (id) { return document.getElementById(id); };
    function fillRounds(sel) {
      var t = $('me-t').value, rs = mockRounds(t), nx = nextRound(t);
      $('me-n').innerHTML = rs.map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + k + '회 (' + mockList(t, k).length + '문항)</option>'; }).join('') +
        '<option value="' + nx + '"' + (sel === nx ? ' selected' : '') + '>＋ 새 회차 ' + nx + '회</option>';
    }
    $('me-t').value = type;
    fillRounds(m ? m.round : (ui.lastRound && ui.lastRound[type]) || ui.n);
    if (m) { $('me-s').value = m.subject; $('me-q').value = m.q; $('me-a').value = m.a; $('me-u').checked = !!m.unordered; }
    else if (ui.lastSubj) $('me-s').value = ui.lastSubj;
    var prevBlanks = [];
    function preview() {
      var a = $('me-a').value, cnt = (a.match(/\{\{[^}]+\}\}/g) || []).length, pv = $('me-prev');
      $('me-cnt').textContent = '빈칸 ' + cnt + '개';
      $('me-cnt').className = 'meta' + (cnt ? '' : ' warn');
      pv.innerHTML = ''; prevBlanks = [];
      if (!a.trim()) { pv.innerHTML = '<span class="note">정답을 입력하면 여기에 빈칸 퀴즈 모양으로 보입니다.</span>'; return; }
      var ab = buildAnswer({ a: a }); prevBlanks = ab.blanks; pv.appendChild(ab.box);
      $('me-st').textContent = '';
    }
    function wrap(fn) {
      var ta = $('me-a'), s0 = ta.selectionStart, s1 = ta.selectionEnd, v = ta.value;
      if (s0 === s1) { toast('정답 칸에서 빈칸으로 만들 글자를 먼저 드래그해 선택하세요.'); ta.focus(); return; }
      var mid = fn(v.slice(s0, s1)); if (mid == null) return;
      ta.value = v.slice(0, s0) + mid + v.slice(s1); ta.focus(); ta.setSelectionRange(s0, s0 + mid.length); preview();
    }
    $('me-blank').addEventListener('click', function () {
      wrap(function (t) {
        var lead = t.match(/^\s*/)[0], tail = t.match(/\s*$/)[0], core = t.trim();
        if (!core) return null;
        if (/\{\{|\}\}/.test(core)) { toast('이미 빈칸이 들어 있는 부분입니다.'); return null; }
        return lead + '{{' + core + '}}' + tail;
      });
    });
    $('me-alt').addEventListener('click', function () {
      var ta = $('me-a'), pos = ta.selectionStart, v = ta.value, open = v.lastIndexOf('{{', pos - 1), close = v.indexOf('}}', open);
      if (open < 0 || close < 0 || pos < open || pos > close + 2) { toast('인정 답안을 넣을 빈칸 {{ }} 안에 커서를 두세요.'); return; }
      var alt = prompt('같이 정답으로 인정할 다른 표현을 입력하세요.'); if (!alt || !alt.trim()) return;
      ta.value = v.slice(0, close) + '|' + alt.trim().replace(/[{}|]/g, '') + v.slice(close); preview();
    });
    $('me-unblank').addEventListener('click', function () {
      wrap(function (t) { return t.replace(/\{\{([^}]+)\}\}/g, function (x, g) { return g.split('|')[0].trim(); }).replace(/\{\{|\}\}/g, ''); });
    });
    $('me-a').addEventListener('input', preview);
    $('me-t').addEventListener('change', function () { fillRounds(ui.n); });
    $('me-try').addEventListener('click', function () {
      if (!prevBlanks.length) { $('me-st').textContent = '빈칸이 없습니다.'; return; }
      var okc = gradeBlanks({ unordered: $('me-u').checked }, prevBlanks);
      prevBlanks.forEach(function (b) { b.inp.classList.toggle('ok', b.ok); b.inp.classList.toggle('ng', !b.ok); });
      $('me-st').textContent = okc + ' / ' + prevBlanks.length + ' 빈칸 정답';
    });
    function collect() {
      var t = $('me-t').value, rnd = parseInt($('me-n').value, 10), q = $('me-q').value.trim(), a = $('me-a').value.replace(/\s+$/, '');
      if (!q || !a.trim()) { toast('문제와 정답을 모두 입력하세요.'); return null; }
      if ((a.match(/\{\{/g) || []).length !== (a.match(/\}\}/g) || []).length) { toast('빈칸 괄호 {{ }} 짝이 맞지 않습니다.'); return null; }
      if (!/\{\{[^}]+\}\}/.test(a) && !confirm('정답에 빈칸 {{ }}이 없습니다. 퀴즈 채점 없이 “정답 보기”형으로 저장할까요?')) return null;
      return { id: m ? m.id : 'UM' + (t === 'practical' ? 'P' : 'W') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        type: t, round: rnd, subject: $('me-s').value.trim() || '사용자추가', q: q, a: a, unordered: $('me-u').checked,
        createdAt: m ? m.createdAt : Date.now(), updatedAt: Date.now() };
    }
    function doSave(keep) {
      var rec = collect(); if (!rec) return;
      var err = addMockQ(rec); if (err) { toast(err); return; }
      save('mq'); rebuildUserMocks();
      ui.type = rec.type; ui.n = rec.round; ui.lastSubj = rec.subject;
      ui.lastRound = ui.lastRound || {}; ui.lastRound[rec.type] = rec.round;
      ui.editOpen = keep ? true : false;
      if (!m) logEv({ k: 'add', t: rec.type, n: rec.round, id: rec.id });
      drawNav('mock'); viewMock();
      toast(TYPES[rec.type] + ' 모의고사 ' + rec.round + '회에 ' + (m ? '수정 저장' : '추가') + '했습니다' + (Cloud.state === 'on' ? ' (DB 저장)' : '') + '.');
      if (keep) { var q2 = document.getElementById('me-q'); if (q2) q2.focus(); }
    }
    $('me-save').addEventListener('click', function () { doSave(false); });
    if ($('me-more')) $('me-more').addEventListener('click', function () { doSave(true); });
    $('me-close').addEventListener('click', function () { ui.editOpen = false; box.innerHTML = ''; });
    if ($('me-import')) $('me-import').addEventListener('click', function () {
      var recs = parseBulk($('me-bulk').value), t = $('me-t').value, rnd = parseInt($('me-n').value, 10), ok = 0, skip = 0;
      if (!recs.length) { $('me-bst').textContent = '형식을 확인하세요. 문제: / 정답: 줄이 필요합니다.'; return; }
      recs.forEach(function (r, k) {
        var rec = { id: 'UM' + (t === 'practical' ? 'P' : 'W') + Date.now().toString(36) + k + Math.random().toString(36).slice(2, 4),
          type: t, round: rnd, subject: r.s || $('me-s').value.trim() || '사용자추가', q: r.q, a: r.a, unordered: r.u, createdAt: Date.now(), updatedAt: Date.now() };
        if (addMockQ(rec)) skip++; else ok++;
      });
      if (ok) { save('mq'); rebuildUserMocks(); logEv({ k: 'add', t: t, n: rnd, cnt: ok }); }
      ui.type = t; ui.n = rnd; ui.editOpen = true; drawNav('mock'); viewMock();
      toast(ok + '문항을 ' + TYPES[t] + ' 모의고사 ' + rnd + '회에 가져왔습니다' + (skip ? ' (중복 ' + skip + '개 건너뜀)' : '') + '.');
    });
    preview();
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
      '<p class="note">claude.ai에 게시된 링크로 열면 API 키 없이 send가 동작합니다(처음 한 번 사용 허용). 파일로 열었을 때만 API 키가 필요하며, 키는 이 브라우저에만 보관되고 DB에는 올리지 않습니다.</p>' +
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
      if (Cloud.sample) { // claude.ai에서 열었을 때: API 키 없이 Claude에게 직접 요청(sample)
        var sbtn = document.getElementById('gs'); sbtn.disabled = true;
        setStatus('<span class="spin"></span>Claude가 정답을 작성 중입니다…');
        Cloud.sample(SYS[genState.type] + '\n\n[문제]\n' + q, { modelTier: 'default', cache: false, onText: function (o) { var ga = document.getElementById('ga'); if (ga) ga.value = o.text; } })
          .then(function (r) {
            var text = String(r.text || '').trim(); if (!text) throw { message: '빈 응답이 반환되었습니다.' };
            genState.a = text; var ga = document.getElementById('ga'); if (ga) ga.value = text; setStatus('정답이 생성되었습니다. 필요하면 수정한 뒤 추가하세요.');
          })
          .catch(function (e) {
            setStatus(e && e.code === 'not_granted' ? 'Claude 사용을 허용하지 않았습니다. 정답을 직접 입력해 추가할 수 있습니다.' : e && e.code === 'rate_limited' ? '요청이 많습니다. 잠시 뒤 다시 시도하세요.' : '오류: ' + esc((e && e.message) || '요청 실패'), true);
          })
          .then(function () { sbtn.disabled = false; });
        return;
      }
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
      var bk = JSON.parse(JSON.stringify(store)); bk.settings.apiKey = ''; bk.log = localLog();
      saveFile('safety-exam-backup-' + dateKey() + '.json', JSON.stringify(bk, null, 2), 'application/json');
    });
    document.getElementById('gimp').addEventListener('click', function () { document.getElementById('gfile').click(); });
    document.getElementById('gfile').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var d = JSON.parse(rd.result);
          store.added = { written: (d.added && d.added.written) || [], practical: (d.added && d.added.practical) || [] };
          store.wrong = d.wrong || {}; store.mockRes = d.mockRes || {};
          if (d.bookmarks) store.bookmarks = d.bookmarks;
          if (d.solved) store.solved = d.solved;
          if (Array.isArray(d.mockq)) { store.mockq = d.mockq; save('mq'); rebuildUserMocks(); }
          save(); drawNav('gen'); updateFAB(); toast('백업을 불러왔습니다.' + (Cloud.state === 'on' ? ' DB에도 저장합니다.' : ''));
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

  /* 오답노트에 들어갈 수 있는 문항: 기본 + 사용자추가 + 같은 유형의 모의고사 */
  function noteSource(type) { return getList(type).concat(type === 'written' ? mockAll() : mockPAll()); }
  function buildPool(mode) {
    var ui = quizUI[mode];
    if (mode === 'quiz') {
      ui.pool = shuffle(levelIds(ui.type, ui.levelByType[ui.type]));
      ui.i = 0;
      return;
    }
    var ids = noteSource(ui.type).filter(function (q) {
      return subjOk(q, ui.subj) && store.wrong[q.id];
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
      if (isNote) return noteSource(t).filter(function (q) { return store.wrong[q.id]; }).length;
      return getList(t).filter(hasBlanks).length;
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
        isNote ? TYPES[ui.type] + ' 퀴즈에서 틀린 문제와, ' + TYPES[ui.type] + ' 목록·모의고사·퀴즈에서 “＋ 오답노트”로 담은 문제를 모아 다시 풉니다. 이해했다면 “오답 해제”로 목록에서 뺄 수 있습니다.'
          : (ui.type === 'written' ? '필답형 예상문제를 레벨별로 20문항씩 풉니다. 메뉴를 열 때마다 순서를 섞고, 한 레벨을 모두 맞혀야 다음 레벨이 열립니다.' : '작업형 예상문제를 레벨별로 20문항씩 풉니다. 메뉴를 열 때마다 순서를 섞고, 한 레벨을 모두 맞혀야 다음 레벨이 열립니다.'),
        '<span class="tag" id="qtag"></span>') +
      '<div class="qwrap"><div class="seg seg-type" id="qtseg">' +
      ['written', 'practical'].map(function (t) {
        return '<button data-t="' + t + '" class="' + (t === ui.type ? 'on' : '') + '">' + TYPES[t] + (isNote ? ' 오답노트' : ' 퀴즈') + '<small style="margin-left:8px">' + qcount(t) + '</small></button>';
      }).join('') + '</div>' +
      (isNote ? '' : '<div class="seg seg-level" id="qlv">' + levelBtnsHTML(ui.type, curLv) + '</div>') +
      '<div class="bar">' +
      (isNote ? '<select id="qs"><option value="">전체(과목·모의고사)</option><option value="base"' + (ui.subj === 'base' ? ' selected' : '') + '>기본·사용자추가 문항만</option>' +
        '<optgroup label="과목">' + opts(subs, ui.subj) + '</optgroup>' +
        '<optgroup label="모의고사"><option value="mock:all"' + (ui.subj === 'mock:all' ? ' selected' : '') + '>모의고사 전체</option>' + mockOpts(ui.subj) + '</optgroup></select>' +
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
          ? '오답노트가 비어 있습니다.<br>퀴즈에서 틀린 문제는 자동으로, 필답형·작업형 목록과 모의고사에서는 “＋ 오답노트”(📝) 버튼으로 담을 수 있습니다.'
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
      var noBlank = !ab.blanks.length;
      if (noBlank) {
        card.querySelector('#abox').innerHTML = '<p class="note">빈칸이 없는 문항입니다. 답을 먼저 떠올리거나 써 본 뒤 “정답 보기”로 확인하세요.</p>';
        card.querySelector('#bg').style.display = 'none';
      } else card.querySelector('#abox').appendChild(ab.box);

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
        if (!counted) { ui.tried++; if (all) ui.correct++; counted = true; logEv({ k: mode, t: ui.type, id: q.id, ok: all, sc: [okc, ab.blanks.length] }); }
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
      else card.querySelector('#bs').focus({ preventScroll: true });
    }
  }


  /* ───────── 학습기록(DB) ───────── */
  var KLABEL = { quiz: '퀴즈', note: '오답노트', list: '목록 괄호', mockq: '모의 퀴즈', mark: '모의 자가채점', mock: '모의고사 점수', add: '문제 입력' };
  function drawCloudBox() {
    var el = document.getElementById('cbox'); if (!el) return;
    var on = Cloud.state === 'on';
    el.innerHTML = '<h2><span class="cdot ' + Cloud.state + (Cloud.warn ? ' warn' : '') + '"></span>저장소 연결 상태</h2>' +
      '<div class="wrap wrap-s"><table class="tbl kv"><tbody>' +
      '<tr><th>로그인 사용자</th><td>' + (Cloud.me ? esc(Cloud.me.name) + ' (<code>' + esc(Cloud.me.id) + '</code>) · ' + (isAdmin() ? '관리자' : '일반 사용자') + ' <button class="sm" id="cAcc">내 계정 · 비밀번호 변경</button>' : '로그인하지 않음') + '</td></tr>' +
      '<tr><th>현재 저장소</th><td>' + esc(CLOUD_TXT[Cloud.state]) + (on ? ' — claude.ai 온라인 DB(PC·휴대폰 어디서나 같은 진도)' : '') + '</td></tr>' +
      '<tr><th>저장 위치</th><td>' + (on ? '<code>progress/' + esc(Cloud.me.id) + '</code> 진행 상황 · <code>mockbank/' + esc(Cloud.me.id) + '</code> 내가 입력한 모의고사 · <code>progress/' + esc(Cloud.me.id) + '/logs/날짜_기기</code> 학습기록' : '이 브라우저 localStorage') + '</td></tr>' +
      '<tr><th>이 기기 ID</th><td><code>' + esc(DEV) + '</code> (기록이 기기별로 나뉘어 저장되어 휴대폰·PC를 함께 써도 겹치지 않습니다)</td></tr>' +
      '<tr><th>마지막 저장 / 불러오기</th><td>' + (Cloud.lastSave ? hm(Cloud.lastSave) : '—') + ' / ' + (Cloud.lastLoad ? hm(Cloud.lastLoad) : '—') + '</td></tr>' +
      (Cloud.warn || Cloud.msg ? '<tr><th>알림</th><td class="' + (Cloud.warn ? 'cwarn' : '') + '">' + esc(Cloud.warn || Cloud.msg) + '</td></tr>' : '') +
      '</tbody></table></div>' +
      '<div class="row">' + (on ? '<button class="pri sm" id="csave">☁ 지금 DB에 저장</button><button class="sm" id="cpull">DB 기록 다시 불러오기</button>' : '') +
      '<button class="sm" id="cexp">기록 CSV 내려받기</button></div>' +
      (on ? '' : '<p class="note">claude.ai에 게시된 이 사이트 링크로 열고 로그인하면 온라인 DB에 저장되어 휴대폰·PC 어디서 열어도 같은 진도가 이어집니다. 파일(index.html)로 열면 이 브라우저에만 저장됩니다.</p>');
    var ca = document.getElementById('cAcc'); if (ca) ca.addEventListener('click', openAccount);
    var cs = document.getElementById('csave');
    if (cs) cs.addEventListener('click', function () { cs.disabled = true; cloudSaveAll().then(function () { cs.disabled = false; toast(Cloud.warn ? Cloud.warn : 'DB에 저장했습니다.'); }); });
    var cp = document.getElementById('cpull');
    if (cp) cp.addEventListener('click', function () {
      if (!confirm('DB에 저장된 기록으로 이 기기의 진행 상황을 덮어쓸까요?\n(이 기기에서 아직 저장되지 않은 변경은 사라집니다)')) return;
      cloudPull(true).then(function () { rebuildUserMocks(); drawNav('stats'); updateFAB(); viewStats(); toast('DB 기록을 불러왔습니다.'); }, cloudErr);
    });
    document.getElementById('cexp').addEventListener('click', function () {
      loadEvents().then(function (r) {
        var rows = [['시각', '구분', '유형', '회차', '문항', '결과', '점수']];
        r.ev.sort(function (a, b) { return a.ts - b.ts; }).forEach(function (e) {
          var q = e.id ? findQ(e.id) : null;
          rows.push([new Date(e.ts).toLocaleString('ko-KR'), KLABEL[e.k] || e.k, TYPES[e.t] || '', e.n || '', q ? q.q.slice(0, 80) : (e.id || ''),
            e.k === 'mock' ? e.o + '/' + e.tot : e.k === 'mark' ? (e.r === 'o' ? '맞음' : e.r === 'x' ? '틀림' : '해제') : (e.ok === undefined ? '' : e.ok ? '정답' : '오답'),
            e.sc ? e.sc.join('/') : '']);
        });
        var csv = '\ufeff' + rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
        saveFile('safety-exam-log-' + dateKey() + '.csv', csv, 'text/csv');
      });
    });
  }
  function saveFile(name, text, mime) {
    if (Cloud.dl) { Cloud.dl.save({ filename: name, data: new Blob([text], { type: mime }) }).catch(function (e) { if (e && e.code !== 'cancelled' && e.code !== 'declined') toast('내려받기 실패: ' + (e.code || '')); }); return; }
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
  }
  function loadEvents() {
    var local = { src: 'local', ev: localLog() };
    if (Cloud.state !== 'on') return Promise.resolve(local);
    var mine = Cloud.today + '_' + DEV;
    return Cloud.logs.orderBy('date', 'desc').limit(400).get().then(function (qs) {
      var ev = [];
      qs.docs.forEach(function (d) { if (d.id === mine) return; var x = d.data(); (x.events || []).forEach(function (e) { ev.push(e); }); });
      ev = ev.concat(Cloud.todayEv, Cloud.logQ);
      return { src: 'db', ev: ev, docs: qs.size };
    }, function () { return local; });
  }
  function viewStats() {
    root.innerHTML = head('학습기록', '빈칸 채점·모의고사 채점·문제 입력이 기록됩니다. DB에 연결되면 기기와 상관없이 쌓입니다.', '<span class="tag">' + esc(cloudLabel()) + '</span>') +
      '<section class="card" id="cbox"></section>' +
      '<div class="kpis" id="kpis"></div>' +
      '<h2 class="sub">날짜별 요약</h2><div class="wrap wrap-s"><table class="tbl sum"><thead><tr><th>날짜</th><th>빈칸 채점</th><th>정답</th><th>정답률</th><th>모의 채점(맞음/전체)</th><th>점수 기록</th><th>문제 입력</th></tr></thead><tbody id="sday"><tr><td colspan="7" class="empty">불러오는 중…</td></tr></tbody></table></div>' +
      '<h2 class="sub">모의고사 점수 기록</h2><div class="wrap wrap-s"><table class="tbl sum"><thead><tr><th>일시</th><th>유형</th><th>회차</th><th>맞음</th><th>틀림</th><th>문항</th><th>정답률</th><th>소요</th></tr></thead><tbody id="smock"></tbody></table></div>' +
      '<h2 class="sub">최근 활동 50건</h2><div class="wrap wrap-s"><table class="tbl sum"><thead><tr><th>시각</th><th>구분</th><th>문항</th><th>결과</th></tr></thead><tbody id="srec"></tbody></table></div>';
    drawCloudBox();
    var base = { w: QDATA.written.length, p: QDATA.practical.length };
    var sw = QDATA.written.filter(function (q) { return store.solved[q.id]; }).length, sp = QDATA.practical.filter(function (q) { return store.solved[q.id]; }).length;
    function kpi(label, val, sub) { return '<div class="kpi"><small>' + label + '</small><b>' + val + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>'; }
    loadEvents().then(function (r) {
      var ev = r.ev.filter(function (e) { return e && e.ts; }).sort(function (a, b) { return b.ts - a.ts; });
      var graded = ev.filter(function (e) { return e.ok !== undefined; }), okN = graded.filter(function (e) { return e.ok; }).length;
      document.getElementById('kpis').innerHTML =
        kpi('퀴즈 정답(필답형)', sw + '/' + base.w, Math.round(sw / base.w * 100) + '%') +
        kpi('퀴즈 정답(작업형)', sp + '/' + base.p, Math.round(sp / base.p * 100) + '%') +
        kpi('누적 빈칸 채점', graded.length, graded.length ? '정답률 ' + Math.round(okN / graded.length * 100) + '%' : '') +
        kpi('오답노트', Object.keys(store.wrong).filter(function (id) { return findQ(id); }).length, '') +
        kpi('내 모의고사 문제', store.mockq.length, '') +
        kpi('기록 출처', r.src === 'db' ? '☁ DB' : '💾 로컬', r.src === 'db' ? (r.docs || 0) + '개 문서' : '최근 2000건');
      var days = {};
      ev.forEach(function (e) {
        var d = dateKey(e.ts), o = days[d] = days[d] || { g: 0, ok: 0, mo: 0, mt: 0, rec: 0, add: 0 };
        if (e.ok !== undefined && e.k !== 'mockq') { o.g++; if (e.ok) o.ok++; }
        if (e.k === 'mockq') { o.mt++; if (e.ok) o.mo++; }
        if (e.k === 'mark' && e.r) { o.mt++; if (e.r === 'o') o.mo++; }
        if (e.k === 'mock') o.rec++;
        if (e.k === 'add') o.add += e.cnt || 1;
      });
      var dk = Object.keys(days).sort().reverse();
      document.getElementById('sday').innerHTML = dk.length ? dk.slice(0, 60).map(function (d) {
        var o = days[d];
        return '<tr><td class="mono">' + d + '</td><td>' + o.g + '</td><td>' + o.ok + '</td><td>' + (o.g ? Math.round(o.ok / o.g * 100) + '%' : '—') + '</td><td>' + (o.mt ? o.mo + '/' + o.mt : '—') + '</td><td>' + (o.rec || '—') + '</td><td>' + (o.add || '—') + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="empty">아직 기록이 없습니다. 퀴즈나 모의고사를 채점하면 쌓입니다.</td></tr>';
      var ms = ev.filter(function (e) { return e.k === 'mock'; });
      document.getElementById('smock').innerHTML = ms.length ? ms.map(function (e) {
        return '<tr><td class="mono">' + new Date(e.ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</td><td>' + (TYPES[e.t] || '') + (e.quiz ? ' ✏' : '') + '</td><td>' + e.n + '회</td><td>' + e.o + '</td><td>' + e.x + '</td><td>' + e.tot + '</td><td><b>' + (e.tot ? Math.round(e.o / e.tot * 100) : 0) + '%</b></td><td class="mono">' + (e.ms ? fmtT(e.ms) : '—') + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="empty">모의고사 화면에서 채점 후 📊 점수 기록을 누르면 여기에 남습니다.</td></tr>';
      document.getElementById('srec').innerHTML = ev.length ? ev.slice(0, 50).map(function (e) {
        var q = e.id ? findQ(e.id) : null, res;
        if (e.k === 'mock') res = e.o + '/' + e.tot;
        else if (e.k === 'mark') res = e.r === 'o' ? '맞음' : e.r === 'x' ? '틀림' : '해제';
        else if (e.k === 'add') res = (e.cnt || 1) + '문항 입력';
        else res = (e.ok ? '<span class="okc">정답</span>' : '<span class="ngc">오답</span>') + (e.sc ? ' ' + e.sc.join('/') : '');
        var what = q ? '<span class="mono">' + qNo(q) + '</span> ' + esc(q.q.slice(0, 48)) + (q.q.length > 48 ? '…' : '') : (e.k === 'mock' || e.k === 'add' ? (TYPES[e.t] || '') + ' ' + (e.n ? e.n + '회' : '') : '<span class="note">(삭제된 문항)</span>');
        return '<tr><td class="mono">' + new Date(e.ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</td><td>' + (KLABEL[e.k] || e.k) + '</td><td>' + what + '</td><td>' + res + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="empty">기록이 없습니다.</td></tr>';
    });
  }

  /* ───────── 사용자 관리(관리자 전용) ─────────
     accounts·progress 컬렉션을 읽어 사용자별 진도표를 만든다. 계정 추가·비밀번호 초기화·사용 중지·권한 변경·삭제. */
  var adminUI = { sel: '' };
  function progSummary(p) {
    p = p || {};
    var solved = p.solved || {}, mr = p.mockRes || {}, daily = p.daily || {};
    var sw = QDATA.written.filter(function (q) { return solved[q.id]; }).length, sp = QDATA.practical.filter(function (q) { return solved[q.id]; }).length;
    function lv(type) { var L = baseLevels(type); for (var i = 0; i < L.length; i++) if (!L[i].every(function (id) { return solved[id]; })) return i + 1; return L.length; }
    var mo = 0, mx = 0; Object.keys(mr).forEach(function (k) { if (mr[k] === 'o') mo++; else if (mr[k] === 'x') mx++; });
    var g7 = 0, ok7 = 0, m7 = 0, act = 0, today = Date.now();
    for (var d = 0; d < 7; d++) { var D = daily[dateKey(today - d * 864e5)]; if (D) { g7 += D.g || 0; ok7 += D.ok || 0; m7 += D.m || 0; if (D.g || D.m) act++; } }
    var hist = p.mockHist || [], last = hist[hist.length - 1];
    return { sw: sw, sp: sp, lvW: lv('written'), lvP: lv('practical'), wrong: Object.keys(p.wrong || {}).length, mo: mo, mx: mx, g7: g7, ok7: ok7, m7: m7, act7: act,
      last: last, upd: p.updatedAt || 0, hist: hist, daily: daily, bm: Object.keys(p.bookmarks || {}).length };
  }
  function ago(ts) {
    if (!ts) return '—';
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return '방금'; if (m < 60) return m + '분 전'; if (m < 1440) return Math.floor(m / 60) + '시간 전';
    if (m < 43200) return Math.floor(m / 1440) + '일 전'; return new Date(ts).toLocaleDateString('ko-KR');
  }
  function bar(v, t) { var p = t ? Math.round(v / t * 100) : 0; return '<div class="pbar"><i style="width:' + p + '%"></i></div><span class="mono">' + v + '/' + t + ' (' + p + '%)</span>'; }
  function viewAdmin() {
    if (!isAdmin()) { root.innerHTML = head('사용자 관리', '관리자(슈퍼유저)만 볼 수 있는 메뉴입니다.'); return; }
    root.innerHTML = head('사용자 관리', '계정을 만들고 사용자별 진도·정답률·모의고사 점수를 확인합니다. 모든 데이터는 온라인 DB에 있어 PC·휴대폰 어디서 봐도 같습니다.', '<span class="tag">관리자 · ' + esc(Cloud.me.id) + '</span>') +
      '<div class="kpis" id="akpi"></div>' +
      '<section class="card"><h2><span class="n">＋</span>사용자 추가</h2><div class="mgrid agrid">' +
      '<div class="field"><label for="nuId">아이디 (영문 소문자·숫자 3~20자)</label><input type="text" id="nuId" autocapitalize="none" spellcheck="false" placeholder="예) seokun"></div>' +
      '<div class="field"><label for="nuName">이름</label><input type="text" id="nuName" placeholder="예) 임석운"></div>' +
      '<div class="field"><label for="nuPw">임시 비밀번호</label><input type="text" id="nuPw" value="1234"></div>' +
      '<div class="field"><label for="nuRole">권한</label><select id="nuRole"><option value="user">일반 사용자</option><option value="admin">관리자</option></select></div>' +
      '</div><div class="row"><button class="pri" id="nuAdd">사용자 만들기</button><span class="status" id="nuSt"></span><span class="note">첫 로그인 때 사용자가 직접 비밀번호를 바꾸게 됩니다.</span></div></section>' +
      '<h2 class="sub">사용자별 진도 <button class="sm" id="aRef" style="margin-left:auto">↻ 새로고침</button></h2>' +
      '<div class="wrap wrap-s"><table class="tbl sum utbl"><thead><tr><th>사용자</th><th>권한·상태</th><th>마지막 접속·학습</th><th>퀴즈 필답형</th><th>퀴즈 작업형</th><th>오답노트</th><th>모의고사 채점</th><th>최근 7일</th><th>최근 모의 점수</th><th>관리</th></tr></thead><tbody id="ubody"><tr><td colspan="10" class="empty">불러오는 중…</td></tr></tbody></table></div>' +
      '<div id="udetail"></div>';
    var data = { acc: [], prog: {} };
    function load() {
      return Promise.all([Cloud.db.collection('accounts').get(), Cloud.db.collection('progress').get()]).then(function (r) {
        data.acc = r[0].docs.map(function (d) { return d.data(); }).sort(function (a, b) { return (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1) || a.id.localeCompare(b.id); });
        data.prog = {}; r[1].docs.forEach(function (d) { data.prog[d.id] = d.data(); });
        draw();
      }).catch(function (e) { document.getElementById('ubody').innerHTML = '<tr><td colspan="10" class="empty">불러오기 실패: ' + esc((e && e.code) || '오류') + '</td></tr>'; });
    }
    function draw() {
      var users = data.acc, today = 0, tg = 0, tok = 0;
      var rows = users.map(function (a) {
        var s = progSummary(data.prog[a.id]);
        var D = s.daily[dateKey()]; if (D && (D.g || D.m)) today++;
        tg += s.g7; tok += s.ok7;
        return '<tr data-u="' + esc(a.id) + '" class="' + (adminUI.sel === a.id ? 'usel' : '') + (a.disabled ? ' udis' : '') + '">' +
          '<td><b>' + esc(a.name || a.id) + '</b><br><span class="mono">' + esc(a.id) + '</span>' + (a.id === Cloud.me.id ? ' <span class="mine-tag" style="display:inline-block">나</span>' : '') + '</td>' +
          '<td>' + (a.role === 'admin' ? '<span class="rtag adm">관리자</span>' : '<span class="rtag">사용자</span>') + '<br>' + (a.disabled ? '<span class="ngc">사용 중지</span>' : a.mustChange ? '<span class="note">비번 변경 대기</span>' : '<span class="okc">사용 중</span>') + '</td>' +
          '<td class="mono">' + ago(a.lastLogin) + '<br>' + ago(s.upd) + '</td>' +
          '<td>' + bar(s.sw, QDATA.written.length) + '<br><small>현재 ' + s.lvW + '레벨</small></td>' +
          '<td>' + bar(s.sp, QDATA.practical.length) + '<br><small>현재 ' + s.lvP + '레벨</small></td>' +
          '<td class="mono">' + s.wrong + '</td>' +
          '<td class="mono">' + s.mo + ' / ' + (s.mo + s.mx) + (s.mo + s.mx ? '<br><small>' + Math.round(s.mo / (s.mo + s.mx) * 100) + '%</small>' : '') + '</td>' +
          '<td class="mono">' + s.g7 + '회 · ' + (s.g7 ? Math.round(s.ok7 / s.g7 * 100) + '%' : '—') + '<br><small>' + s.act7 + '일 학습</small></td>' +
          '<td class="mono">' + (s.last ? TYPES[s.last.t] + ' ' + s.last.n + '회<br><b class="' + (s.last.o / s.last.tot >= 0.6 ? 'okc' : 'ngc') + '">' + s.last.o + '/' + s.last.tot + '</b>' : '—') + '</td>' +
          '<td><div class="abtns"><button class="sm pri" data-act="detail">상세</button><button class="sm" data-act="reset">비번 초기화</button>' +
          (a.id !== Cloud.me.id ? '<button class="sm" data-act="role">' + (a.role === 'admin' ? '사용자로' : '관리자로') + '</button><button class="sm" data-act="dis">' + (a.disabled ? '사용 재개' : '사용 중지') + '</button><button class="sm danger" data-act="del">삭제</button>' : '') + '</div></td></tr>';
      }).join('');
      document.getElementById('ubody').innerHTML = rows || '<tr><td colspan="10" class="empty">계정이 없습니다.</td></tr>';
      function kpi(l, v, sub) { return '<div class="kpi"><small>' + l + '</small><b>' + v + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>'; }
      document.getElementById('akpi').innerHTML = kpi('전체 사용자', users.length, users.filter(function (a) { return a.role === 'admin'; }).length + '명 관리자') +
        kpi('오늘 학습한 사용자', today, '') + kpi('최근 7일 빈칸 채점', tg, tg ? '정답률 ' + Math.round(tok / tg * 100) + '%' : '') +
        kpi('사용 중지', users.filter(function (a) { return a.disabled; }).length, '');
      if (adminUI.sel) detail(adminUI.sel);
    }
    function detail(id) {
      adminUI.sel = id;
      var a = data.acc.filter(function (x) { return x.id === id; })[0], box = document.getElementById('udetail');
      if (!a) { box.innerHTML = ''; return; }
      var s = progSummary(data.prog[id]), days = [];
      for (var d = 13; d >= 0; d--) { var k = dateKey(Date.now() - d * 864e5), D = s.daily[k] || {}; days.push({ k: k, g: (D.g || 0) + (D.m || 0), ok: (D.ok || 0) + (D.mo || 0) }); }
      var mx = Math.max.apply(null, days.map(function (x) { return x.g; }).concat([1]));
      var prog = data.prog[id] || {}, solved = prog.solved || {}, mr = prog.mockRes || {};
      function lvTable(type) {
        return baseLevels(type).map(function (L, i) { var c = L.filter(function (x) { return solved[x]; }).length; return '<span class="lvc' + (c === L.length ? ' done' : '') + '">' + (i + 1) + '레벨 ' + c + '/' + L.length + '</span>'; }).join('');
      }
      function mockRow(type) {
        return mockRounds(type).map(function (n) { var l = mockList(type, n), o = 0, x = 0; l.forEach(function (q) { if (mr[q.id] === 'o') o++; else if (mr[q.id] === 'x') x++; }); return '<td class="mono">' + o + '/' + l.length + (o + x ? '<br><small>틀림 ' + x + '</small>' : '') + '</td>'; }).join('');
      }
      var rw = mockRounds('written'), rp = mockRounds('practical');
      box.innerHTML = '<section class="card udet"><h2><span class="n">👤</span>' + esc(a.name || a.id) + ' (' + esc(a.id) + ') 상세 진도 <button class="sm" data-close-d style="margin-left:auto">닫기</button></h2>' +
        '<div class="note">계정 생성 ' + (a.createdAt ? new Date(a.createdAt).toLocaleDateString('ko-KR') : '—') + ' · 마지막 로그인 ' + ago(a.lastLogin) + ' · 북마크 ' + s.bm + '개</div>' +
        '<h3>최근 14일 채점 수 (초록 = 정답)</h3><div class="dchart">' + days.map(function (x) {
          return '<div class="dcol" title="' + x.k + ' : ' + x.ok + '/' + x.g + '"><div class="dbar" style="height:' + Math.round(x.g / mx * 100) + '%"><i style="height:' + (x.g ? Math.round(x.ok / x.g * 100) : 0) + '%"></i></div><small>' + x.k.slice(8) + '</small><b>' + (x.g || '') + '</b></div>';
        }).join('') + '</div>' +
        '<h3>퀴즈 레벨 진행</h3><div class="lvrow"><b>필답형</b> ' + lvTable('written') + '</div><div class="lvrow"><b>작업형</b> ' + lvTable('practical') + '</div>' +
        '<h3>모의고사 회차별 맞음</h3><div class="wrap wrap-s"><table class="tbl sum"><thead><tr><th>유형</th>' + rw.map(function (n) { return '<th>' + n + '회</th>'; }).join('') + '</tr></thead><tbody>' +
        '<tr><td>필답형</td>' + mockRow('written') + '</tr><tr><td>작업형</td>' + mockRow('practical') + (rp.length < rw.length ? '<td colspan="' + (rw.length - rp.length) + '"></td>' : '') + '</tr></tbody></table></div>' +
        '<h3>모의고사 점수 이력</h3><div class="wrap wrap-s"><table class="tbl sum"><thead><tr><th>일시</th><th>유형·회차</th><th>점수</th><th>정답률</th><th>소요</th></tr></thead><tbody>' +
        (s.hist.length ? s.hist.slice().reverse().slice(0, 20).map(function (h) {
          return '<tr><td class="mono">' + new Date(h.ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</td><td>' + TYPES[h.t] + ' ' + h.n + '회' + (h.retry ? ' (오답 재풀이)' : '') + '</td><td class="mono">' + h.o + '/' + h.tot + '</td><td><b class="' + (h.o / h.tot >= 0.6 ? 'okc' : 'ngc') + '">' + Math.round(h.o / h.tot * 100) + '%</b></td><td class="mono">' + (h.ms ? fmtT(h.ms) : '—') + '</td></tr>';
        }).join('') : '<tr><td colspan="5" class="empty">모의고사 점수 기록이 없습니다.</td></tr>') + '</tbody></table></div></section>';
      box.querySelector('[data-close-d]').addEventListener('click', function () { adminUI.sel = ''; box.innerHTML = ''; draw(); });
      Array.prototype.forEach.call(document.querySelectorAll('#ubody tr'), function (tr) { tr.classList.toggle('usel', tr.getAttribute('data-u') === id); });
    }
    function act(id, what) {
      var a = data.acc.filter(function (x) { return x.id === id; })[0]; if (!a) return;
      var ref = accRef(id), p;
      if (what === 'detail') { detail(id); document.getElementById('udetail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (what === 'reset') {
        var np = prompt(a.id + ' 계정의 임시 비밀번호를 입력하세요. (다음 로그인 때 변경하게 됩니다)', '1234'); if (np == null) return;
        if (np.length < 4) { toast('비밀번호는 4자 이상이어야 합니다.'); return; }
        p = pwFields(np).then(function (pf) { return ref.update({ salt: pf.salt, hash: pf.hash, mustChange: true, sv: (a.sv || 1) + 1 }); });
        if (id === Cloud.me.id) p = p.then(function () { Cloud.me.sv = (a.sv || 1) + 1; writeSession({ id: id, sv: Cloud.me.sv, last: id }); setTimeout(function () { openPwModal(true); }, 200); });
        p = p.then(function () { toast(a.id + ' 비밀번호를 초기화했습니다. 로그인 중인 기기는 로그아웃됩니다.'); });
      } else if (what === 'role') {
        var toAdm = a.role !== 'admin';
        if (!toAdm && data.acc.filter(function (x) { return x.role === 'admin' && !x.disabled; }).length <= 1) { toast('관리자는 최소 1명이 있어야 합니다.'); return; }
        if (!confirm(a.id + '을(를) ' + (toAdm ? '관리자로 지정' : '일반 사용자로 변경') + '할까요?')) return;
        p = ref.update({ role: toAdm ? 'admin' : 'user' });
      } else if (what === 'dis') {
        if (!confirm(a.id + ' 계정을 ' + (a.disabled ? '다시 사용하게' : '사용 중지') + '할까요?')) return;
        p = ref.update({ disabled: !a.disabled, sv: (a.sv || 1) + 1 });
      } else if (what === 'del') {
        if (!confirm(a.id + ' 계정을 삭제할까요?\n진도·오답·학습기록·입력한 모의고사 문제도 모두 삭제되며 되돌릴 수 없습니다.')) return;
        if (prompt('확인을 위해 아이디(' + a.id + ')를 입력하세요.') !== a.id) { toast('아이디가 일치하지 않아 취소했습니다.'); return; }
        var pr = Cloud.db.doc('progress/' + id);
        p = pr.collection('logs').limit(1000).get().then(function (qs) {
          return qs.docs.reduce(function (c, d) { return c.then(function () { return pr.collection('logs').doc(d.id).delete(); }); }, Promise.resolve());
        }).then(function () { return pr.delete(); }).then(function () { return Cloud.db.doc('mockbank/' + id).delete(); }).then(function () { return ref.delete(); })
          .then(function () { if (adminUI.sel === id) adminUI.sel = ''; toast(a.id + ' 계정을 삭제했습니다.'); });
      }
      if (p) p.then(load, function (e) { toast('실패: ' + ((e && e.code) || '오류')); cloudErr(e); });
    }
    document.getElementById('ubody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      act(b.closest('tr').getAttribute('data-u'), b.getAttribute('data-act'));
    });
    document.getElementById('aRef').addEventListener('click', function () { load().then(function () { toast('최신 진도로 새로고침했습니다.'); }); });
    document.getElementById('nuAdd').addEventListener('click', function () {
      var id = document.getElementById('nuId').value.trim().toLowerCase(), nm = document.getElementById('nuName').value.trim(),
        pw = document.getElementById('nuPw').value, role = document.getElementById('nuRole').value, st = document.getElementById('nuSt');
      st.className = 'status err';
      if (!ID_RE.test(id)) { st.textContent = '아이디는 영문 소문자·숫자·_ . - 3~20자로 입력하세요.'; return; }
      if (pw.length < 4) { st.textContent = '임시 비밀번호는 4자 이상이어야 합니다.'; return; }
      var btn = document.getElementById('nuAdd'); btn.disabled = true; st.className = 'status'; st.innerHTML = '<span class="spin"></span>만드는 중…';
      accRef(id).get().then(function (s) {
        if (s.exists) { st.className = 'status err'; st.textContent = '이미 있는 아이디입니다.'; return; }
        return pwFields(pw).then(function (pf) {
          return accRef(id).set({ id: id, name: nm || id, role: role, salt: pf.salt, hash: pf.hash, mustChange: true, disabled: false, sv: 1, createdAt: Date.now(), createdBy: Cloud.me.id });
        }).then(function () {
          st.className = 'status'; st.textContent = id + ' 계정을 만들었습니다. 임시 비밀번호: ' + pw;
          document.getElementById('nuId').value = ''; document.getElementById('nuName').value = '';
          return load();
        });
      }).catch(function (e) { st.className = 'status err'; st.textContent = '실패: ' + ((e && e.code) || '오류'); cloudErr(e); })
        .then(function () { btn.disabled = false; });
    });
    load();
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
        '<div class="rowbtns"><button class="sm" data-float="' + q.id + '">📌 고정 보기</button>' + spkBtnsHTML(q.id) + wrBtnHTML(q.id) + '<button class="sm danger" data-bm="' + q.id + '">해제</button></div></td></tr>';
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

  document.addEventListener('click', function (e) {
    var w = e.target.closest('[data-wr]');
    if (!w) return;
    var id = w.getAttribute('data-wr'), q = findQ(id);
    if (!q) return;
    var on = toggleWrong(id);
    document.querySelectorAll('[data-wr="' + id + '"]').forEach(function (b) {
      b.outerHTML = wrBtnHTML(id, b.hasAttribute('data-short'));
    });
    drawNav((location.hash || '#written').slice(1));
    toast(on ? TYPES[q.type] + ' 오답노트에 담았습니다.' : '오답노트에서 뺐습니다.');
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
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !window.claude) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  document.getElementById('userChip').addEventListener('click', openAccount);
  updateFAB();
  route();
  cloudInit();
})();
