/*
 * checker.js — 대진표 자기 점검 ⓐ–ⓕ(늦게 온 사람이 있으면 ⓖ–ⓙ도)만 담는다 (CLAUDE.md 6.3, 10절 1번).
 * scheduler.js의 함수·상수를 쓰지 않는다. 급수 점수표도 여기서 따로 갖는다.
 * 입력은 Excel `대진표` 시트에 쓰는 것과 같은 표(이름·텍스트 시각)이고,
 * 성별·급수는 대진표의 표기가 아니라 명단에서 다시 읽어 대조한다 (verify_schedule.py와 같은 방식).
 */
(function (global) {
  "use strict";

  var GRADE_SCORE = { A: 4, B: 3, C: 2, D: 1, "초심": 0 };
  var MAX_GRADE_DIFF = 1;
  var SHOW = 5;   // 상세에 보여 줄 위반 사례 수

  function minutes(s) {
    var p = String(s).split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function kind(genders) {
    var g = genders.slice().sort().join("");
    return { "남남": "남복", "여여": "여복", "남여": "혼복" }[g] || null;
  }

  function teamKey(team) { return team.slice().sort().join("·"); }

  // "HH:MM"(두 자리)만 분으로. 그 밖은 null
  function hm(s) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    return h <= 23 && mi <= 59 ? h * 60 + mi : null;
  }

  /*
   * 6.6 참가 시각 (개정 7). opts: {start, minutes, courts, games}. 늦게 온 사람 = 참가 시각 > 시작 시각.
   * 시간대 수 S와 첫 가능 시간대 f, 최소 L은 scheduler.js를 쓰지 않고 명세 6.2·6.5·6.6의 식으로 따로 계산한다.
   */
  function lateInfo(roster, opts) {
    var out = {};
    var start = opts ? hm(opts.start) : null;
    if (start === null) return out;
    var n = roster.length;
    var total = Math.floor(n * opts.games / 4);                 // (인원 × 경기 수 − 나머지) ÷ 4
    var S = Math.ceil(total / opts.courts);
    roster.forEach(function (p) {
      var a = hm(p.arrival);
      if (a === null || a <= start) return;
      var f = 0;
      while (f < S && start + f * opts.minutes < a) f++;
      out[p.name] = { arrival: String(p.arrival).trim(), min: a, f: f, L: S > 0 ? Math.floor(opts.games * (S - f) / S) : 0 };
    });
    return out;
  }

  /*
   * roster: [{name, gender, grade, arrival}]
   * rows:   [{no, time:"HH:MM", court, t1:[이름,이름], t2:[이름,이름], type, s1, s2}]
   * opts:   {start, minutes, courts, games} (없으면 늦게 온 사람 없음으로 봄)
   * 돌려주는 값: { items: [{code, item, rule, count, detail}] (ⓐ–ⓕ, 늦게 온 사람이 있으면 ⓖ–ⓙ도), extra: [...] (참고), total }
   * 늦게 온 사람이 없으면 항목·문구·상세가 1.1.0과 같다.
   */
  function check(roster, rows, opts) {
    var late = lateInfo(roster, opts);
    var hasLate = Object.keys(late).length > 0;
    var info = {};
    roster.forEach(function (p) { info[p.name] = { gender: p.gender, score: GRADE_SCORE[p.grade] }; });
    var items = [];

    var times = Array.from(new Set(rows.map(function (m) { return m.time; })))
      .sort(function (a, b) { return minutes(a) - minutes(b); });
    var slotOf = {};
    times.forEach(function (t, i) { slotOf[t] = i; });
    // W5: 늦게 온 사람이 있으면 경기가 없는 시간대가 생길 수 있다. 설정(시작·경기 시간)을 알면 시간대 번호를 시각으로 계산해
    // 빈 시간대를 건너뛴 두 경기를 연속으로 세지 않는다. 모든 시간대에 경기가 있으면 위의 번호와 같다
    var start0 = opts ? hm(opts.start) : null;
    if (start0 !== null && opts.minutes > 0) {
      times.forEach(function (t) { slotOf[t] = Math.round((((minutes(t) - start0) % 1440) + 1440) % 1440 / opts.minutes); });
    }
    var timeOfSlot = {};
    times.forEach(function (t) { timeOfSlot[slotOf[t]] = t; });
    function people(m) { return m.t1.concat(m.t2); }

    // ⓐ 한 시간대에 한 사람이 두 코트(또는 한 경기에 두 번) 배정
    var perSlot = {};
    rows.forEach(function (m) {
      var c = perSlot[m.time] || (perSlot[m.time] = {});
      people(m).forEach(function (p) { c[p] = (c[p] || 0) + 1; });
    });
    var a = [], aCount = 0;
    times.forEach(function (t) {
      Object.keys(perSlot[t]).forEach(function (p) {
        var c = perSlot[t][p];
        if (c > 1) { a.push(t + " " + p + " " + c + "회"); aCount += c - 1; }
      });
    });
    items.push({ code: "ⓐ", item: "한 시간대에 한 사람이 두 코트에 배정되지 않음", rule: "같은 시간대 등장 1회",
      count: aCount, detail: a.slice(0, SHOW).join(", ") });

    // ⓑ 연속 경기 (바로 다음 시간대에 다시 경기)
    var played = {};
    rows.forEach(function (m) {
      people(m).forEach(function (p) { (played[p] || (played[p] = new Set())).add(slotOf[m.time]); });
    });
    var b = [];
    Object.keys(played).forEach(function (p) {
      played[p].forEach(function (s) { if (played[p].has(s + 1)) b.push(p + "(" + timeOfSlot[s] + "→" + timeOfSlot[s + 1] + ")"); });
    });
    items.push({ code: "ⓑ", item: "같은 참가자의 연속 경기 없음", rule: "연속 시간대 출전 0회",
      count: b.length, detail: b.slice(0, SHOW).join(", ") });

    // ⓒ 같은 파트너 2회 이상
    var pc = {};
    rows.forEach(function (m) { [m.t1, m.t2].forEach(function (team) { var k = teamKey(team); pc[k] = (pc[k] || 0) + 1; }); });
    var c = [], cCount = 0;
    Object.keys(pc).forEach(function (k) { if (pc[k] >= 2) { c.push(k + " " + pc[k] + "회"); cCount += pc[k] - 1; } });
    items.push({ code: "ⓒ", item: "같은 파트너 2회 이상 없음", rule: "파트너 조합 1회",
      count: cCount, detail: c.slice(0, SHOW).join(", ") });

    // ⓓ 1인당 경기 수 차이 ≤ 1 (정시 참가자 기준, 0경기인 사람 포함. 개정 7 — 늦게 온 사람이 없으면 명단 전원)
    var games = {};
    roster.forEach(function (p) { games[p.name] = 0; });
    rows.forEach(function (m) { people(m).forEach(function (p) { if (p in games) games[p] += 1; }); });
    var counts = Object.keys(games).filter(function (p) { return !late[p]; }).map(function (p) { return games[p]; });
    var lo = counts.length ? Math.min.apply(null, counts) : 0;
    var hi = counts.length ? Math.max.apply(null, counts) : 0;
    var dist = {};
    counts.forEach(function (v) { dist[v] = (dist[v] || 0) + 1; });
    items.push({ code: "ⓓ", item: "1인당 경기 수 차이 1 이하" + (hasLate ? " (정시 참가자)" : ""), rule: "최대 − 최소 ≤ 1",
      count: hi - lo > 1 ? 1 : 0,
      detail: "최소 " + lo + "경기, 최대 " + hi + "경기 (" +
        Object.keys(dist).sort(function (x, y) { return x - y; }).map(function (k) { return k + "경기 " + dist[k] + "명"; }).join(", ") + ")" });

    // ⓔ 경기 종류 일치 (명단의 성별로 다시 판정)
    var e = [];
    rows.forEach(function (m) {
      function g(team) { return team.map(function (p) { return info[p] ? info[p].gender : "?"; }); }
      var k1 = kind(g(m.t1)), k2 = kind(g(m.t2));
      if (k1 === null || k1 !== k2 || k1 !== m.type) e.push("#" + m.no + "(팀1 " + k1 + ", 팀2 " + k2 + ", 표기 " + m.type + ")");
    });
    items.push({ code: "ⓔ", item: "경기 종류 일치", rule: "남복↔남복, 여복↔여복, 혼복↔혼복",
      count: e.length, detail: e.slice(0, SHOW).join(", ") });

    // ⓕ 두 팀 급수 합 차이 ≤ 1 (명단의 급수로 다시 계산)
    function sum(team) { return team.reduce(function (s, p) { return s + (info[p] ? info[p].score : NaN); }, 0); }
    var f = [];
    rows.forEach(function (m) {
      var s1 = sum(m.t1), s2 = sum(m.t2);
      if (!(Math.abs(s1 - s2) <= MAX_GRADE_DIFF)) f.push("#" + m.no + "(" + s1 + " vs " + s2 + ")");
    });
    items.push({ code: "ⓕ", item: "두 팀 급수 점수 합 차이 1 이하", rule: "|팀1 합 − 팀2 합| ≤ " + MAX_GRADE_DIFF,
      count: f.length, detail: f.slice(0, SHOW).join(", ") });

    // ⓖ–ⓙ 늦게 온 사람 (6.3 개정 7, 6.6). 늦게 온 사람이 있을 때만
    if (hasLate) {
      var lateNames = Object.keys(late);
      // ⓖ 참가 시각 전에 시작하는 경기에 배정 = 첫 가능 시간대 전 배정. (사람, 경기) 쌍을 센다
      var gv = [];
      rows.forEach(function (m) {
        people(m).forEach(function (p) { if (late[p] && minutes(m.time) < late[p].min) gv.push(p + "(" + late[p].arrival + " 도착, " + m.time + " 경기)"); });
      });
      items.push({ code: "ⓖ", item: "늦게 온 사람이 참가 시각 전 경기에 배정되지 않음", rule: "도착 전 배정 0건",
        count: gv.length, detail: gv.slice(0, SHOW).join(", ") });
      // ⓗ 최소 경기 수 이상 (사람 수)
      var hv = lateNames.filter(function (p) { return games[p] < late[p].L; })
        .map(function (p) { return p + "(" + games[p] + " < 최소 " + late[p].L + ")"; });
      items.push({ code: "ⓗ", item: "늦게 온 사람의 경기 수가 최소 경기 수 이상", rule: "최소 미달 0명",
        count: hv.length, detail: hv.slice(0, SHOW).join(", ") });
      // ⓘ 정시 참가자의 최대 경기 수 이하 (사람 수)
      var iv = lateNames.filter(function (p) { return games[p] > hi; })
        .map(function (p) { return p + "(" + games[p] + " > 정시 최대 " + hi + ")"; });
      items.push({ code: "ⓘ", item: "늦게 온 사람의 경기 수가 정시 참가자의 최대 이하", rule: "정시 최대 초과 0명",
        count: iv.length, detail: iv.slice(0, SHOW).join(", ") });
      // ⓙ 같은 참가 시각인 늦게 온 사람끼리 차이 ≤ 1 (참가 시각 묶음 수)
      var groups = {};
      lateNames.forEach(function (p) { (groups[late[p].arrival] = groups[late[p].arrival] || []).push(games[p]); });
      var jv = Object.keys(groups).sort().filter(function (k) {
        return Math.max.apply(null, groups[k]) - Math.min.apply(null, groups[k]) > 1;
      }).map(function (k) { return k + "(" + Math.min.apply(null, groups[k]) + "–" + Math.max.apply(null, groups[k]) + "경기)"; });
      items.push({ code: "ⓙ", item: "같은 참가 시각인 늦게 온 사람끼리 경기 수 차이 1 이하", rule: "최대 − 최소 ≤ 1인 묶음",
        count: jv.length, detail: jv.slice(0, SHOW).join(", ") });
    }

    // ── 참고 검사 (ⓐ–ⓕ 합계에는 넣지 않음) ──
    var extra = [];
    var unknown = Array.from(new Set([].concat.apply([], rows.map(people)))).filter(function (p) { return !info[p]; });
    extra.push({ code: "참고", item: "명단에 없는 이름", rule: "0명", count: unknown.length, detail: unknown.slice(0, SHOW).join(", ") });
    var badSum = rows.filter(function (m) { return m.s1 !== sum(m.t1) || m.s2 !== sum(m.t2); })
      .map(function (m) { return "#" + m.no; });
    extra.push({ code: "참고", item: "표기된 급수 합 = 다시 계산한 값", rule: "불일치 0건", count: badSum.length, detail: badSum.slice(0, SHOW).join(", ") });
    var tc = {};
    rows.forEach(function (m) { var k = m.time + " 코트" + m.court; tc[k] = (tc[k] || 0) + 1; });
    var courtDup = Object.keys(tc).filter(function (k) { return tc[k] > 1; });
    extra.push({ code: "참고", item: "같은 시간·코트에 두 경기", rule: "0건", count: courtDup.length, detail: courtDup.slice(0, SHOW).join(", ") });

    var total = items.reduce(function (s, x) { return s + x.count; }, 0);
    return { items: items, extra: extra, total: total };
  }

  global.Checker = { check: check };
})(this);
