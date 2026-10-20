/*
 * checker.js — 대진표 자기 점검 ⓐ–ⓗ와 참고 항목만 담는다 (CLAUDE.md 개정 8의 6.3, plan_w5b.md 4.1-2).
 * scheduler.js의 함수·상수를 쓰지 않는다. 급수 점수표, 시간대·참여 구간·몫 계산도 여기서 명세 식으로 따로 한다.
 * 입력은 Excel `대진표` 시트에 쓰는 것과 같은 표(이름·텍스트 시각)이고,
 * 성별·급수·참가·퇴장 시각은 대진표가 아니라 명단에서 다시 읽어 대조한다. 시간대 번호는 시각으로 계산한다(W5 교훈).
 */
(function (global) {
  "use strict";

  var GRADE_SCORE = { A: 4, B: 3, C: 2, D: 1, "초심": 0 };
  var MAX_GRADE_DIFF = 1;
  var SHOW = 5;   // 상세에 보여 줄 위반 사례 수
  var EPS = 1e-9;

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

  function fmt(min) { var m = ((min % 1440) + 1440) % 1440; return (m < 600 ? "0" : "") + Math.floor(m / 60) + ":" + (m % 60 < 10 ? "0" : "") + (m % 60); }

  /*
   * 6.2: S, fₚ, lₚ, mₚ, Hₚ (6.4). opts: {start, end, minutes, courts, maxGames}
   * 참가 시각이 비었으면 시작, 퇴장 시각이 비었으면 종료로 본다.
   */
  function frame(roster, opts) {
    var st = hm(opts.start), en = hm(opts.end), d = opts.minutes;
    var S = st !== null && en !== null && d > 0 && en > st ? Math.floor((en - st) / d) : 0;
    var per = {};
    roster.forEach(function (p) {
      var a = hm(p.arrival), e = hm(p.leave);
      if (a === null) a = st;
      if (e === null) e = en;
      var f = S;
      for (var i = 0; i < S; i++) if (st + i * d >= a) { f = i; break; }
      var l = -1;
      for (i = S - 1; i >= 0; i--) if (st + i * d + d <= e) { l = i; break; }
      var m = l - f + 1;
      var H = m > 0 ? m - Math.floor(m / 3) : 0;
      if (opts.maxGames) H = Math.min(H, opts.maxGames);
      per[p.name] = { f: f, l: l, m: m, H: H, gender: p.gender, score: GRADE_SCORE[p.grade],
        arrival: p.arrival ? String(p.arrival) : fmt(st), leave: p.leave ? String(p.leave) : fmt(en) };
    });
    return { S: S, start: st, minutes: d, per: per };
  }

  // 6.4 몫: qₚ = R·mₚ/Σm, Hₚ를 넘으면 Hₚ로 묶고 나머지에게 다시 비례로 (물 채우기, plan 2.3)
  function quota(names, per, M) {
    var q = {}, fixed = {}, R = 4 * M;
    for (;;) {
      var sumM = 0;
      names.forEach(function (n) { if (!fixed[n] && per[n].m > 0) sumM += per[n].m; });
      if (sumM === 0) { names.forEach(function (n) { if (!fixed[n]) q[n] = 0; }); break; }
      var over = names.filter(function (n) { return !fixed[n] && per[n].m > 0 && R * per[n].m / sumM > per[n].H + EPS; });
      if (!over.length) {
        names.forEach(function (n) { if (!fixed[n]) q[n] = per[n].m > 0 ? R * per[n].m / sumM : 0; });
        break;
      }
      over.forEach(function (n) { fixed[n] = true; q[n] = per[n].H; R -= per[n].H; });
    }
    return q;
  }

  /*
   * roster: [{name, gender, grade, arrival, leave}]
   * rows:   [{no, time:"HH:MM", court, t1:[이름,이름], t2:[이름,이름], type, s1, s2}]
   * opts:   {start, end, minutes, courts, maxGames}
   * 돌려주는 값: { items: [{code, item, rule, count, detail}] (ⓐ–ⓗ), extra: [...] (참고), total, info: {...} }
   */
  function check(roster, rows, opts) {
    var fr = frame(roster, opts);
    var per = fr.per;
    var names = roster.map(function (p) { return p.name; });
    var items = [];
    function people(m) { return m.t1.concat(m.t2); }
    function slotOf(time) { return Math.round((((hm(time) - fr.start) % 1440) + 1440) % 1440 / fr.minutes); }
    function timeOf(s) { return fmt(fr.start + s * fr.minutes); }

    // ⓐ 한 시간대에 한 사람이 두 코트(또는 한 경기에 두 번) 배정
    var perSlot = {};
    rows.forEach(function (m) {
      var c = perSlot[m.time] || (perSlot[m.time] = {});
      people(m).forEach(function (p) { c[p] = (c[p] || 0) + 1; });
    });
    var a = [], aCount = 0;
    Object.keys(perSlot).sort().forEach(function (t) {
      Object.keys(perSlot[t]).forEach(function (p) {
        var c = perSlot[t][p];
        if (c > 1) { a.push(t + " " + p + " " + c + "회"); aCount += c - 1; }
      });
    });
    items.push({ code: "ⓐ", item: "한 시간대에 한 사람이 두 코트에 배정되지 않음", rule: "같은 시간대 등장 1회",
      count: aCount, detail: a.slice(0, SHOW).join(", ") });

    // 사람별 경기 시간대 (시각으로 계산한 번호)
    var played = {};
    names.forEach(function (n) { played[n] = new Set(); });
    rows.forEach(function (m) { people(m).forEach(function (p) { (played[p] || (played[p] = new Set())).add(slotOf(m.time)); }); });

    // ⓑ 3연속 없음: 이어진 세 시간대 s, s+1, s+2에 모두 경기한 경우를 센다
    var b = [];
    Object.keys(played).forEach(function (p) {
      played[p].forEach(function (s) {
        if (played[p].has(s + 1) && played[p].has(s + 2)) b.push(p + "(" + timeOf(s) + "→" + timeOf(s + 2) + ")");
      });
    });
    items.push({ code: "ⓑ", item: "3연속 경기 없음", rule: "이어진 세 시간대 출전 0회",
      count: b.length, detail: b.slice(0, SHOW).join(", ") });

    // ⓒ 같은 파트너 2회 이상
    var pc = {};
    rows.forEach(function (m) { [m.t1, m.t2].forEach(function (team) { var k = teamKey(team); pc[k] = (pc[k] || 0) + 1; }); });
    var c = [], cCount = 0;
    Object.keys(pc).forEach(function (k) { if (pc[k] >= 2) { c.push(k + " " + pc[k] + "회"); cCount += pc[k] - 1; } });
    items.push({ code: "ⓒ", item: "같은 파트너 2회 이상 없음", rule: "파트너 조합 1회",
      count: cCount, detail: c.slice(0, SHOW).join(", ") });

    // ⓓ 경기 수 = 몫: gₚ ∈ {⌊qₚ⌋, ⌈qₚ⌉}, 참여 구간이 같은 사람끼리 차이 ≤ 1 (M = 대진표의 경기 수)
    var games = {};
    names.forEach(function (n) { games[n] = 0; });
    rows.forEach(function (m) { people(m).forEach(function (p) { if (p in games) games[p] += 1; }); });
    var q = quota(names, per, rows.length);
    var dv = [];
    names.forEach(function (n) {
      var lo = Math.floor(q[n] + EPS), hi = Math.ceil(q[n] - EPS);
      if (games[n] < lo || games[n] > hi) dv.push(n + "(" + games[n] + "경기, 몫 " + q[n].toFixed(3) + ")");
    });
    var groups = {};
    names.forEach(function (n) { var k = per[n].f + "-" + per[n].l; (groups[k] = groups[k] || []).push(games[n]); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], mx = Math.max.apply(null, g), mn = Math.min.apply(null, g);
      if (mx - mn > 1) dv.push("구간 " + timeOf(+k.split("-")[0]) + "–" + timeOf(+k.split("-")[1] + 1) + "(" + mn + "–" + mx + "경기)");
    });
    items.push({ code: "ⓓ", item: "경기 수가 몫에 맞음 (같은 참여 구간끼리 차이 1 이하)", rule: "⌊몫⌋ 또는 ⌈몫⌉",
      count: dv.length, detail: dv.slice(0, SHOW).join(", ") });

    // ⓔ 경기 종류 일치 (명단의 성별로 다시 판정)
    var e = [];
    rows.forEach(function (m) {
      function g(team) { return team.map(function (p) { return per[p] ? per[p].gender : "?"; }); }
      var k1 = kind(g(m.t1)), k2 = kind(g(m.t2));
      if (k1 === null || k1 !== k2 || k1 !== m.type) e.push("#" + m.no + "(팀1 " + k1 + ", 팀2 " + k2 + ", 표기 " + m.type + ")");
    });
    items.push({ code: "ⓔ", item: "경기 종류 일치", rule: "남복↔남복, 여복↔여복, 혼복↔혼복",
      count: e.length, detail: e.slice(0, SHOW).join(", ") });

    // ⓕ 두 팀 급수 합 차이 ≤ 1 (명단의 급수로 다시 계산)
    function sum(team) { return team.reduce(function (s, p) { return s + (per[p] ? per[p].score : NaN); }, 0); }
    var f = [];
    rows.forEach(function (m) {
      var s1 = sum(m.t1), s2 = sum(m.t2);
      if (!(Math.abs(s1 - s2) <= MAX_GRADE_DIFF)) f.push("#" + m.no + "(" + s1 + " vs " + s2 + ")");
    });
    items.push({ code: "ⓕ", item: "두 팀 급수 점수 합 차이 1 이하", rule: "|팀1 합 − 팀2 합| ≤ " + MAX_GRADE_DIFF,
      count: f.length, detail: f.slice(0, SHOW).join(", ") });

    // ⓖ 참여 구간 밖 배정 없음 ((사람, 경기) 쌍을 센다)
    var gv = [];
    rows.forEach(function (m) {
      var s = slotOf(m.time);
      people(m).forEach(function (p) {
        if (per[p] && (s < per[p].f || s > per[p].l)) gv.push(p + "(" + per[p].arrival + "–" + per[p].leave + ", " + m.time + " 경기)");
      });
    });
    items.push({ code: "ⓖ", item: "참여 구간 밖 배정 없음", rule: "참가 전·퇴장 뒤 배정 0건",
      count: gv.length, detail: gv.slice(0, SHOW).join(", ") });

    // ⓗ 2연속 공평: 2연속(이어진 두 시간대 한 쌍) 횟수의 사람 간 차이 ≤ 1
    var dbl = {};
    names.forEach(function (n) {
      var k = 0;
      played[n].forEach(function (s) { if (played[n].has(s + 1)) k++; });
      dbl[n] = k;
    });
    var dvals = names.map(function (n) { return dbl[n]; });
    var dmax = dvals.length ? Math.max.apply(null, dvals) : 0, dmin = dvals.length ? Math.min.apply(null, dvals) : 0;
    var totalD = dvals.reduce(function (s, v) { return s + v; }, 0);
    items.push({ code: "ⓗ", item: "2연속 횟수의 사람 간 차이 1 이하", rule: "최대 − 최소 ≤ 1",
      count: dmax - dmin > 1 ? 1 : 0, detail: "총 " + totalD + "회, 최소 " + dmin + "회 · 최대 " + dmax + "회" });

    // ── 참고 (판정 아님) ──
    var extra = [];
    var unknown = Array.from(new Set([].concat.apply([], rows.map(people)))).filter(function (p) { return !per[p]; });
    extra.push({ code: "참고", item: "명단에 없는 이름", rule: "0명", count: unknown.length, detail: unknown.slice(0, SHOW).join(", ") });
    var badSum = rows.filter(function (m) { return m.s1 !== sum(m.t1) || m.s2 !== sum(m.t2); }).map(function (m) { return "#" + m.no; });
    extra.push({ code: "참고", item: "표기된 급수 합 = 다시 계산한 값", rule: "불일치 0건", count: badSum.length, detail: badSum.slice(0, SHOW).join(", ") });
    var tc = {};
    rows.forEach(function (m) { var k = m.time + " 코트" + m.court; tc[k] = (tc[k] || 0) + 1; });
    var courtDup = Object.keys(tc).filter(function (k) { return tc[k] > 1; });
    extra.push({ code: "참고", item: "같은 시간·코트에 두 경기", rule: "0건", count: courtDup.length, detail: courtDup.slice(0, SHOW).join(", ") });

    // 빈 코트 수·위치, M과 단순 상한 (6.5의 두 식), 2연속 사람별
    var C = opts.courts, S = fr.S;
    var loads = [];
    for (var t = 0; t < S; t++) loads.push(0);
    rows.forEach(function (m) { var s = slotOf(m.time); if (s >= 0 && s < S) loads[s] += 1; });
    var A = loads.map(function (_, t) { return names.filter(function (n) { return per[n].f <= t && t <= per[n].l; }).length; });
    var empty = C * S - rows.length;
    var pos = [];
    loads.forEach(function (k, t) {
      if (k >= C) return;
      var laterMore = loads.slice(t + 1).some(function (x) { return x > k; });
      var why = Math.floor(A[t] / 4) < C ? "와 있는 " + A[t] + "명으로 최대 " + Math.floor(A[t] / 4) + "경기" : "인원으로는 " + C + "경기 가능";
      pos.push(timeOf(t) + " " + (C - k) + "칸" + (laterMore ? " (뒤에 더 많은 시간대 있음 — " + why + ")" : ""));
    });
    var simple = Math.min(A.reduce(function (s, x) { return s + Math.min(C, Math.floor(x / 4)); }, 0),
      Math.floor(names.reduce(function (s, n) { return s + per[n].H; }, 0) / 4));
    extra.push({ code: "참고", item: "빈 코트 (수 · 위치)", rule: "판정 아님", count: empty, detail: pos.join(", ") || "없음", info: true });
    extra.push({ code: "참고", item: "총 경기 수 M과 6.5 상한(시간대 합·⌊ΣH/4⌋)", rule: "판정 아님", count: rows.length,
      detail: "M " + rows.length + " / 6.5 상한 " + simple + " / 시간대별 " + loads.join(","), info: true });
    var withD = names.filter(function (n) { return dbl[n] > 0; }).map(function (n) { return n + " " + dbl[n] + "회"; });
    extra.push({ code: "참고", item: "2연속 총 횟수 (사람별)", rule: "판정 아님", count: totalD, detail: withD.slice(0, 10).join(", ") + (withD.length > 10 ? " 외 " + (withD.length - 10) + "명" : ""), info: true });

    var total = items.reduce(function (s, x) { return s + x.count; }, 0);
    return { items: items, extra: extra, total: total,
      info: { S: S, loads: loads, empty: empty, totalDoubles: totalD, doubles: dbl, games: games, q: q, per: per } };
  }

  global.Checker = { check: check };
})(this);
