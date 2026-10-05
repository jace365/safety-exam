/*
 * 문제 데이터 공통 헬퍼
 * addQ(type, rows)  type: 'written'(필답형) | 'practical'(작업형)
 * row = [과목/분야, 문제, 정답, 옵션?]
 *  - 정답의 {{핵심어}}       : 퀴즈에서 빈칸으로 바뀌는 부분
 *  - {{정답|다른표현}}        : 인정되는 답이 여러 개일 때
 *  - 옵션 'u'                : 빈칸 순서와 무관하게 채점(나열형 정답)
 */
(function () {
  window.QDATA = { written: [], practical: [], mock: { 1: [], 2: [], 3: [], 4: [], 5: [] }, mockP: { 1: [], 2: [], 3: [], 4: [], 5: [] } };

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* 모의고사 n회 : addM(n, rows) — 필답형 형식(row 형식은 addQ와 동일) */
  window.addM = function (n, rows) {
    rows.forEach(function (r) {
      var q = r[1].trim();
      QDATA.mock[n].push({
        id: 'M' + n + '-' + hash(q), type: 'written', mock: n,
        subject: r[0], q: q, a: r[2].trim(), unordered: r[3] === 'u'
      });
    });
  };

  /* 작업형 모의고사 n회 : addMP(n, rows) — row 형식은 addQ와 동일 */
  window.addMP = function (n, rows) {
    rows.forEach(function (r) {
      var q = r[1].trim();
      QDATA.mockP[n].push({
        id: 'MP' + n + '-' + hash(q), type: 'practical', mock: n,
        subject: r[0], q: q, a: r[2].trim(), unordered: r[3] === 'u'
      });
    });
  };

  window.addQ = function (type, rows) {
    rows.forEach(function (r) {
      var q = r[1].trim();
      QDATA[type].push({
        id: (type === 'written' ? 'W' : 'P') + hash(q),
        type: type,
        subject: r[0],
        q: q,
        a: r[2].trim(),
        unordered: r[3] === 'u'
      });
    });
  };
})();
