/*
 * 필답형 모의고사 재편성 (2026.10.14)
 * mock-01~05.js의 기본 100문항을 실제 시험처럼 과목을 고루 섞어 회당 9문항으로 다시 나눈다.
 * - 문항 ID(M회차-해시)는 원래 값을 그대로 둔다 → 채점 기록·오답노트·책갈피·기본 해설 연결 유지
 * - q.mock(표시 회차)만 새 회차로 바꾼다
 * - 필답형 목록에 똑같은 문제가 있는 1문항(매슬로 욕구 5단계)은 빼서 99문항 = 9문항 × 11회
 * 작업형 모의고사(QDATA.mockP)는 건드리지 않는다(회당 10문항 유지).
 */
(function () {
  var SIZE = 9;
  var EXCLUDE = { 'M2-1yd658n': 1 };
  var ORDER = ['산업안전관리론', '안전보건교육', '인간공학·시스템안전', '기계위험방지기술', '전기위험방지기술', '화학설비위험방지기술', '건설안전기술'];
  var all = [];
  Object.keys(QDATA.mock).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) {
    all = all.concat(QDATA.mock[n].filter(function (q) { return !EXCLUDE[q.id]; }));
  });
  /* 과목별로 순서를 매긴 뒤 (과목 안 순번 + 0.5) / 과목 문항 수 로 정렬하면 과목이 처음부터 끝까지 고르게 퍼진다 */
  var bySubj = {};
  all.forEach(function (q) { (bySubj[q.subject] = bySubj[q.subject] || []).push(q); });
  var rank = [];
  Object.keys(bySubj).forEach(function (s) {
    var arr = bySubj[s];
    arr.forEach(function (q, i) { rank.push({ q: q, r: (i + 0.5) / arr.length, s: ORDER.indexOf(s) < 0 ? 99 : ORDER.indexOf(s) }); });
  });
  rank.sort(function (a, b) { return a.r - b.r || a.s - b.s; });
  var rounds = {};
  for (var k = 0; k * SIZE < rank.length; k++) {
    /* 한 회차 안에서는 실제 시험처럼 과목 순서(관리론 → … → 건설)로 */
    var chunk = rank.slice(k * SIZE, (k + 1) * SIZE).sort(function (a, b) { return a.s - b.s; });
    rounds[k + 1] = chunk.map(function (x) { x.q.mock = k + 1; return x.q; });
  }
  QDATA.mock = rounds;
  QDATA.mockBase = { mock: Object.keys(rounds).length, mockP: Object.keys(QDATA.mockP).length || 5 };
  QDATA.mockSize = SIZE;
})();
