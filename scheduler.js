/*
 * scheduler.js — 대진 생성 규칙만 담는다 (화면 코드와 분리). CLAUDE.md 개정 8의 6·7절, _work\plan_w5b.md 2절.
 * 2.0.0: 시간·코트가 먼저 정해지고 1인당 경기 수는 참여 시간에 비례해 계산한다 (1.x 생성 코드는 _work\scheduler_v1.2.0.js).
 * file://에서도 동작하도록 ES 모듈이 아닌 일반 스크립트로, 전역 객체 Scheduler 하나만 내보낸다.
 * 무작위 선택은 모두 대진 번호를 씨앗값으로 쓰는 난수 생성기로만 한다 (Math.random 사용 금지).
 *
 * 계산 단계 (plan_w5b.md 2.8, W7을 위해 단계마다 따로 부를 수 있게 나눔)
 *   slots → intervals(fₚ, lₚ, mₚ, Aₜ, Hₚ) → loadCaps / upperBound / lexLoads(부하 목록) → quotas(qₚ, 정수 목표) → createSearch
 */
(function (global) {
  "use strict";

  // 이 파일의 생성 결과가 바뀌면 올린다 (CLAUDE.md 7절)
  // 2.0.0 (CLAUDE.md 개정 8): 종료 시각·코트 수 입력, 참여 시간 비례 몫, 2연속 허용(3연속 금지), 빈 코트는 뒤로
  // 2.1.0 (CLAUDE.md 개정 10, _work\plan_w7.md): 진행 중 재편성(6.8)만 더함. 재편성이 없는 대진은 2.0.0과 같다
  //   (2.0.0 함수는 그대로 두고, 재편성은 이 파일 끝의 rest* 함수가 따로 한다)
  // 2.2.0 (CLAUDE.md 개정 11, _work\plan_w7b.md): 코트 채우기 우선 — ①(2.1.0 그대로)에서 못 찾으면 M을 줄이기 전에
  //   같은 M에서 ⓗ(ⓗ′)를 완화해 ②로 다시 찾는다. ②는 ①의 난수·시도 카운터를 쓰지 않는다(plan_w7b 2.1)
  var SCHEDULER_VERSION = "2.2.0";
  var REPLAY_VERSIONS = ["2.0.0", "2.1.0"];      // 경기 수를 줄이지 않은 파일이면 2.2.0에서도 같은 대진 (plan_w7b 3.1)

  var GRADE_SCORE = { A: 4, B: 3, C: 2, D: 1, "초심": 0 };   // 6.1
  var MAX_GRADE_DIFF = 1;
  var SOLUTIONS_TO_COMPARE = 30;       // 6.7: 이 개수만큼 해를 찾아 고른다
  var SLOT_ATTEMPTS = 60;              // 한 시간대를 채우는 시도 횟수 (1.x와 같은 값)
  var RESTED_ATTEMPTS = 20;            // 그 앞에 직전에 쉰 사람만으로 채워 보는 시도 횟수 (plan 2.4)
  var TRIES_PER_M = 5000;              // plan 2.5: M마다 시도 횟수
  var STRICT_TRIES = 2500;             // 그중 앞부분은 사전순 최대 부하 목록 그대로
  var MAX_SEARCH_DROPS = 3;            // 탐색으로 M을 줄이는 횟수 한도
  var MAX_TOTAL_TRIES = 20000;         // 전체 시도 한도 (1.x MAX_RESTARTS와 같음)
  var QUOTA_REDRAW = 250;              // 한 M에서 이만큼 시도해도 못 찾으면 몫 동점 순서를 다시 뽑는다 (W5b 시험 중 결함 수정 1)
  var QUOTA_SALT = 0x85EBCA6B;         // 몫 동점 난수 줄기 (생성 난수와 다름)
  var RELAX_TRIES_PER_M = 5000;        // plan_w7b 2.2: ② M마다 시도 횟수 (앞 STRICT_TRIES는 사전순 최대 부하 그대로)
  var MAX_RELAX_TRIES = 20000;         // ② 전체 시도 한도 (① 한도와 따로 센다)
  var RELAX_SALT = 0x2545F491;         // ② 생성 난수 줄기 (①의 rng와 다름)
  var RELAX_DRAW_BASE = 1000;          // ② 몫 동점 다시 뽑기 번호 (①의 draw와 겹치지 않게)

  // ── 난수 ─────────────────────────────────────────────────
  // mulberry32: 32비트 씨앗값 하나로 [0, 1) 난수를 만드는 작은 생성기
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 뒤에서부터 섞는 Fisher–Yates
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ── 정렬 (7절: 유니코드 코드값 순, 이름 → 성별 → 급수) ─────────
  function cmpCodePoint(a, b) {
    var x = Array.from(a), y = Array.from(b);
    var n = Math.min(x.length, y.length);
    for (var i = 0; i < n; i++) {
      var d = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (d !== 0) return d;
    }
    return x.length - y.length;
  }

  function sortRoster(roster) {
    return roster.slice().sort(function (p, q) {
      return cmpCodePoint(p.name, q.name) || cmpCodePoint(p.gender, q.gender) || cmpCodePoint(p.grade, q.grade);
    });
  }

  // ── 시각 ─────────────────────────────────────────────────
  function pad2(v) { return (v < 10 ? "0" : "") + v; }

  // "HH:MM"(두 자리 시:분, 00:00–23:59)만 분으로 바꾼다. 그 밖은 null (추측하지 않음)
  function parseHM(s) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    return h <= 23 && mi <= 59 ? h * 60 + mi : null;
  }

  function fmtHM(min) {
    var m = ((min % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  }

  // start "HH:MM" + minutes × t → "HH:MM"
  function slotTime(start, minutes, t) { return fmtHM(parseHM(start) + minutes * t); }

  // ── 6.2 시간대와 참여 구간 ───────────────────────────────
  // settings: {start, end, minutes, courts, maxGames(없으면 null)}
  function slots(settings) {
    var st = parseHM(settings.start), en = parseHM(settings.end), d = settings.minutes;
    var S = st !== null && en !== null && d >= 1 && en > st ? Math.floor((en - st) / d) : 0;
    return { S: S, start: st, end: en, minutes: d };
  }

  // 3연속 금지에서 n개 시간대에 할 수 있는 최대 경기 수. run = 바로 앞에서 이미 이어서 뛴 수(0·1·2)
  var maxPlaysMemo = {};
  function maxPlays(n, run) {
    if (n <= 0) return 0;
    var key = n + ":" + run;
    if (key in maxPlaysMemo) return maxPlaysMemo[key];
    var c = run, cnt = 0;
    for (var i = 0; i < n; i++) { if (c < 2) { cnt++; c++; } else c = 0; }   // 뛸 수 있으면 뛰는 것이 최대
    maxPlaysMemo[key] = cnt;
    return cnt;
  }

  function capOf(m, maxGames) {
    if (m <= 0) return 0;
    var h = m - Math.floor(m / 3);
    return maxGames ? Math.min(h, maxGames) : h;
  }

  /*
   * 사람마다 fₚ, lₚ, mₚ, Hₚ와 시간대마다 Aₜ. 참가 시각이 비었으면 시작, 퇴장 시각이 비었으면 종료 (자정 넘김은 다루지 않음).
   * 참가 시각이 시작보다 이르면 f = 0 (plan Q12), 퇴장 시각이 종료보다 늦으면 l = S − 1.
   * 형식이 아닌 시각은 화면에서 ⚠로 막으므로 여기서는 정시·끝까지로 본다.
   */
  function intervals(roster, settings) {
    var sl = slots(settings), S = sl.S, d = sl.minutes;
    var people = roster.map(function (p, i) {
      var a = parseHM(p.arrival), e = parseHM(p.leave);
      if (a === null) a = sl.start;
      if (e === null) e = sl.end;
      var f = 0;
      while (f < S && sl.start + f * d < a) f++;               // tᵢ ≥ 참가 시각인 가장 작은 i (없으면 S)
      var l = S - 1;
      while (l >= 0 && sl.start + l * d + d > e) l--;           // tᵢ + d ≤ 퇴장 시각인 가장 큰 i (없으면 −1)
      var m = l - f + 1;
      return { index: i, f: f, l: l, m: m, H: capOf(m, settings.maxGames), late: f > 0, early: l < S - 1 };
    });
    var A = [];
    for (var t = 0; t < S; t++) A.push(people.filter(function (p) { return p.f <= t && t <= p.l; }).length);
    return { S: S, slots: sl, people: people, A: A, bad: people.filter(function (p) { return p.m <= 0; }) };
  }

  // ── 6.5 상한 M과 부하 목록 (plan 2.2) ─────────────────────
  // slotCap[t] = min(C, ⌊Aₜ/4⌋), win[t] = 시간대 t, t+1, t+2의 경기 수 합 상한 (한 사람은 세 칸 중 최대 2경기)
  function loadCaps(iv, courts) {
    var S = iv.S, t;
    var slotCap = [], win = [];
    for (t = 0; t < S; t++) slotCap.push(Math.min(courts, Math.floor(iv.A[t] / 4)));
    for (t = 0; t + 2 < S; t++) {
      var seats = 0;
      iv.people.forEach(function (p) {
        var ov = Math.min(p.l, t + 2) - Math.max(p.f, t) + 1;
        if (ov > 0) seats += Math.min(2, ov);
      });
      win.push(Math.floor(seats / 4));
    }
    return { slotCap: slotCap, win: win, courts: courts };
  }

  /*
   * 뒤에서부터 동적 계획: suffix[t][a][b] = 시간대 t−2, t−1의 경기 수가 a, b일 때 t…S−1에 넣을 수 있는 최대 경기 수.
   * fixedLoads(W7): 앞쪽 시간대의 경기 수를 이미 정해진 값으로 묶는다. 2.0.0에서는 쓰지 않음
   */
  function suffixTable(caps, S, fixedLoads) {
    var C = caps.courts, t, a, b, x;
    var tbl = new Array(S + 1);
    function grid(v) { var g = []; for (a = 0; a <= C; a++) { g.push([]); for (b = 0; b <= C; b++) g[a].push(v); } return g; }
    tbl[S] = grid(0);
    for (t = S - 1; t >= 0; t--) {
      tbl[t] = grid(-Infinity);
      for (a = 0; a <= C; a++) {
        for (b = 0; b <= C; b++) {
          var best = -Infinity;
          for (x = 0; x <= caps.slotCap[t]; x++) {
            if (fixedLoads && t < fixedLoads.length && x !== fixedLoads[t]) continue;
            if (t >= 2 && a + b + x > caps.win[t - 2]) continue;
            var v = x + tbl[t + 1][b][x];
            if (v > best) best = v;
          }
          tbl[t][a][b] = best;
        }
      }
    }
    return tbl;
  }

  // 상한 M (6.5 + plan 2.2): min(시간대·3칸 창 조건의 최대 합, ⌊ΣHₚ/4⌋). 이유를 알 수 있게 각 값도 돌려준다
  function upperBound(iv, courts, fixedLoads) {
    var S = iv.S;
    var caps = loadCaps(iv, courts);
    var full = courts * S;
    var bySlot = caps.slotCap.reduce(function (s, v) { return s + v; }, 0);
    var tbl = S > 0 ? suffixTable(caps, S, fixedLoads) : null;
    var byWindow = S > 0 ? Math.max(0, tbl[0][0][0]) : 0;
    var byH = Math.floor(iv.people.reduce(function (s, p) { return s + p.H; }, 0) / 4);
    return { M: Math.min(byWindow, byH), full: full, bySlot: bySlot, byWindow: byWindow, byH: byH, caps: caps, table: tbl };
  }

  // 같은 M을 만드는 부하 목록 중 앞에서부터 사전순으로 가장 큰 것 (빈 코트는 뒤로, 6.5)
  function lexLoads(ub, S, M, fixedLoads) {
    if (M > ub.byWindow) return null;
    var caps = ub.caps, tbl = ub.table;
    var loads = [], sum = 0, a = 0, b = 0;
    for (var t = 0; t < S; t++) {
      var pick = -1;
      for (var x = Math.min(caps.slotCap[t], M - sum); x >= 0; x--) {
        if (fixedLoads && t < fixedLoads.length && x !== fixedLoads[t]) continue;
        if (t >= 2 && a + b + x > caps.win[t - 2]) continue;
        if (sum + x + tbl[t + 1][b][x] >= M) { pick = x; break; }
      }
      if (pick < 0) return null;
      loads.push(pick);
      sum += pick; a = b; b = pick;
    }
    return sum === M ? loads : null;
  }

  // ── 6.4 몫 (plan 2.3) ──────────────────────────────────
  /*
   * 물 채우기: 몫 qₚ = R × mₚ ÷ Σm 에서 Hₚ를 넘는 사람은 Hₚ로 고정하고, 남은 자리를 나머지에게 다시 비례로 나눈다.
   * 정수로: 모두 ⌊q⌋ → 남은 자리는 소수점 큰 사람부터(같으면 대진 번호 난수). 성별 합이 홀수면(4M이 짝수라 남·여가 함께 홀수)
   * 남은 자리를 받은 사람 1명과 못 받은 다른 성별 1명을 바꾼다(소수점 순위가 가장 덜 어긋나는 쌍, plan Q2).
   * 소수 오차가 없도록 마지막 단계의 몫을 분자/분모 정수로 다룬다.
   * gd: 성별 배열. 돌려주는 값 ok: false → reason "cap"(상한 합 부족) | "parity"(짝수로 맞출 수 없음)
   */
  function quotas(iv, gd, M, seed, draw) {
    var people = iv.people, n = people.length;
    var R = 4 * M;
    var fixed = new Array(n).fill(false);
    var den = 1, num = new Array(n).fill(0);
    for (;;) {
      var sumM = 0, i;
      for (i = 0; i < n; i++) if (!fixed[i] && people[i].m > 0) sumM += people[i].m;
      if (sumM === 0) { if (R > 0) return { ok: false, reason: "cap" }; break; }
      var over = [];
      for (i = 0; i < n; i++) {
        if (fixed[i] || people[i].m <= 0) continue;
        if (R * people[i].m > people[i].H * sumM) over.push(i);    // q > H
      }
      if (!over.length) {
        den = sumM;
        for (i = 0; i < n; i++) num[i] = fixed[i] ? people[i].H * sumM : (people[i].m > 0 ? R * people[i].m : 0);
        break;
      }
      over.forEach(function (j) { fixed[j] = true; R -= people[j].H; });
      if (R < 0) return { ok: false, reason: "cap" };
    }
    var q = num.map(function (v) { return v / den; });
    var target = num.map(function (v) { return Math.floor(v / den); });
    var frac = num.map(function (v) { return v % den; });
    var rest = 4 * M - target.reduce(function (s, v) { return s + v; }, 0);
    // draw: 같은 M에서 동점 순서를 다시 뽑는 번호 (0이 처음). 다시 뽑아도 대진 번호 난수이고 ⓓ 범위 안이다
    var rng = makeRng((seed ^ QUOTA_SALT ^ Math.imul(M, 0x9E3779B1) ^ Math.imul(draw || 0, 0x27D4EB2F)) >>> 0);
    var rank = shuffle(Array.from({ length: n }, function (_, k) { return k; }), rng);
    var rk = new Array(n);
    rank.forEach(function (p, r) { rk[p] = r; });
    var cand = [];
    for (var c = 0; c < n; c++) if (frac[c] > 0) cand.push(c);
    cand.sort(function (a, b) { return (frac[b] - frac[a]) || (rk[a] - rk[b]); });
    if (rest > cand.length) return { ok: false, reason: "cap" };
    var got = new Array(n).fill(false);
    cand.slice(0, rest).forEach(function (p) { got[p] = true; target[p] += 1; });

    var men = 0;
    for (c = 0; c < n; c++) if (gd[c] === "남") men += target[c];
    var swapped = null;
    if (men % 2 !== 0) {
      // 받은 사람 중 순위가 가장 낮은 사람 ↔ 못 받은 다른 성별 중 순위가 가장 높은 사람
      var opts = [];
      ["남", "여"].forEach(function (g) {
        var giver = null, taker = null;
        for (var k = cand.length - 1; k >= 0; k--) { var p = cand[k]; if (got[p] && gd[p] === g) { giver = p; break; } }
        for (k = 0; k < cand.length; k++) { var w = cand[k]; if (!got[w] && gd[w] !== g) { taker = w; break; } }
        if (giver !== null && taker !== null) opts.push({ giver: giver, taker: taker, loss: frac[giver] - frac[taker] });
      });
      if (!opts.length) return { ok: false, reason: "parity", q: q, target: target };
      var minLoss = Math.min.apply(null, opts.map(function (o) { return o.loss; }));
      opts = opts.filter(function (o) { return o.loss === minLoss; });
      var pick = opts.length === 1 ? opts[0] : opts[Math.floor(rng() * opts.length)];
      target[pick.giver] -= 1; target[pick.taker] += 1;
      swapped = pick;
    }
    return { ok: true, q: q, target: target, swapped: swapped };
  }

  // ── 2연속 필요 판단 (5.1, plan 2.4) ──────────────────────
  function needsDoubles(iv, target, loads) {
    var why = [];
    iv.people.forEach(function (p) {
      if (p.m > 0 && target[p.index] > Math.ceil(p.m / 2)) why.push({ kind: "person", index: p.index });
    });
    for (var t = 0; t + 1 < iv.S; t++) {
      var present = iv.people.filter(function (p) { return p.f <= t + 1 && p.l >= t; }).length;
      if (4 * (loads[t] + loads[t + 1]) > present) why.push({ kind: "pair", slot: t });
    }
    return why;
  }

  /*
   * 생성 전 계산 (② 화면의 예상 정보와 탐색 시작점). 성별 짝수로 안 되는 M은 계산으로 건너뛴다(시도 횟수를 쓰지 않음).
   * 돌려주는 값: {iv, ub, M, loads, quota, parityDrops:[M…], reason}
   */
  function plan(roster, settings, seed, fixedLoads) {
    var iv = intervals(roster, settings);
    var gd = roster.map(function (p) { return p.gender; });
    var ub = upperBound(iv, settings.courts, fixedLoads);
    var out = { iv: iv, ub: ub, M: 0, loads: null, quota: null, parityDrops: [], reason: null };
    if (iv.S < 1 || iv.bad.length) { out.reason = "input"; return out; }
    var M = ub.M;
    while (M > 0) {
      var qt = quotas(iv, gd, M, seed);
      if (qt.ok) {
        out.M = M; out.quota = qt; out.loads = lexLoads(ub, iv.S, M, fixedLoads);
        return out;
      }
      out.parityDrops.push(M);
      M -= 1;
    }
    out.reason = out.parityDrops.length ? "parity" : "empty";
    return out;
  }

  // ── 대진 생성 ─────────────────────────────────────────────
  function pairKey(a, b) { return a < b ? a + "," + b : b + "," + a; }

  // 1.x와 같은 짝 찾기: seed(첫 사람)로 시작해 pool 순서대로 파트너·상대를 고른다
  function findMatch(seed, pool, sc, gd, partners, rng) {
    var types = gd[seed] === "남" ? ["혼복", "남복"] : ["혼복", "여복"];
    shuffle(types, rng);
    for (var ti = 0; ti < types.length; ti++) {
      var typ = types[ti];
      var i, j, q, s1;
      if (typ === "혼복") {
        var wantPartner = gd[seed] === "남" ? "여" : "남";
        var men = pool.filter(function (p) { return gd[p] === "남"; });
        var women = pool.filter(function (p) { return gd[p] === "여"; });
        for (var qi = 0; qi < pool.length; qi++) {
          q = pool[qi];
          if (gd[q] !== wantPartner) continue;
          if (partners.has(pairKey(seed, q))) continue;
          s1 = sc[seed] + sc[q];
          for (i = 0; i < men.length; i++) {
            var m = men[i];
            if (m === q) continue;
            for (j = 0; j < women.length; j++) {
              var w = women[j];
              if (w === q) continue;
              if (Math.abs(s1 - sc[m] - sc[w]) > MAX_GRADE_DIFF) continue;
              if (partners.has(pairKey(m, w))) continue;
              return { t1: [seed, q], t2: [m, w], type: typ };
            }
          }
        }
      } else {
        var same = pool.filter(function (p) { return gd[p] === gd[seed]; });
        for (var si = 0; si < same.length; si++) {
          q = same[si];
          if (partners.has(pairKey(seed, q))) continue;
          s1 = sc[seed] + sc[q];
          var rest = same.filter(function (p) { return p !== q; });
          for (i = 0; i < rest.length; i++) {
            for (j = i + 1; j < rest.length; j++) {
              var a = rest[i], b = rest[j];
              if (Math.abs(s1 - sc[a] - sc[b]) > MAX_GRADE_DIFF) continue;
              if (partners.has(pairKey(a, b))) continue;
              return { t1: [seed, q], t2: [a, b], type: typ };
            }
          }
        }
      }
    }
    return null;
  }

  /*
   * 한 번 시도 (plan 2.4). 시간대를 앞에서부터 채운다.
   * strict: loads[t]경기를 정확히 넣는다. flexible: 못 넣은 경기는 다음 시간대로 넘긴다(시간대 상한 안에서, 앞쪽 우선).
   * 뽑는 순서: 이번에 안 뛰면 못 채우는 사람 → 직전에 쉰 사람 → 직전에 뛴 사람 중 2연속이 적은 사람 (같은 묶음은 남은 경기 + 난수)
   * fixed(W7): {matches:[{slot,court,t1,t2,type}], fromSlot} — 고정 경기로 기록을 채우고 fromSlot부터 만든다. 2.0.0에서는 빈 값
   */
  function tryBuild(ctx, target, loads, flexible, rng, relax) {
    var n = ctx.n, S = ctx.S, f = ctx.f, l = ctx.l, sc = ctx.sc, gd = ctx.gd;
    var remaining = target.slice();
    var run = new Array(n).fill(0);
    var doubles = new Array(n).fill(0);
    var partners = new Set();
    var schedule = [];
    var actual = [];
    var t, p, u;
    var fromSlot = ctx.fixed ? ctx.fixed.fromSlot : 0;
    if (ctx.fixed) {
      for (t = 0; t < fromSlot; t++) {
        var fm = ctx.fixed.matches.filter(function (m) { return m.slot === t; });
        var on = {};
        fm.forEach(function (m) {
          schedule.push(m);
          partners.add(pairKey(m.t1[0], m.t1[1])); partners.add(pairKey(m.t2[0], m.t2[1]));
          m.t1.concat(m.t2).forEach(function (x) { on[x] = true; });
        });
        for (p = 0; p < n; p++) {
          if (on[p]) { remaining[p] -= 1; if (run[p] >= 1) doubles[p] += 1; run[p] += 1; } else run[p] = 0;
        }
        actual.push(fm.length);
      }
    }
    var spareAfter = [];
    for (t = 0; t < S; t++) {
      var sp = 0;
      for (u = t + 1; u < S; u++) sp += ctx.slotCap[u] - loads[u];
      spareAfter.push(sp);
    }
    var carry = 0;

    for (t = fromSlot; t < S; t++) {
      var urgent = new Set(), eligible = [];
      for (p = 0; p < n; p++) {
        if (remaining[p] <= 0) continue;
        if (t > l[p]) return null;
        if (f[p] > t) { if (remaining[p] > maxPlays(l[p] - f[p] + 1, 0)) return null; continue; }
        if (remaining[p] > maxPlays(l[p] - t + 1, run[p])) return null;
        if (remaining[p] > maxPlays(l[p] - t, 0)) urgent.add(p);       // 이번에 쉬면 남은 경기를 못 채움
        if (run[p] < 2) eligible.push(p);
      }
      var want, kmin;
      if (flexible) {
        want = Math.min(ctx.slotCap[t], loads[t] + carry, Math.floor(eligible.length / 4));
        kmin = Math.ceil(urgent.size / 4);
      } else {
        want = kmin = loads[t];
        if (urgent.size > 4 * want || eligible.length < 4 * want) return null;
      }
      if (kmin > want) return null;

      // 직전에 쉰 사람(과 이번에 꼭 뛰어야 하는 사람)만으로 먼저 채워 보고, 안 되면 직전에 뛴 사람도 넣는다 (2연속 최소, plan 2.4)
      var rested = eligible.filter(function (x) { return run[x] === 0 || urgent.has(x); });
      var slotMatches = null;
      for (var k = want; k >= kmin && !slotMatches; k--) {
        if (k === 0) { slotMatches = []; break; }
        var restedFirst = rested.length >= 4 * k && rested.length < eligible.length ? RESTED_ATTEMPTS : 0;
        for (var attempt = 0; attempt < restedFirst + SLOT_ATTEMPTS; attempt++) {
          var keyed = (attempt < restedFirst ? rested : eligible).map(function (x, idx) {
            // 여유 = 이번에 쉬어도 2연속 없이 뛸 수 있는 경기 수 − 남은 경기 (작을수록 먼저). 정수 사이를 난수로 섞는다
            return { p: x, u: urgent.has(x) ? 0 : 1, r: run[x] === 0 ? 0 : 1 + doubles[x],
              v: Math.ceil((l[x] - t) / 2) - remaining[x] + rng() * 0.99, idx: idx };
          });
          keyed.sort(function (A, B) { return (A.u - B.u) || (A.r - B.r) || (A.v - B.v) || (A.idx - B.idx); });
          var order = keyed.map(function (o) { return o.p; });
          var used = new Set();
          var ms = [];
          for (var mi = 0; mi < k; mi++) {
            var pool = order.filter(function (x) { return !used.has(x); });
            if (!pool.length) break;
            var m = findMatch(pool[0], pool.slice(1), sc, gd, partners, rng);
            if (!m) break;
            ms.push(m);
            m.t1.concat(m.t2).forEach(function (x) { used.add(x); });
          }
          var allUrgent = true;
          urgent.forEach(function (x) { if (!used.has(x)) allUrgent = false; });
          if (ms.length === k && allUrgent) { slotMatches = ms; break; }
        }
      }
      if (!slotMatches) return null;
      if (flexible) {
        carry = loads[t] + carry - slotMatches.length;
        if (carry > spareAfter[t]) return null;
      }

      var playing = {};
      slotMatches.forEach(function (m, ci) {
        schedule.push({ slot: t, court: ci + 1, t1: m.t1, t2: m.t2, type: m.type });
        partners.add(pairKey(m.t1[0], m.t1[1]));
        partners.add(pairKey(m.t2[0], m.t2[1]));
        m.t1.concat(m.t2).forEach(function (x) { playing[x] = true; });
      });
      for (p = 0; p < n; p++) {
        if (playing[p]) { remaining[p] -= 1; if (run[p] >= 1) doubles[p] += 1; run[p] += 1; } else run[p] = 0;
      }
      actual.push(slotMatches.length);
    }
    for (p = 0; p < n; p++) if (remaining[p]) return null;
    // ⓗ 2연속 공평: 사람 간 차이 ≤ 1. relax(② 단계, 2.2.0)면 버리지 않고 차이를 돌려준다
    var gap = Math.max.apply(null, doubles) - Math.min.apply(null, doubles);
    if (gap > 1 && !relax) return null;
    return { schedule: schedule, loads: actual, doubles: doubles, gap: gap };
  }

  function repeatOpponentPairs(schedule) {
    var cnt = new Map();
    schedule.forEach(function (m) {
      m.t1.forEach(function (a) {
        m.t2.forEach(function (b) {
          var key = pairKey(a, b);
          cnt.set(key, (cnt.get(key) || 0) + 1);
        });
      });
    });
    var c = 0;
    cnt.forEach(function (v) { if (v >= 2) c++; });
    return c;
  }

  // 해 비교 (6.5 우선순위 → 6.7): 부하 목록이 앞에서부터 큰 것 → 2연속 총 횟수가 적은 것 → 같은 상대 반복 쌍이 적은 것
  function better(a, b) {
    for (var i = 0; i < a.loads.length; i++) if (a.loads[i] !== b.loads[i]) return a.loads[i] > b.loads[i];
    if (a.totalDoubles !== b.totalDoubles) return a.totalDoubles < b.totalDoubles;
    return a.repeatOpp < b.repeatOpp;
  }

  // ② 단계의 해 비교 (6.5 개정 11 우선순위, plan_w7b 2.3): 2연속 차이가 작은 것 → 그다음은 better
  function betterRelaxed(a, b) {
    if (a.gap !== b.gap) return a.gap < b.gap;
    return better(a, b);
  }

  /*
   * ② 단계 (plan_w7b 2.1–2.3): ①이 한 M에서 하나도 못 찾았을 때 M을 줄이기 전에 같은 M에서 ⓗ를 완화해 찾는다.
   * ①의 rng·levelTries·totalTries·draw는 건드리지 않는다 → ②가 못 찾으면 그 뒤는 2.1.0과 같다.
   * build(target, flexible, rng): 한 번 시도 (relax로 부름), redraw(draw): 그 M의 몫 배정, makeCand(s, quota): 해 기록
   */
  function createRelaxStage(seed, M, quota0, build, redraw, makeCand) {
    var st = { tries: 0, k: 0, found: 0, best: null, quota: quota0,
      rng: makeRng((seed ^ RELAX_SALT ^ Math.imul(M, 0x9E3779B1)) >>> 0) };
    // 돌려주는 값: 이번 호출에서 쓴 시도 수. st.done이면 끝
    st.run = function (until, budgetLeft) {
      var used = 0;
      while (!st.done && Date.now() < until) {
        if (used >= budgetLeft) { st.done = true; break; }
        if (!st.found && st.tries > 0 && st.tries % QUOTA_REDRAW === 0) {
          st.k += 1;
          var qd = redraw(RELAX_DRAW_BASE + st.k);
          if (qd.ok) st.quota = qd;
        }
        st.tries += 1; used += 1;
        var flexible = st.tries > STRICT_TRIES;
        var s = build(st.quota.target, flexible, st.rng);
        if (s) {
          st.found += 1;
          var cand = makeCand(s, st.quota, flexible);
          if (st.best === null || betterRelaxed(cand, st.best)) st.best = cand;
          if (st.found >= SOLUTIONS_TO_COMPARE) st.done = true;
        }
        if (st.tries >= RELAX_TRIES_PER_M) st.done = true;
      }
      return used;
    };
    return st;
  }

  /*
   * 대진 탐색. 화면이 멈추지 않도록 step(밀리초)을 여러 번 불러 조금씩 진행한다 (나눠 실행해도 결과는 같다).
   * roster: sortRoster로 정렬한 [{name, gender, grade, arrival, leave}]
   * settings: {start, end, minutes, courts, maxGames}
   * opts(W7, plan 2.8): {fixed: {matches, fromSlot}} — 2.0.0의 화면은 넘기지 않는다
   */
  function createSearch(roster, settings, seed, opts) {
    opts = opts || {};
    var pl = plan(roster, settings, seed);
    var iv = pl.iv;
    var gd = roster.map(function (p) { return p.gender; });
    var ctx = {
      n: roster.length, S: iv.S,
      f: iv.people.map(function (p) { return p.f; }), l: iv.people.map(function (p) { return p.l; }),
      sc: roster.map(function (p) { return GRADE_SCORE[p.grade]; }), gd: gd,
      slotCap: pl.ub.caps.slotCap, fixed: opts.fixed || null
    };
    var rng = makeRng(seed);
    var reductions = pl.parityDrops.map(function (M) { return { from: M, to: M - 1, reason: "parity" }; });
    var state = {
      M: pl.M, quota: pl.quota, loads: pl.loads, levelTries: 0, totalTries: 0, drops: 0, draw: 0,
      found: 0, best: null, done: pl.M <= 0, failReason: pl.M <= 0 ? pl.reason : null, tried: pl.M > 0 ? [pl.M] : [],
      relax: null, relaxTotal: 0, relaxTried: []     // ② 단계 (2.2.0)
    };

    // ①이 이 M에서 못 찾음 → ② (then: "next" = 못 찾으면 M을 줄임, "stop" = 전체 한도라 끝)
    function enterRelax(then) {
      var M = state.M;
      state.relaxTried.push(M);
      state.relax = createRelaxStage(seed, M, quotas(iv, gd, M, seed, 0),
        function (target, flexible, r) { return tryBuild(ctx, target, state.loads, flexible, r, true); },
        function (draw) { return quotas(iv, gd, M, seed, draw); },
        function (s, quota, flexible) {
          return { M: M, matches: s.schedule, loads: s.loads, doubles: s.doubles, gap: s.gap,
            totalDoubles: s.doubles.reduce(function (a, b) { return a + b; }, 0),
            repeatOpp: repeatOpponentPairs(s.schedule), quota: quota, strict: !flexible, phase: "relax" };
        });
      state.relax.then = then;
    }

    function stepRelax(until) {
      var rx = state.relax;
      state.relaxTotal += rx.run(until, MAX_RELAX_TRIES - state.relaxTotal);
      if (!rx.done) return;
      state.relax = null;
      if (rx.best) { state.best = rx.best; state.found = rx.found; state.done = true; return; }
      if (rx.then === "next") nextLevel();
      else { state.done = true; state.failReason = "search"; }
    }

    function nextLevel() {
      state.drops += 1;
      if (state.drops > MAX_SEARCH_DROPS || state.totalTries >= MAX_TOTAL_TRIES) { state.done = true; state.failReason = "search"; return; }
      var M = state.M - 1;
      reductions.push({ from: state.M, to: M, reason: "search" });
      while (M > 0) {
        var qt = quotas(iv, gd, M, seed);
        if (qt.ok) break;
        reductions.push({ from: M, to: M - 1, reason: "parity" });
        M -= 1;
      }
      if (M <= 0) { state.done = true; state.failReason = "search"; return; }
      state.M = M;
      state.quota = quotas(iv, gd, M, seed);
      state.loads = lexLoads(pl.ub, iv.S, M);
      state.levelTries = 0;
      state.draw = 0;
      state.tried.push(M);
    }

    function step(budgetMs) {
      var until = Date.now() + budgetMs;
      while (!state.done && Date.now() < until) {
        if (state.relax) { stepRelax(until); continue; }
        // 아직 하나도 못 찾았으면 몫 동점(누가 ⌈q⌉를 받는지)을 다시 뽑아 다른 배정으로 시도한다
        if (!state.found && state.levelTries > 0 && state.levelTries % QUOTA_REDRAW === 0) {
          state.draw += 1;
          var qd = quotas(iv, gd, state.M, seed, state.draw);
          if (qd.ok) state.quota = qd;
        }
        state.levelTries += 1;
        state.totalTries += 1;
        var flexible = state.levelTries > STRICT_TRIES;
        var s = tryBuild(ctx, state.quota.target, state.loads, flexible, rng);
        if (s) {
          state.found += 1;
          var cand = {
            M: state.M, matches: s.schedule, loads: s.loads, doubles: s.doubles, gap: s.gap,
            totalDoubles: s.doubles.reduce(function (a, b) { return a + b; }, 0) / 1,
            repeatOpp: repeatOpponentPairs(s.schedule), quota: state.quota, strict: !flexible, phase: "strict"
          };
          if (state.best === null || better(cand, state.best)) state.best = cand;
          if (state.found >= SOLUTIONS_TO_COMPARE) { state.done = true; break; }
        }
        if (state.levelTries >= TRIES_PER_M) {
          if (state.found > 0) state.done = true;
          else enterRelax("next");          // 2.1.0은 여기서 바로 nextLevel()
        } else if (state.totalTries >= MAX_TOTAL_TRIES) {
          if (state.found > 0) state.done = true;
          else enterRelax("stop");          // 2.1.0은 여기서 실패
        }
      }
      return { done: state.done, tries: state.totalTries + state.relaxTotal, found: state.found + (state.relax ? state.relax.found : 0),
        maxTries: MAX_TOTAL_TRIES + MAX_RELAX_TRIES, M: state.M, relaxing: !!state.relax };
    }

    function result() {
      var b = state.best;
      return {
        ok: b !== null,
        matches: b ? b.matches : [],
        M: b ? b.M : 0,
        loads: b ? b.loads : [],
        doubles: b ? b.doubles : [],
        totalDoubles: b ? b.totalDoubles : 0,
        gap: b ? b.gap : 0,                                        // 2연속 차이 (2.2.0)
        phase: b ? b.phase : null,                                 // "strict" = ① / "relax" = ②
        relaxed: !!(b && b.phase === "relax" && b.gap > 1),        // ⓗ를 완화한 대진 (차이 2 이상)
        relaxTries: state.relaxTotal,
        relaxTried: state.relaxTried,
        repeatOpp: b ? b.repeatOpp : null,
        q: (b ? b.quota : pl.quota || {}).q || [],
        target: (b ? b.quota : pl.quota || {}).target || [],
        plannedLoads: state.loads,
        upper: pl.ub.M,
        ub: { full: pl.ub.full, bySlot: pl.ub.bySlot, byWindow: pl.ub.byWindow, byH: pl.ub.byH },
        reductions: reductions,
        tried: state.tried,
        failReason: b ? null : state.failReason,
        found: state.found,
        tries: state.totalTries,
        iv: iv,
        S: iv.S,
        seed: seed,
        version: SCHEDULER_VERSION
      };
    }

    return { step: step, result: result };
  }

  // ════════════════════════════════════════════════════════════
  // 진행 중 재편성 (CLAUDE.md 6.8, plan_w7.md 2.4–2.6). 위의 2.0.0 함수는 바꾸지 않고 여기서 따로 한다.
  // ════════════════════════════════════════════════════════════

  /*
   * 6.8.2 변동을 바탕 명단에 적용한다.
   * base: {roster: [{name, gender, grade, arrival, leave}], rows: [{slot, court, type, t1: [이름, 이름], t2: [이름, 이름]}]}
   * changes: [{kind: "absent"|"arrival"|"leave"|"new", name, arrival, leave, gender, grade}]
   * 돌려주는 값: {roster(정렬), changeOf: {이름: 변동}, errors: [글], played0: {이름: 고정 경기 수}}
   */
  function restRoster(base, settings, T, changes) {
    var sl = slots(settings), d = sl.minutes;
    var tNext = fmtHM(sl.start + (T + 1) * d);          // t_(T+1) = 지금 경기가 끝나는 시각
    var played0 = {};
    base.roster.forEach(function (p) { played0[p.name] = 0; });
    base.rows.forEach(function (r) { if (r.slot <= T) r.t1.concat(r.t2).forEach(function (x) { played0[x] = (played0[x] || 0) + 1; }); });
    var byName = {}, errors = [], changeOf = {};
    base.roster.forEach(function (p) { byName[p.name] = { name: p.name, gender: p.gender, grade: p.grade, arrival: p.arrival || "", leave: p.leave || "" }; });
    var startOf = function (v) { var x = parseHM(v); return x === null ? null : x; };
    (changes || []).forEach(function (c) {
      var p = byName[c.name];
      if (c.kind === "new") {
        if (!c.name || p) { errors.push((c.name || "(이름 없음)") + ": 새로 온 사람의 이름이 비었거나 명단에 이미 있습니다"); return; }
        if (["남", "여"].indexOf(c.gender) < 0 || !(c.grade in GRADE_SCORE)) { errors.push(c.name + ": 성별·급수를 골라 주세요"); return; }
        var a = c.arrival || tNext;
        if (startOf(a) === null || startOf(a) < startOf(tNext)) { errors.push(c.name + ": 새로 온 사람의 참가 시각은 " + tNext + " 이후여야 합니다"); return; }
        byName[c.name] = { name: c.name, gender: c.gender, grade: c.grade, arrival: a, leave: c.leave || "" };
        changeOf[c.name] = "new";
        return;
      }
      if (!p) { errors.push(c.name + ": 명단에 없는 사람입니다"); return; }
      if (c.kind === "absent") {
        if (played0[c.name] > 0) { p.leave = tNext; changeOf[c.name] = "absent-played"; }   // T 끝에 일찍 감으로 처리
        else { delete byName[c.name]; changeOf[c.name] = "absent"; }
      } else if (c.kind === "arrival") {
        if (played0[c.name] > 0) { errors.push(c.name + ": 지난 경기가 있는 사람은 참가 시각을 바꿀 수 없습니다"); return; }
        if (startOf(c.arrival) === null || startOf(c.arrival) < startOf(tNext)) { errors.push(c.name + ": 참가 시각은 " + tNext + " 이후로 골라 주세요"); return; }
        p.arrival = c.arrival; changeOf[c.name] = "arrival";
      } else if (c.kind === "leave") {
        if (startOf(c.leave) === null || startOf(c.leave) < startOf(tNext)) { errors.push(c.name + ": 퇴장 시각은 " + tNext + " 이후로 골라 주세요"); return; }
        p.leave = c.leave; changeOf[c.name] = "leave";
      }
    });
    var roster = sortRoster(Object.keys(byName).map(function (k) { return byName[k]; }));
    return { roster: roster, changeOf: changeOf, errors: errors, played0: played0 };
  }

  /*
   * 바뀐 명단에서 사람마다 g0(고정 경기 수), run(T에서 끝나는 연속 출전 수), m′, H′ (plan 2.4).
   * fixed: 바탕의 0…T 경기를 새 명단 번호로 옮긴 것 [{slot, court, type, t1: [번호], t2: [번호]}]
   */
  function restPeople(iv, fixed, T, maxGames) {
    var n = iv.people.length;
    var on = [];
    for (var t = 0; t <= T; t++) on.push(new Array(n).fill(false));
    fixed.forEach(function (m) { m.t1.concat(m.t2).forEach(function (x) { on[m.slot][x] = true; }); });
    return iv.people.map(function (p, i) {
      var g0 = 0, run = 0;
      for (t = 0; t <= T; t++) { if (on[t][i]) { g0++; run++; } else run = 0; }
      var fr = Math.max(p.f, T + 1);
      var mr = Math.max(0, p.l - fr + 1);
      var H = maxPlays(mr, fr === T + 1 ? run : 0);
      if (maxGames) H = Math.min(H, maxGames - g0);
      return { index: i, f: p.f, l: p.l, m: p.m, g0: g0, run: fr === T + 1 ? run : 0, runAtT: run, mRest: mr, H: Math.max(0, H) };
    });
  }

  /*
   * 6.8.3 M′ 상한 (plan 2.4): 2.0.0 동적 계획에 고정 시간대 경기 수를 묶어서 계산한다(3칸 창 ②가 저절로 들어감).
   * T+1 시간대는 T−1·T에 모두 뛴 사람을 빼고 상한을 다시 잡는다(①), ⌊ΣH′/4⌋(③)
   */
  function restBound(iv, rp, courts, fixedLoads, T) {
    var S = iv.S;
    var caps = loadCaps(iv, courts);
    var slotCap = caps.slotCap.slice();
    for (var t = 0; t <= T; t++) slotCap[t] = fixedLoads[t];
    var note = null;
    if (T + 1 < S) {
      var present = iv.A[T + 1];
      var rested = rp.filter(function (p) { return p.runAtT >= 2 && p.f <= T + 1 && T + 1 <= p.l; }).length;
      slotCap[T + 1] = Math.min(courts, Math.floor((present - rested) / 4));
      var before = Math.min(courts, Math.floor(present / 4));
      if (slotCap[T + 1] < before) note = { slot: T + 1, games: slotCap[T + 1], rested: rested };   // 미리보기·결과 설명 (Q7)
    }
    var c2 = { slotCap: slotCap, win: caps.win, courts: courts };
    var tbl = S > 0 ? suffixTable(c2, S, fixedLoads) : null;
    var fixedSum = fixedLoads.reduce(function (s, v) { return s + v; }, 0);
    var total = tbl ? tbl[0][0][0] : -Infinity;
    var byWindow = total === -Infinity ? 0 : Math.max(0, total - fixedSum);
    var bySlot = 0;
    for (t = T + 1; t < S; t++) bySlot += slotCap[t];
    var byH = Math.floor(rp.reduce(function (s, p) { return s + p.H; }, 0) / 4);
    return { M: Math.min(byWindow, byH), bySlot: bySlot, byWindow: byWindow, byH: byH, full: courts * (S - T - 1),
      caps: c2, table: tbl, fixedSum: fixedSum, byWindowTotal: fixedSum + byWindow, note: note };
  }

  // 남은 시간대의 사전순 최대 부하 목록 (하루 전체 길이, 고정 시간대는 바탕 값)
  function restLoads(rb, S, Mrest, fixedLoads) {
    return lexLoads({ caps: rb.caps, table: rb.table, byWindow: rb.byWindowTotal }, S, rb.fixedSum + Mrest, fixedLoads);
  }

  // 분수 비교 도우미 (분자/분모, 분모 > 0)
  function fracCmp(a, b) { return a.n * b.d - b.n * a.d; }

  /*
   * 6.8.4 남은 몫 (plan 2.5): ρₚ = clamp(λmₚ − g0ₚ, 0, H′ₚ), Σρ = 4M′. λ는 꺾이는 점 따라가기로 정확한 분수.
   * 정수 배정은 2.0.0 quotas와 같은 순서(⌊ρ⌋ → 소수점 큰 순, 같으면 대진 번호 난수 → 성별 짝수 1쌍 바꿈).
   * 고정이 없으면(g0 = 0, H′ = H) 2.0.0 quotas와 같은 결과 (회귀 확인용으로 그 경우에도 부를 수 있게 둠)
   * rp: [{m, g0, H}], gd: 성별 배열
   */
  function restQuotas(rp, gd, M, seed, draw) {
    var n = rp.length, target4 = 4 * M, i;
    var act = [];
    for (i = 0; i < n; i++) if (rp[i].H > 0 && rp[i].m > 0) act.push(i);
    var capSum = act.reduce(function (s, k) { return s + rp[k].H; }, 0);
    if (target4 > capSum) return { ok: false, reason: "cap" };
    // F(λ) at λ = p/q → 분자 (분모 q)
    function Fnum(l) {
      var s = 0;
      act.forEach(function (k) { var v = l.n * rp[k].m - rp[k].g0 * l.d; s += Math.max(0, Math.min(v, rp[k].H * l.d)); });
      return s;
    }
    var pts = [{ n: 0, d: 1 }];
    act.forEach(function (k) { pts.push({ n: rp[k].g0, d: rp[k].m }); pts.push({ n: rp[k].g0 + rp[k].H, d: rp[k].m }); });
    pts.sort(fracCmp);
    var lam = null, prev = null;
    for (i = 0; i < pts.length; i++) {
      var pt = pts[i];
      var fv = Fnum(pt);                                   // F(pt) × pt.d
      if (fv >= target4 * pt.d) {
        if (fv === target4 * pt.d || prev === null) { lam = pt; break; }
        // prev와 pt 사이: 가운데 묶음 B (aₚ ≤ prev, bₚ ≥ pt) 로 정확히 푼다
        var hiSum = 0, gB = 0, mB = 0;
        act.forEach(function (k) {
          var a = { n: rp[k].g0, d: rp[k].m }, b = { n: rp[k].g0 + rp[k].H, d: rp[k].m };
          if (fracCmp(b, prev) <= 0) hiSum += rp[k].H;
          else if (fracCmp(a, prev) <= 0 && fracCmp(b, pt) >= 0) { gB += rp[k].g0; mB += rp[k].m; }
        });
        lam = { n: target4 - hiSum + gB, d: mB };
        break;
      }
      prev = pt;
    }
    if (!lam || lam.d <= 0) return { ok: false, reason: "cap" };
    var den = lam.d;
    var num = new Array(n).fill(0);
    act.forEach(function (k) { num[k] = Math.max(0, Math.min(lam.n * rp[k].m - rp[k].g0 * den, rp[k].H * den)); });
    var rho = num.map(function (v) { return v / den; });
    var target = num.map(function (v) { return Math.floor(v / den); });
    var frac = num.map(function (v) { return v % den; });
    var rest = target4 - target.reduce(function (s, v) { return s + v; }, 0);
    // 아래는 2.0.0 quotas와 같은 순서·같은 난수 식 (회귀: 고정이 없으면 같은 배정)
    var rng = makeRng((seed ^ QUOTA_SALT ^ Math.imul(M, 0x9E3779B1) ^ Math.imul(draw || 0, 0x27D4EB2F)) >>> 0);
    var rank = shuffle(Array.from({ length: n }, function (_, k) { return k; }), rng);
    var rk = new Array(n);
    rank.forEach(function (p, r) { rk[p] = r; });
    var cand = [];
    for (var c = 0; c < n; c++) if (frac[c] > 0) cand.push(c);
    cand.sort(function (a, b) { return (frac[b] - frac[a]) || (rk[a] - rk[b]); });
    if (rest > cand.length) return { ok: false, reason: "cap" };
    var got = new Array(n).fill(false);
    cand.slice(0, rest).forEach(function (p) { got[p] = true; target[p] += 1; });
    var men = 0;
    for (c = 0; c < n; c++) if (gd[c] === "남") men += target[c];
    var swapped = null;
    if (men % 2 !== 0) {
      var opts = [];
      ["남", "여"].forEach(function (g) {
        var giver = null, taker = null;
        for (var k = cand.length - 1; k >= 0; k--) { var p = cand[k]; if (got[p] && gd[p] === g) { giver = p; break; } }
        for (k = 0; k < cand.length; k++) { var w = cand[k]; if (!got[w] && gd[w] !== g) { taker = w; break; } }
        if (giver !== null && taker !== null) opts.push({ giver: giver, taker: taker, loss: frac[giver] - frac[taker] });
      });
      if (!opts.length) return { ok: false, reason: "parity", q: rho, target: target, lambda: lam };
      var minLoss = Math.min.apply(null, opts.map(function (o) { return o.loss; }));
      opts = opts.filter(function (o) { return o.loss === minLoss; });
      var pick = opts.length === 1 ? opts[0] : opts[Math.floor(rng() * opts.length)];
      target[pick.giver] -= 1; target[pick.taker] += 1;
      swapped = pick;
    }
    return { ok: true, q: rho, target: target, swapped: swapped, lambda: lam, num: num, den: den };
  }

  /*
   * 재편성 계산(탐색 전). 미리보기와 탐색 시작점.
   * base: {roster, rows}, T: 기준 시간대, changes: 6.8.2 변동
   * 돌려주는 값: {ok, errors, reason, roster, changeOf, iv, fixed, fixedLoads, rp, rb, M, loads, quota, parityDrops}
   */
  function restPlan(base, settings, T, changes, seed) {
    var out = { ok: false, errors: [], reason: null, M: 0, loads: null, quota: null, parityDrops: [] };
    var S = slots(settings).S;
    if (T < 0) { out.reason = "before"; return out; }
    if (T >= S - 1) { out.reason = "last"; return out; }
    var rr = restRoster(base, settings, T, changes);
    out.roster = rr.roster; out.changeOf = rr.changeOf; out.errors = rr.errors;
    if (rr.errors.length) { out.reason = "input"; return out; }
    var idx = {};
    rr.roster.forEach(function (p, i) { idx[p.name] = i; });
    var fixed = [], fixedLoads = [];
    for (var t = 0; t <= T; t++) fixedLoads.push(0);
    base.rows.forEach(function (r) {
      if (r.slot > T) return;
      fixed.push({ slot: r.slot, court: r.court, type: r.type, t1: r.t1.map(function (x) { return idx[x]; }), t2: r.t2.map(function (x) { return idx[x]; }) });
      fixedLoads[r.slot] += 1;
    });
    var iv = intervals(rr.roster, settings);
    out.iv = iv; out.fixed = fixed; out.fixedLoads = fixedLoads;
    if (iv.bad.length && iv.bad.some(function (p) { return !(rr.changeOf[rr.roster[p.index].name] === "absent-played"); })) {
      out.errors = iv.bad.map(function (p) { return rr.roster[p.index].name + ": 경기할 시간대가 없습니다"; });
      out.reason = "input"; return out;
    }
    var rp = restPeople(iv, fixed, T, settings.maxGames);
    out.rp = rp;
    var rb = restBound(iv, rp, settings.courts, fixedLoads, T);
    out.rb = rb;
    var gd = rr.roster.map(function (p) { return p.gender; });
    var M = rb.M;
    while (M > 0) {
      var qt = restQuotas(rp, gd, M, seed);
      if (qt.ok) {
        out.M = M; out.quota = qt; out.loads = restLoads(rb, S, M, fixedLoads); out.ok = true;
        return out;
      }
      out.parityDrops.push(M);
      M -= 1;
    }
    out.reason = out.parityDrops.length ? "parity" : "empty";
    return out;
  }

  /*
   * 재편성 한 번 시도 (2.0.0 tryBuild를 바탕으로 따로 둔 것, plan 1.3·2.6).
   * 고정 경기로 파트너 기록·직전 연속·하루 2연속을 채우고 T+1부터 만든다. 목표는 남은 배정 rₚ.
   * 2연속은 "남은 2연속"(T·T+1 쌍부터)을 따로 세어 ⓗ′(rₚ ≥ 1인 사람끼리 차이 ≤ 1, Q9)로 판정한다.
   */
  function tryBuildRest(ctx, target, loads, flexible, rng, relax) {
    var n = ctx.n, S = ctx.S, f = ctx.f, l = ctx.l, sc = ctx.sc, gd = ctx.gd, T = ctx.T;
    var remaining = target.slice();
    var run = new Array(n).fill(0);
    var doubles = new Array(n).fill(0);      // 하루 전체 (참고)
    var restDbl = new Array(n).fill(0);      // 남은 2연속 (ⓗ′)
    var partners = new Set();
    var schedule = [];
    var actual = [];
    var t, p, u;
    for (t = 0; t <= T; t++) {
      var fm = ctx.fixed.filter(function (m) { return m.slot === t; });
      var on = {};
      fm.forEach(function (m) {
        schedule.push(m);
        partners.add(pairKey(m.t1[0], m.t1[1])); partners.add(pairKey(m.t2[0], m.t2[1]));
        m.t1.concat(m.t2).forEach(function (x) { on[x] = true; });
      });
      for (p = 0; p < n; p++) {
        if (on[p]) { if (run[p] >= 1) doubles[p] += 1; run[p] += 1; } else run[p] = 0;
      }
      actual.push(fm.length);
    }
    var spareAfter = [];
    for (t = 0; t < S; t++) {
      var sp = 0;
      for (u = Math.max(t + 1, T + 1); u < S; u++) sp += ctx.slotCap[u] - loads[u];
      spareAfter.push(sp);
    }
    var carry = 0;

    for (t = T + 1; t < S; t++) {
      var urgent = new Set(), eligible = [];
      for (p = 0; p < n; p++) {
        if (remaining[p] <= 0) continue;
        if (t > l[p]) return null;
        if (f[p] > t) { if (remaining[p] > maxPlays(l[p] - f[p] + 1, 0)) return null; continue; }
        if (remaining[p] > maxPlays(l[p] - t + 1, run[p])) return null;
        if (remaining[p] > maxPlays(l[p] - t, 0)) urgent.add(p);
        if (run[p] < 2) eligible.push(p);
      }
      var want, kmin;
      if (flexible) {
        want = Math.min(ctx.slotCap[t], loads[t] + carry, Math.floor(eligible.length / 4));
        kmin = Math.ceil(urgent.size / 4);
      } else {
        want = kmin = loads[t];
        if (urgent.size > 4 * want || eligible.length < 4 * want) return null;
      }
      if (kmin > want) return null;

      var rested = eligible.filter(function (x) { return run[x] === 0 || urgent.has(x); });
      var slotMatches = null;
      for (var k = want; k >= kmin && !slotMatches; k--) {
        if (k === 0) { slotMatches = []; break; }
        var restedFirst = rested.length >= 4 * k && rested.length < eligible.length ? RESTED_ATTEMPTS : 0;
        for (var attempt = 0; attempt < restedFirst + SLOT_ATTEMPTS; attempt++) {
          var keyed = (attempt < restedFirst ? rested : eligible).map(function (x, idx) {
            return { p: x, u: urgent.has(x) ? 0 : 1, r: run[x] === 0 ? 0 : 1 + restDbl[x],
              v: Math.ceil((l[x] - t) / 2) - remaining[x] + rng() * 0.99, idx: idx };
          });
          keyed.sort(function (A, B) { return (A.u - B.u) || (A.r - B.r) || (A.v - B.v) || (A.idx - B.idx); });
          var order = keyed.map(function (o) { return o.p; });
          var used = new Set();
          var ms = [];
          for (var mi = 0; mi < k; mi++) {
            var pool = order.filter(function (x) { return !used.has(x); });
            if (!pool.length) break;
            var m = findMatch(pool[0], pool.slice(1), sc, gd, partners, rng);
            if (!m) break;
            ms.push(m);
            m.t1.concat(m.t2).forEach(function (x) { used.add(x); });
          }
          var allUrgent = true;
          urgent.forEach(function (x) { if (!used.has(x)) allUrgent = false; });
          if (ms.length === k && allUrgent) { slotMatches = ms; break; }
        }
      }
      if (!slotMatches) return null;
      if (flexible) {
        carry = loads[t] + carry - slotMatches.length;
        if (carry > spareAfter[t]) return null;
      }

      var playing = {};
      slotMatches.forEach(function (m, ci) {
        schedule.push({ slot: t, court: ci + 1, t1: m.t1, t2: m.t2, type: m.type });
        partners.add(pairKey(m.t1[0], m.t1[1]));
        partners.add(pairKey(m.t2[0], m.t2[1]));
        m.t1.concat(m.t2).forEach(function (x) { playing[x] = true; });
      });
      for (p = 0; p < n; p++) {
        if (playing[p]) { remaining[p] -= 1; if (run[p] >= 1) { doubles[p] += 1; restDbl[p] += 1; } run[p] += 1; } else run[p] = 0;
      }
      actual.push(slotMatches.length);
    }
    for (p = 0; p < n; p++) if (remaining[p]) return null;
    // ⓗ′: 남은 배정이 1 이상인 사람끼리 남은 2연속 차이 ≤ 1 (Q9). relax(② 단계, 2.2.0)면 버리지 않고 차이를 돌려준다
    var vals = [];
    for (p = 0; p < n; p++) if (target[p] >= 1) vals.push(restDbl[p]);
    var gap = vals.length ? Math.max.apply(null, vals) - Math.min.apply(null, vals) : 0;
    if (gap > 1 && !relax) return null;
    return { schedule: schedule, loads: actual, doubles: doubles, restDoubles: restDbl, gap: gap };
  }

  /*
   * 재편성 탐색 (plan 2.6). 시도 한도·M′ 줄이기·동점 다시 뽑기는 2.0.0 createSearch와 같은 값.
   * base: {roster, rows(이름)}, settings, T, changes, seed(새 대진 번호)
   */
  function createRestSearch(base, settings, T, changes, seed) {
    var pl = restPlan(base, settings, T, changes, seed);
    var reductions = pl.parityDrops.map(function (M) { return { from: M, to: M - 1, reason: "parity" }; });
    var state = { M: pl.M, quota: pl.quota, loads: pl.loads, levelTries: 0, totalTries: 0, drops: 0, draw: 0,
      found: 0, best: null, done: !pl.ok, failReason: pl.ok ? null : pl.reason, tried: pl.ok ? [pl.M] : [],
      relax: null, relaxTotal: 0, relaxTried: [] };   // ② 단계 (2.2.0)
    var ctx = null, gd = null;
    if (pl.ok) {
      var iv = pl.iv;
      gd = pl.roster.map(function (p) { return p.gender; });
      ctx = { n: pl.roster.length, S: iv.S, T: T,
        f: iv.people.map(function (p) { return p.f; }), l: iv.people.map(function (p) { return p.l; }),
        sc: pl.roster.map(function (p) { return GRADE_SCORE[p.grade]; }), gd: gd,
        slotCap: pl.rb.caps.slotCap, fixed: pl.fixed };
    }
    var rng = makeRng(seed);

    // ①이 이 M′에서 못 찾음 → ② (createSearch와 같은 구조)
    function enterRelax(then) {
      var M = state.M;
      state.relaxTried.push(M);
      state.relax = createRelaxStage(seed, M, restQuotas(pl.rp, gd, M, seed, 0),
        function (target, flexible, r) { return tryBuildRest(ctx, target, state.loads, flexible, r, true); },
        function (draw) { return restQuotas(pl.rp, gd, M, seed, draw); },
        function (s, quota) {
          return { M: M, matches: s.schedule, loads: s.loads, doubles: s.doubles, restDoubles: s.restDoubles, gap: s.gap,
            totalDoubles: s.restDoubles.reduce(function (a, b) { return a + b; }, 0),
            repeatOpp: repeatOpponentPairs(s.schedule), quota: quota, phase: "relax" };
        });
      state.relax.then = then;
    }

    function stepRelax(until) {
      var rx = state.relax;
      state.relaxTotal += rx.run(until, MAX_RELAX_TRIES - state.relaxTotal);
      if (!rx.done) return;
      state.relax = null;
      if (rx.best) { state.best = rx.best; state.found = rx.found; state.done = true; return; }
      if (rx.then === "next") nextLevel();
      else { state.done = true; state.failReason = "search"; }
    }

    function nextLevel() {
      state.drops += 1;
      if (state.drops > MAX_SEARCH_DROPS || state.totalTries >= MAX_TOTAL_TRIES) { state.done = true; state.failReason = "search"; return; }
      var M = state.M - 1;
      reductions.push({ from: state.M, to: M, reason: "search" });
      while (M > 0) {
        if (restQuotas(pl.rp, gd, M, seed).ok) break;
        reductions.push({ from: M, to: M - 1, reason: "parity" });
        M -= 1;
      }
      if (M <= 0) { state.done = true; state.failReason = "search"; return; }
      state.M = M;
      state.quota = restQuotas(pl.rp, gd, M, seed);
      state.loads = restLoads(pl.rb, ctx.S, M, pl.fixedLoads);
      state.levelTries = 0;
      state.draw = 0;
      state.tried.push(M);
    }

    function step(budgetMs) {
      var until = Date.now() + budgetMs;
      while (!state.done && Date.now() < until) {
        if (state.relax) { stepRelax(until); continue; }
        if (!state.found && state.levelTries > 0 && state.levelTries % QUOTA_REDRAW === 0) {
          state.draw += 1;
          var qd = restQuotas(pl.rp, gd, state.M, seed, state.draw);
          if (qd.ok) state.quota = qd;
        }
        state.levelTries += 1;
        state.totalTries += 1;
        var flexible = state.levelTries > STRICT_TRIES;
        var s = tryBuildRest(ctx, state.quota.target, state.loads, flexible, rng);
        if (s) {
          state.found += 1;
          var cand = {
            M: state.M, matches: s.schedule, loads: s.loads, doubles: s.doubles, restDoubles: s.restDoubles, gap: s.gap,
            totalDoubles: s.restDoubles.reduce(function (a, b) { return a + b; }, 0),
            repeatOpp: repeatOpponentPairs(s.schedule), quota: state.quota, phase: "strict"
          };
          if (state.best === null || better(cand, state.best)) state.best = cand;
          if (state.found >= SOLUTIONS_TO_COMPARE) { state.done = true; break; }
        }
        if (state.levelTries >= TRIES_PER_M) {
          if (state.found > 0) state.done = true;
          else enterRelax("next");          // 2.1.0은 여기서 바로 nextLevel()
        } else if (state.totalTries >= MAX_TOTAL_TRIES) {
          if (state.found > 0) state.done = true;
          else enterRelax("stop");          // 2.1.0은 여기서 실패
        }
      }
      return { done: state.done, tries: state.totalTries + state.relaxTotal, found: state.found + (state.relax ? state.relax.found : 0),
        maxTries: MAX_TOTAL_TRIES + MAX_RELAX_TRIES, M: state.M, relaxing: !!state.relax };
    }

    function result() {
      var b = state.best;
      var qt = b ? b.quota : pl.quota;
      var fixedPairs = [];
      (pl.fixed || []).forEach(function (m) { fixedPairs.push(pairKey(m.t1[0], m.t1[1])); fixedPairs.push(pairKey(m.t2[0], m.t2[1])); });
      return {
        ok: b !== null,
        rest: true,
        T: T,
        errors: pl.errors,
        roster: pl.roster || [],
        changeOf: pl.changeOf || {},
        matches: b ? b.matches : [],
        M: b ? b.M : 0,                                 // M′ (남은 경기 수)
        dayM: b ? b.matches.length : 0,
        loads: b ? b.loads : [],
        doubles: b ? b.doubles : [],
        restDoubles: b ? b.restDoubles : [],
        totalDoubles: b ? b.totalDoubles : 0,           // 남은 2연속 총 횟수
        gap: b ? b.gap : 0,                             // 남은 2연속 차이 (ⓗ′, 2.2.0)
        phase: b ? b.phase : null,
        relaxed: !!(b && b.phase === "relax" && b.gap > 1),
        relaxTries: state.relaxTotal,
        relaxTried: state.relaxTried,
        dayDoubles: b ? b.doubles.reduce(function (a, c) { return a + c; }, 0) : 0,
        repeatOpp: b ? b.repeatOpp : null,
        q: qt ? qt.q : [],
        target: qt ? qt.target : [],
        lambda: qt ? qt.lambda : null,
        rp: pl.rp || [],
        plannedLoads: state.loads,
        upper: pl.rb ? pl.rb.M : 0,
        ub: pl.rb ? { full: pl.rb.full, bySlot: pl.rb.bySlot, byWindow: pl.rb.byWindow, byH: pl.rb.byH } : null,
        note: pl.rb ? pl.rb.note : null,
        fixedPairs: fixedPairs,
        reductions: reductions,
        tried: state.tried,
        failReason: b ? null : state.failReason,
        found: state.found,
        tries: state.totalTries,
        iv: pl.iv || null,
        S: slots(settings).S,
        seed: seed,
        version: SCHEDULER_VERSION
      };
    }

    return { step: step, result: result, plan: pl };
  }

  /*
   * 7절 다시 보기 판정 (plan_w7b 3.1): 이 버전의 파일을 같은 번호로 다시 만들면 같은 대진이 나오는가.
   * 2.0.0·2.1.0 파일은 경기 수를 줄이지 않았을 때(총 경기 수 = 상한)만 같다 — 2.2.0은 ①이 못 찾을 때만 달라지므로.
   * M·upper를 못 읽으면(숫자 아님) 같다고 하지 않는다
   */
  function replaySame(version, M, upper) {
    if (version === SCHEDULER_VERSION) return true;
    if (REPLAY_VERSIONS.indexOf(version) < 0) return false;
    var m = parseInt(M, 10), u = parseInt(upper, 10);
    return /^\d+$/.test(String(M)) && /^\d+$/.test(String(upper)) && m === u;
  }

  global.Scheduler = {
    SCHEDULER_VERSION: SCHEDULER_VERSION,
    GRADE_SCORE: GRADE_SCORE,
    MAX_GRADE_DIFF: MAX_GRADE_DIFF,
    SOLUTIONS_TO_COMPARE: SOLUTIONS_TO_COMPARE,
    TRIES_PER_M: TRIES_PER_M,
    MAX_SEARCH_DROPS: MAX_SEARCH_DROPS,
    MAX_TOTAL_TRIES: MAX_TOTAL_TRIES,
    sortRoster: sortRoster,
    parseHM: parseHM,
    fmtHM: fmtHM,
    slotTime: slotTime,
    slots: slots,
    maxPlays: maxPlays,
    intervals: intervals,
    loadCaps: loadCaps,
    upperBound: upperBound,
    lexLoads: lexLoads,
    quotas: quotas,
    needsDoubles: needsDoubles,
    plan: plan,
    createSearch: createSearch,
    // 2.1.0 재편성
    REPLAY_VERSIONS: REPLAY_VERSIONS,
    replaySame: replaySame,
    restRoster: restRoster,
    restPeople: restPeople,
    restBound: restBound,
    restQuotas: restQuotas,
    restPlan: restPlan,
    createRestSearch: createRestSearch
  };
})(this);
