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
    items.push(fairItem("ⓗ", "2연속 횟수의 사람 간 차이 1 이하", "최대 − 최소 ≤ 1", dmax - dmin, opts.relaxed,
      "총 " + totalD + "회, 최소 " + dmin + "회 · 최대 " + dmax + "회"));

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
    return { items: items, extra: extra, total: total, relaxNote: items[7].relaxNote || 0,
      info: { S: S, loads: loads, empty: empty, totalDoubles: totalD, doubles: dbl, games: games, q: q, per: per } };
  }

  /*
   * ⓗ·ⓗ′ 판정 (개정 11, plan_w7b 2.4). gap = 2연속 차이(최대 − 최소).
   * 앱이 "코트를 채우려고 완화"(relaxed)라고 넘겼고 차이가 2 이상이면 위반이 아니라 참고(relaxNote = 차이).
   * 완화 표시 없이 차이 2 이상이면 위반 (개정 10과 같음). 3연속(ⓑ)은 이 표시와 관계없다
   */
  function fairItem(code, item, rule, gap, relaxed, detail) {
    var it = { code: code, item: item, rule: rule, count: gap > 1 && !relaxed ? 1 : 0, detail: detail, gap: gap };
    if (gap > 1 && relaxed) {
      it.relaxNote = gap;
      it.detail = "참고: 코트를 채우려고 2연속 차이 " + gap + " 허용 · " + detail;
    }
    return it;
  }

  // ── 재편성 결과 점검 (CLAUDE.md 6.8.5, plan_w7.md 2.11) ─────────────
  // 3연속 금지에서 이어진 n칸에 직전 연속 run(0·1·2)으로 할 수 있는 최대 경기 수 (scheduler.js와 따로, 칸마다 세어 봄)
  function most(n, run) {
    var best = 0;
    // 작은 n이므로 "뛸 수 있으면 뛴다"를 그대로 세지 않고, 모든 출전 무늬 중 최대를 센다
    var lim = Math.min(n, 16);
    for (var mask = 0; mask < (1 << lim); mask++) {
      var r = run, cnt = 0, ok = true;
      for (var i = 0; i < lim; i++) {
        if (mask & (1 << i)) { if (r >= 2) { ok = false; break; } r++; cnt++; } else r = 0;
      }
      if (ok && cnt > best) best = cnt;
    }
    if (n > lim) best += (n - lim) - Math.floor((n - lim) / 3);   // 16칸 넘는 일은 없지만 대비
    return best;
  }

  /*
   * λ와 남은 몫 ρ (6.8.4). scheduler.js와 다른 방법: 실수 이분법으로 가운데 묶음을 찾고, 그 묶음으로 정확한 분수를 푼다.
   * ppl: {이름: {m, g0, H}}, M: 남은 경기 수 → {lam: {n, d}, rho: {이름: {n, d}}}
   */
  function restShares(ppl, M) {
    var names = Object.keys(ppl).filter(function (k) { return ppl[k].H > 0 && ppl[k].m > 0; });
    var want = 4 * M;
    function F(l) { return names.reduce(function (s, k) { var p = ppl[k]; return s + Math.max(0, Math.min(l * p.m - p.g0, p.H)); }, 0); }
    var lo = 0, hi = 1;
    while (F(hi) < want - EPS && hi < 1e6) hi *= 2;
    for (var it = 0; it < 200; it++) { var mid = (lo + hi) / 2; if (F(mid) >= want - 1e-12) hi = mid; else lo = mid; }
    var lam = hi;
    var top = 0, gB = 0, mB = 0, B = {};
    names.forEach(function (k) {
      var p = ppl[k], v = lam * p.m - p.g0;
      if (v >= p.H - 1e-9) top += p.H;
      else if (v > 1e-9) { B[k] = true; gB += p.g0; mB += p.m; }
    });
    var L = mB > 0 ? { n: want - top + gB, d: mB } : null;
    if (!L) {
      // 가운데 묶음이 없으면 F가 평평한 구간: 모두 0 또는 H′. 가장 작은 λ = 꺾이는 점 하나로 둔다(ρ와 무관)
      var best = null;
      names.forEach(function (k) { var p = ppl[k]; var b = { n: p.g0 + p.H, d: p.m }; if (b.n * 1 / b.d <= lam + 1e-9 && (!best || b.n * best.d > best.n * b.d)) best = b; });
      L = best || { n: 0, d: 1 };
    }
    var rho = {};
    Object.keys(ppl).forEach(function (k) {
      var p = ppl[k];
      if (!(p.H > 0 && p.m > 0)) { rho[k] = { n: 0, d: 1 }; return; }
      var v = L.n * p.m - p.g0 * L.d;
      rho[k] = { n: Math.max(0, Math.min(v, p.H * L.d)), d: L.d };
    });
    return { lam: L, rho: rho };
  }

  /*
   * roster: 변동 반영 뒤 명단 [{name, gender, grade, arrival, leave}] (새로 온 사람 포함, 불참(지난 경기 없음)은 뺀 것)
   * baseRows: 바탕 대진표 행 (시간 글자) — 고정 시간대 0…T의 비교(ⓘ)와 g0 계산에 쓴다
   * rows: 재편성 결과 하루 전체 행, opts: 설정, T: 기준 시간대 번호
   * 돌려주는 값: check()와 같은 모양 (items: ⓐ ⓑ ⓒ ⓓ′ ⓔ ⓕ ⓖ ⓗ′ ⓘ)
   */
  function checkRest(roster, baseRows, rows, opts, T) {
    var all = check(roster, rows, opts);           // ⓐ ⓑ ⓒ ⓔ ⓕ ⓖ는 하루 전체 대진·바뀐 구간 그대로
    var fr = frame(roster, opts), per = fr.per;
    var names = roster.map(function (p) { return p.name; });
    function slotOf(time) { return Math.round((((hm(time) - fr.start) % 1440) + 1440) % 1440 / fr.minutes); }
    function timeOf(s) { return fmt(fr.start + s * fr.minutes); }
    function people(m) { return m.t1.concat(m.t2); }
    var on = {};
    names.forEach(function (n) { on[n] = {}; });
    rows.forEach(function (m) { people(m).forEach(function (p) { if (on[p]) on[p][slotOf(m.time)] = true; }); });
    var baseOn = {};
    names.forEach(function (n) { baseOn[n] = {}; });
    baseRows.forEach(function (m) { var s = slotOf(m.time); if (s <= T) people(m).forEach(function (p) { if (baseOn[p]) baseOn[p][s] = true; }); });
    // 사람마다 g0·run(바탕 기준)·m′·H′
    var ppl = {};
    names.forEach(function (n) {
      var v = per[n], g0 = 0, run = 0;
      for (var t = 0; t <= T; t++) { if (baseOn[n][t]) { g0++; run++; } else run = 0; }
      var fr2 = Math.max(v.f, T + 1), mr = Math.max(0, v.l - fr2 + 1);
      var H = most(mr, fr2 === T + 1 ? run : 0);
      if (opts.maxGames) H = Math.min(H, opts.maxGames - g0);
      ppl[n] = { m: v.m, g0: g0, H: Math.max(0, H), mRest: mr };
    });
    var restGames = {};
    names.forEach(function (n) { restGames[n] = Object.keys(on[n]).filter(function (s) { return +s > T; }).length; });
    var Mrest = rows.filter(function (m) { return slotOf(m.time) > T; }).length;
    var sh = restShares(ppl, Mrest);

    // ⓓ′ 남은 배정 rₚ ∈ {⌊ρ⌋, ⌈ρ⌉}
    var dv = [];
    names.forEach(function (n) {
      var r = sh.rho[n], lo = Math.floor(r.n / r.d), hi = Math.ceil(r.n / r.d);
      if (restGames[n] < lo || restGames[n] > hi) dv.push(n + "(남은 " + restGames[n] + "경기, 몫 " + (r.n / r.d).toFixed(3) + ")");
    });
    // ⓗ′ 남은 2연속(T·T+1 쌍부터)의 차이 — 남은 배정 1 이상인 사람끼리 (plan Q9)
    var rd = {};
    names.forEach(function (n) { var k = 0; for (var s = T; s < fr.S - 1; s++) if (on[n][s] && on[n][s + 1]) k++; rd[n] = k; });
    var hv = names.filter(function (n) { return restGames[n] >= 1; }).map(function (n) { return rd[n]; });
    var hmax = hv.length ? Math.max.apply(null, hv) : 0, hmin = hv.length ? Math.min.apply(null, hv) : 0;
    var totalR = names.reduce(function (s, n) { return s + rd[n]; }, 0);
    // ⓘ 고정 불변: 0…T 행이 바탕과 칸마다 같다 (시간·코트·네 사람·종류)
    function key(m) { return [m.time, m.court, m.t1.join("·"), m.t2.join("·"), m.type].join("|"); }
    var bk = baseRows.filter(function (m) { return slotOf(m.time) <= T; }).map(key).sort();
    var rk = rows.filter(function (m) { return slotOf(m.time) <= T; }).map(key).sort();
    var iv = [];
    var bs = {}, rs = {};
    bk.forEach(function (k) { bs[k] = (bs[k] || 0) + 1; });
    rk.forEach(function (k) { rs[k] = (rs[k] || 0) + 1; });
    Object.keys(bs).forEach(function (k) { if ((rs[k] || 0) < bs[k]) iv.push("바탕에만: " + k); });
    Object.keys(rs).forEach(function (k) { if ((bs[k] || 0) < rs[k]) iv.push("결과에만: " + k); });

    var pick = function (code) { return all.items.filter(function (x) { return x.code === code; })[0]; };
    var items = [pick("ⓐ"), pick("ⓑ"), pick("ⓒ"),
      { code: "ⓓ′", item: "남은 경기 수가 남은 몫에 맞음", rule: "⌊ρ⌋ 또는 ⌈ρ⌉ (λ = " + sh.lam.n + "/" + sh.lam.d + ")", count: dv.length, detail: dv.slice(0, SHOW).join(", ") },
      pick("ⓔ"), pick("ⓕ"), pick("ⓖ"),
      fairItem("ⓗ′", "남은 시간대 2연속 횟수의 사람 간 차이 1 이하", "최대 − 최소 ≤ 1 (남은 경기 1 이상인 사람)", hmax - hmin, opts.relaxed,
        "총 " + totalR + "회, 최소 " + hmin + "회 · 최대 " + hmax + "회"),
      { code: "ⓘ", item: "진행된 시간대(" + timeOf(0) + "–" + timeOf(T + 1) + ")가 바탕과 같음", rule: "칸마다 같음", count: iv.length, detail: iv.slice(0, SHOW).join(", ") }];
    var extra = all.extra.slice();
    var dayTotal = names.map(function (n) {
      var g = all.info.games[n], lm = (sh.lam.n * ppl[n].m) / sh.lam.d;
      return n + " " + ppl[n].g0 + "+" + restGames[n] + "=" + g + " (λm " + lm.toFixed(2) + ")";
    });
    extra.push({ code: "참고", item: "하루 합계 (지금까지 + 남은 = 합계, λ × 참여 시간대)", rule: "판정 아님", count: rows.length, detail: dayTotal.slice(0, 12).join(", ") + (dayTotal.length > 12 ? " 외 " + (dayTotal.length - 12) + "명" : ""), info: true });
    extra.push({ code: "참고", item: "남은 경기 수 M′", rule: "판정 아님", count: Mrest, detail: "하루 " + rows.length + "경기 중 남은 " + Mrest + "경기", info: true });
    var total = items.reduce(function (s, x) { return s + x.count; }, 0);
    return { items: items, extra: extra, total: total, rest: true, relaxNote: items[7].relaxNote || 0,
      info: { S: fr.S, loads: all.info.loads, empty: all.info.empty, totalDoubles: all.info.totalDoubles, restDoubles: totalR,
        doubles: all.info.doubles, restDbl: rd, games: all.info.games, restGames: restGames, ppl: ppl, lambda: sh.lam, rho: sh.rho, per: per } };
  }

  global.Checker = { check: check, checkRest: checkRest, restShares: restShares };
})(this);
