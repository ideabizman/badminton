/*
 * scheduler.js — 대진 생성 규칙만 담는다 (화면 코드와 분리).
 * M9 make_schedule.py(10_실습\M9_badminton)를 JavaScript로 옮긴 것이다. CLAUDE.md 6·7절.
 * file://에서도 동작하도록 ES 모듈이 아닌 일반 스크립트로, 전역 객체 Scheduler 하나만 내보낸다.
 * 무작위 선택은 모두 대진 번호를 씨앗값으로 쓰는 난수 생성기로만 한다 (Math.random 사용 금지).
 */
(function (global) {
  "use strict";

  // 이 파일의 생성 결과가 바뀌면 올린다 (CLAUDE.md 7절).
  // 1.1.0 (CLAUDE.md 개정 3): 6.5 성별 짝수 조건, 5절 상충 안내(성별 짝수·코트 1면 8명) 추가
  // 1.2.0 (CLAUDE.md 개정 7): 6.6 참가자별 참가 시각. 늦게 온 사람이 없으면 1.1.0 함수를 그대로 탄다
  var SCHEDULER_VERSION = "1.2.0";

  var GRADE_SCORE = { A: 4, B: 3, C: 2, D: 1, "초심": 0 };   // 6.1
  var GENDERS = ["남", "여"];
  var PLAYERS_PER_COURT_RULE = 8;      // 권장 코트 수 = 인원 ÷ 8 (내림, 최소 1면)
  var MAX_GRADE_DIFF = 1;
  var MAX_RESTARTS = 20000;            // M9와 같은 값
  var SOLUTIONS_TO_COMPARE = 30;       // 이 개수만큼 해를 찾아 '같은 상대 반복'이 가장 적은 해를 고른다 (6.4)
  var SLOT_ATTEMPTS = 60;              // 한 시간대를 채우는 시도 횟수 (M9와 같은 값)

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

  // Python random.shuffle과 같은 순서(뒤에서부터)의 Fisher–Yates
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

  // ── 규모 계산 ────────────────────────────────────────────
  function recommendedCourts(n) {
    return Math.max(1, Math.floor(n / PLAYERS_PER_COURT_RULE));
  }

  function pad2(v) { return (v < 10 ? "0" : "") + v; }

  // start "HH:MM" + minutes × t → "HH:MM" (자정을 넘으면 0시부터 다시)
  function slotTime(start, minutes, t) {
    var parts = start.split(":");
    var m = (parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + minutes * t) % 1440;
    return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
  }

  // 6.2 + 6.5: 총 경기 수, 나머지 r, 시간대 수, 시간대별 경기 수(고르게)
  function computePlan(n, courts, games) {
    var appearances = n * games;
    var r = appearances % 4;
    var total = (appearances - r) / 4;
    var nSlots = courts > 0 ? Math.ceil(total / courts) : 0;
    var base = nSlots > 0 ? Math.floor(total / nSlots) : 0;
    var extra = nSlots > 0 ? total - base * nSlots : 0;
    return { n: n, courts: courts, games: games, total: total, r: r, nSlots: nSlots, base: base, extra: extra };
  }

  // 5절: 설정이 규칙상 불가능해 보이는 경우를 찾아 이유·바꿀 항목을 돌려준다 (값은 바꾸지 않는다)
  function checkFeasibility(roster, courts, games) {
    var n = roster.length;
    var plan = computePlan(n, courts, games);
    var out = [];
    if (plan.total === 0) {
      out.push({ reason: "만들 경기가 없습니다.", fix: "1인당 경기 수를 늘려 보세요." });
      return out;
    }
    var need = 2 * games - 1;
    if (plan.nSlots < need) {
      out.push({
        reason: "시간대가 " + plan.nSlots + "개뿐이라, 연속 경기 없이 한 사람이 " + games + "경기를 하려면 시간대가 " + need + "개 이상 필요합니다.",
        fix: "코트 수를 줄이거나 1인당 경기 수를 줄여 보세요."
      });
    }
    // 큰 시간대(base+1경기)끼리 붙지 않게 놓을 수 있으면 가장 붐비는 인접 두 시간대는 (base+1)+base 경기
    if (plan.nSlots >= 2) {
      var bigCanSeparate = plan.extra <= Math.ceil(plan.nSlots / 2);
      var pairGames;
      if (plan.extra === 0) pairGames = 2 * plan.base;
      else if (bigCanSeparate) pairGames = 2 * plan.base + 1;
      else pairGames = 2 * plan.base + 2;
      if (pairGames * 4 > n) {
        out.push({
          reason: "이어지는 두 시간대에 " + (pairGames * 4) + "명이 경기해야 하는데 전체가 " + n + "명이라, 쉬지 않고 연달아 뛰는 사람이 생깁니다.",
          fix: "코트 수를 줄여 보세요 (권장 " + recommendedCourts(n) + "면)."
        });
      }
    }
    // 5절: 성별마다 출전 횟수 합이 홀수 (6.5의 성별 나눔으로도 짝수로 만들 수 없을 때)
    var men = roster.filter(function (p) { return p.gender === "남"; }).length;
    var women = n - men;
    if (fewerSplits(men, women, games, plan.r).length === 0) {
      out.push({
        reason: "남자 출전 횟수 합(" + men + "명 × " + games + "경기)이나 여자 출전 횟수 합(" + women + "명 × " + games + "경기)이 홀수가 되어 짝을 맞출 수 없습니다. 한 경기에 남자·여자는 0·2·4명씩 들어가기 때문입니다.",
        fix: "1인당 경기 수를 바꿔 보세요."
      });
    }
    // 5절: 코트 1면에 8명이면 연속 경기 금지 때문에 같은 4명끼리 번갈아 경기하게 되어 4경기부터는 파트너가 반드시 겹친다
    if (courts === 1 && n === 8 && games >= 4) {
      out.push({
        reason: "코트 1면에 8명이면 같은 4명끼리 번갈아 경기하게 됩니다. 4명이 만들 수 있는 파트너 조합은 3가지뿐이라 " + games + "경기를 하면 같은 파트너가 반드시 다시 나옵니다.",
        fix: "1인당 경기 수를 3 이하로 줄이거나 인원을 늘려 보세요."
      });
    }
    GENDERS.forEach(function (g) {
      var cnt = roster.filter(function (p) { return p.gender === g; }).length;
      if (cnt === 1) {
        out.push({
          reason: (g === "남" ? "남자" : "여자") + "가 1명뿐입니다. 혼복끼리 붙으려면 " + (g === "남" ? "남자" : "여자") + "가 2명 이상 필요해서 이 사람은 경기할 수 없습니다.",
          fix: "명단을 확인해 보세요."
        });
      }
    });
    return out;
  }

  // ── 대진 생성 (make_schedule.py try_build / find_match 이식) ──────
  function pairKey(a, b) { return a < b ? a + "," + b : b + "," + a; }

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

  function tryBuild(sc, gd, target, plan, rng) {
    var n = sc.length;
    var nSlots = plan.nSlots;
    var ks = [], t, p;
    for (t = 0; t < plan.extra; t++) ks.push(plan.base + 1);         // 6.4: 시간대별 경기 수를 고르게
    for (t = plan.extra; t < nSlots; t++) ks.push(plan.base);
    shuffle(ks, rng);

    var remaining = target.slice();
    var last = [];
    for (p = 0; p < n; p++) last.push(-99);
    var partners = new Set();
    var schedule = [];

    for (t = 0; t < nSlots; t++) {
      var k = ks[t];
      var left = nSlots - t;
      // 남은 시간대로 남은 경기를 연속 없이 채울 수 없으면 실패
      for (p = 0; p < n; p++) {
        var cap = last[p] === t - 1 ? Math.ceil((left - 1) / 2) : Math.ceil(left / 2);
        if (remaining[p] > cap) return null;
      }
      var eligible = [];
      for (p = 0; p < n; p++) if (remaining[p] > 0 && last[p] !== t - 1) eligible.push(p);
      var urgent = new Set();                                     // 이번에 안 뛰면 못 채우는 사람
      eligible.forEach(function (x) { if (remaining[x] > Math.ceil((left - 1) / 2)) urgent.add(x); });
      if (urgent.size > 4 * k || eligible.length < 4 * k) return null;

      var slotMatches = null;
      for (var attempt = 0; attempt < SLOT_ATTEMPTS; attempt++) {
        // Python의 sorted(key=...)처럼 목록 순서대로 난수를 뽑아 키를 만든 뒤 안정 정렬
        var keyed = eligible.map(function (x, idx) {
          return { p: x, u: urgent.has(x) ? 0 : 1, v: -remaining[x] + rng() * 1.5, idx: idx };
        });
        keyed.sort(function (A, B) { return (A.u - B.u) || (A.v - B.v) || (A.idx - B.idx); });
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
      if (!slotMatches) return null;

      slotMatches.forEach(function (m, ci) {
        schedule.push({ slot: t, court: ci + 1, t1: m.t1, t2: m.t2, type: m.type });
        partners.add(pairKey(m.t1[0], m.t1[1]));
        partners.add(pairKey(m.t2[0], m.t2[1]));
        m.t1.concat(m.t2).forEach(function (x) { remaining[x] -= 1; last[x] = t; });
      });
    }
    for (p = 0; p < n; p++) if (remaining[p]) return null;
    return schedule;
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

  /*
   * 6.5 성별 짝수 조건: 1경기 적게 배정할 r명 중 남자 수(fm)로 가능한 값 목록.
   * 남자 출전 합 men × games − fm, 여자 출전 합 women × games − (r − fm)이 모두 짝수여야 한다.
   */
  function fewerSplits(men, women, games, r) {
    var out = [];
    for (var fm = 0; fm <= r; fm++) {
      var fw = r - fm;
      if (fm > men || fw > women) continue;
      if ((men * games - fm) % 2 === 0 && (women * games - fw) % 2 === 0) out.push(fm);
    }
    return out;
  }

  // 앞에서부터 k개를 난수로 고른다 (Fisher–Yates 부분 섞기)
  function pickSome(list, k, rng) {
    var a = list.slice();
    for (var i = 0; i < k; i++) {
      var j = i + Math.floor(rng() * (a.length - i));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a.slice(0, k);
  }

  /*
   * 6.5: 1경기 적게 배정할 r명 (개정 3).
   * 성별 나눔(남 fm명·여 r−fm명)은 짝수 조건으로 계산해 정하고, 가능한 나눔이 여럿이면 그중 하나를 난수로,
   * 각 성별 안에서 누구인지는 난수로 고른다. 대진 생성과 다른 난수 줄기를 써서 r = 0일 때 생성 결과에 영향을 주지 않는다.
   * 가능한 나눔이 없으면 ok: false (어떤 대진도 불가능).
   */
  function pickFewer(gd, r, games, seed) {
    if (r === 0) return { ok: true, fewer: [] };
    var men = [], women = [];
    gd.forEach(function (g, i) { (g === "남" ? men : women).push(i); });
    var splits = fewerSplits(men.length, women.length, games, r);
    if (!splits.length) return { ok: false, fewer: [] };
    var rng = makeRng((seed ^ 0x9E3779B9) >>> 0);
    var fm = splits.length === 1 ? splits[0] : splits[Math.floor(rng() * splits.length)];
    var chosen = pickSome(men, fm, rng).concat(pickSome(women, r - fm, rng));
    return { ok: true, fewer: chosen.sort(function (a, b) { return a - b; }) };
  }

  /*
   * 대진 탐색을 만든다. 화면이 멈추지 않도록 step(밀리초)을 여러 번 불러 조금씩 진행한다.
   * 나눠 실행해도 난수 순서는 같으므로 결과는 같다.
   * roster: sortRoster로 정렬한 [{name, gender, grade}]
   */
  function createSearch(roster, courts, games, seed) {
    var n = roster.length;
    var plan = computePlan(n, courts, games);
    var sc = roster.map(function (p) { return GRADE_SCORE[p.grade]; });
    var gd = roster.map(function (p) { return p.gender; });
    var picked = pickFewer(gd, plan.r, games, seed);
    var fewer = picked.fewer;
    var target = roster.map(function (_, i) { return fewer.indexOf(i) >= 0 ? games - 1 : games; });
    var rng = makeRng(seed);
    // 성별마다 출전 횟수 합이 홀수면 어떤 대진도 불가능하므로 시도하지 않는다 (판정만 하고 난수는 쓰지 않음)
    var parity = { "남": 0, "여": 0 };
    target.forEach(function (g, i) { parity[gd[i]] += g; });
    var parityFail = !picked.ok || parity["남"] % 2 !== 0 || parity["여"] % 2 !== 0;
    var state = { tries: 0, found: 0, best: null, bestScore: null, done: plan.nSlots === 0 || parityFail };

    function step(budgetMs) {
      var until = Date.now() + budgetMs;
      while (!state.done && Date.now() < until) {
        state.tries += 1;
        var s = tryBuild(sc, gd, target, plan, rng);
        if (s) {
          state.found += 1;
          var score = repeatOpponentPairs(s);            // 6.4: 같은 상대 반복이 가장 적은 해
          if (state.best === null || score < state.bestScore) { state.best = s; state.bestScore = score; }
          if (state.found >= SOLUTIONS_TO_COMPARE) state.done = true;
        }
        if (state.tries >= MAX_RESTARTS) state.done = true;
      }
      return { done: state.done, tries: state.tries, found: state.found, maxTries: MAX_RESTARTS };
    }

    function result() {
      return {
        ok: state.best !== null,
        matches: state.best || [],
        repeatOpp: state.bestScore,
        found: state.found,
        tries: state.tries,
        fewer: fewer,
        parityFail: parityFail,
        plan: plan,
        seed: seed,
        version: SCHEDULER_VERSION
      };
    }

    return { step: step, result: result };
  }

  // ── 참가자별 참가 시각 (6.6, 1.2.0) ─────────────────────────
  // 아래 함수는 늦게 온 사람이 1명 이상일 때만 쓴다. 없으면 createSearchTimed가 위의 createSearch(1.1.0)를 그대로 부른다.
  var TARGET_SALT = 0x85EBCA6B;   // 목표 계산 난수 줄기 (대진 생성 난수·6.5 난수와 다름)

  // "HH:MM"(두 자리 시:분, 00:00–23:59)만 분으로 바꾼다. 그 밖은 null (추측하지 않음)
  function parseHM(s) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
    return h <= 23 && mi <= 59 ? h * 60 + mi : null;
  }

  /*
   * 6.6 정의: 시간대 수 S(전원 정시 기준, computePlan 그대로), 사람마다 첫 가능 시간대 f, 남은 시간대 m, 최소 L, 상한 U.
   * 참가 시각이 비었거나 시작 시각 이전·같으면 정시 (자정 넘김은 다루지 않음).
   * timing: {start: "HH:MM", minutes}
   */
  function arrivalInfo(roster, courts, games, timing) {
    var plan = computePlan(roster.length, courts, games);
    var S = plan.nSlots;
    var start = parseHM(timing && timing.start);
    var d = timing ? timing.minutes : 0;
    var people = roster.map(function (p, i) {
      var a = parseHM(p.arrival);
      if (start === null || a === null || a <= start) return { index: i, late: false, f: 0, m: S };
      var f = 0;
      while (f < S && start + f * d < a) f++;   // 시간대 시작 시각 ≥ 참가 시각인 가장 이른 시간대
      var m = S - f;
      return {
        index: i, late: true, arrival: String(p.arrival).trim(), arrivalMin: a, f: f, m: m,
        L: S > 0 ? Math.floor(games * m / S) : 0,        // 내림
        U: Math.min(games, Math.ceil(m / 2))             // 연속 금지로 m개 시간대에서 최대 ⌈m/2⌉경기
      };
    });
    return { plan: plan, S: S, people: people, late: people.filter(function (p) { return p.late; }) };
  }

  // 시간대 0 … a−1에 넣을 수 있는 최대 경기 수 Q(a) (a = 0 … S). 시간대마다 ≤ 코트 수, ≤ ⌊와 있는 사람/4⌋,
  // 이어진 두 시간대 합 ≤ ⌊뒤 시간대에 와 있는 사람/4⌋ (연속 금지라 두 시간대의 선수가 겹치지 않음)
  function frontCapacity(people, S, C) {
    var A = [], t, x, y;
    for (t = 0; t < S; t++) A.push(people.filter(function (p) { return p.f <= t; }).length);
    var Q = [0];
    var dp = null;   // dp[x] = 시간대 t에 x경기일 때 0…t의 최대 합
    for (t = 0; t < S; t++) {
      var cap = Math.min(C, Math.floor(A[t] / 4));
      var next = [];
      for (x = 0; x <= C; x++) {
        if (x > cap) { next.push(-Infinity); continue; }
        if (!dp) { next.push(x); continue; }
        var best = -Infinity;
        for (y = 0; y <= C; y++) if (dp[y] > -Infinity && x + y <= Math.floor(A[t] / 4)) best = Math.max(best, dp[y] + x);
        next.push(best);
      }
      dp = next;
      Q.push(Math.max.apply(null, dp));
    }
    return Q;
  }

  // 2.2 자리 검사 A·B (필요 조건만): 이 목표라면 들어갈 자리가 아예 없는지
  function roomOk(g, people, S, C, Q) {
    var a, i, sum = 0;
    for (i = 0; i < g.length; i++) sum += g[i];
    for (a = 1; a < S; a++) {
      var D = 0;
      for (i = 0; i < people.length; i++) D += Math.max(0, g[i] - Math.ceil(Math.max(0, a - people[i].f) / 2));
      if (D > 4 * C * (S - a)) return false;                       // 검사 A: 뒤쪽 자리
      if (Math.ceil(sum / 4) > Q[a] + C * (S - a)) return false;   // 검사 B: 앞쪽 인원
    }
    return true;
  }

  /*
   * 6.6 목표 경기 수 (plan_w5.md 2.2, Q-W5-1 (가)).
   * 단계 1: 정시 k, 늦게 L → 단계 2: 자리 검사를 통과하는 한 늦게 온 사람을 U까지 1경기씩 채움
   * → 단계 3: 4의 배수·성별 짝수를 늦게 온 사람의 더한 경기를 되돌려 맞추고, 안 되면 정시 참가자만 6.5 방식으로 1경기 적게.
   * 개수(총 경기 수, 누가 몇 경기의 개수)는 대진 번호와 관계없고, 대진 번호는 같은 조건인 사람 중 누구인지만 정한다.
   * reason: null(성공) | "zeroMin"(L = 0인 사람) | "noRoom"(단계 1부터 자리 없음 또는 L > U) | "parity"(짝수 조건 실패)
   */
  function lateTargets(roster, courts, games, seed, timing) {
    var info = arrivalInfo(roster, courts, games, timing);
    var people = info.people, S = info.S, C = courts;
    var gd = roster.map(function (p) { return p.gender; });
    var out = { info: info, reason: null, start: null, filled: null, target: null, fewer: [], adjusted: [], total: 0 };
    var g = people.map(function (p) { return p.late ? p.L : games; });
    out.start = g.slice();
    if (info.late.some(function (p) { return p.L === 0; })) { out.reason = "zeroMin"; return out; }
    var Q = frontCapacity(people, S, C);
    if (info.late.some(function (p) { return p.L > p.U; }) || !roomOk(g, people, S, C, Q)) { out.reason = "noRoom"; return out; }

    var rng = makeRng((seed ^ TARGET_SALT) >>> 0);
    var rank = {};
    shuffle(info.late.map(function (p) { return p.index; }), rng).forEach(function (i, r) { rank[i] = r; });
    // 넘침 e = g − k·m/S 를 S배 한 정수로 비교한다 (소수 오차 없이)
    function over(i) { return g[i] * S - games * people[i].m; }

    // 단계 2 — 채우기: 넘침이 작은 사람 → 먼저 온 사람 → 대진 번호 순서
    var blocked = {};
    for (;;) {
      var cands = info.late.filter(function (p) { return g[p.index] < p.U && !blocked[p.index]; })
        .map(function (p) { return p.index; })
        .sort(function (a, b) { return (over(a) - over(b)) || (people[a].arrivalMin - people[b].arrivalMin) || (rank[a] - rank[b]); });
      var added = false;
      for (var ci = 0; ci < cands.length && !added; ci++) {
        g[cands[ci]] += 1;
        if (roomOk(g, people, S, C, Q)) added = true;
        else { g[cands[ci]] -= 1; blocked[cands[ci]] = true; }   // 검사는 g가 늘수록 어려워지므로 다시 볼 필요 없음
      }
      if (!added) break;
    }
    out.filled = g.slice();

    // 단계 3 — 4의 배수·성별 짝수
    var sums = { "남": 0, "여": 0 };
    g.forEach(function (v, i) { sums[gd[i]] += v; });
    var total = sums["남"] + sums["여"];
    if (total % 4 !== 0 || sums["남"] % 2 !== 0 || sums["여"] % 2 !== 0) {
      // 3-1: 늦게 온 사람의 더한 경기 되돌리기. 넘침이 큰 사람 → 늦게 온 사람 → 대진 번호 순서
      var giveBack = function (gender) {
        return info.late.filter(function (p) { return gd[p.index] === gender && g[p.index] > p.L; })
          .map(function (p) { return p.index; })
          .sort(function (a, b) { return (over(b) - over(a)) || (people[b].arrivalMin - people[a].arrivalMin) || (rank[a] - rank[b]); });
      };
      var gm = giveBack("남"), gw = giveBack("여");
      var opts = [];
      for (var dm = 0; dm <= 3; dm++) {
        for (var dw = 0; dw <= 3; dw++) {
          if (dm > gm.length || dw > gw.length) continue;
          if ((sums["남"] - dm) % 2 !== 0 || (sums["여"] - dw) % 2 !== 0 || (total - dm - dw) % 4 !== 0) continue;
          var who = gm.slice(0, dm).concat(gw.slice(0, dw));
          opts.push({ cost: dm + dw, excess: who.reduce(function (s, i) { return s + over(i); }, 0), who: who });
        }
      }
      if (opts.length) {
        var minCost = Math.min.apply(null, opts.map(function (o) { return o.cost; }));
        opts = opts.filter(function (o) { return o.cost === minCost; });
        var maxEx = Math.max.apply(null, opts.map(function (o) { return o.excess; }));
        opts = opts.filter(function (o) { return o.excess === maxEx; });
        var pick = opts.length === 1 ? opts[0] : opts[Math.floor(rng() * opts.length)];
        pick.who.forEach(function (i) { g[i] -= 1; });
        out.adjusted = pick.who.slice().sort(function (a, b) { return a - b; });
      } else {
        // 3-2: 늦게 온 사람은 그대로, 정시 참가자만 6.5 방식 (성별 나눔은 계산, 성별 안에서는 대진 번호 난수)
        var r = total % 4;
        var onMen = [], onWomen = [];
        people.forEach(function (p, i) { if (!p.late) (gd[i] === "남" ? onMen : onWomen).push(i); });
        var splits = [];
        for (var fm = 0; fm <= r; fm++) {
          var fw = r - fm;
          if (fm > onMen.length || fw > onWomen.length) continue;
          if ((sums["남"] - fm) % 2 === 0 && (sums["여"] - fw) % 2 === 0) splits.push(fm);
        }
        if (!splits.length) { out.reason = "parity"; out.target = g.slice(); return out; }   // 3-3
        var cm = splits.length === 1 ? splits[0] : splits[Math.floor(rng() * splits.length)];
        out.fewer = pickSome(onMen, cm, rng).concat(pickSome(onWomen, r - cm, rng)).sort(function (a, b) { return a - b; });
        out.fewer.forEach(function (i) { g[i] -= 1; });
      }
    }
    out.target = g;
    out.total = g.reduce(function (s, v) { return s + v; }, 0) / 4;
    return out;
  }

  /*
   * 2.2 단계 4: tryBuild(1.1.0)와 같은 방식에 두 가지만 다르다.
   * ① 시간대 t에서 첫 가능 시간대 first[p] > t인 사람은 뽑지 않고, 남은 경기를 채울 수 있는지 셀 때 그 사람은 first[p]부터 센다.
   * ② 시간대별 경기 수는 고르게 나눠 섞되, 그때 와 있는 사람으로 못 넣는 경기는 다음 시간대로 넘긴다(코트 수 안에서).
   */
  function tryBuildLate(sc, gd, target, first, nSlots, courts, totalGames, rng) {
    var n = sc.length;
    var base = Math.floor(totalGames / nSlots), extra = totalGames - base * nSlots;
    var ks = [], t, p, u;
    for (t = 0; t < extra; t++) ks.push(base + 1);
    for (t = extra; t < nSlots; t++) ks.push(base);
    shuffle(ks, rng);
    var spareAfter = [];                                          // 시간대 t 뒤에 더 넣을 수 있는 경기 수
    for (t = 0; t < nSlots; t++) {
      var sp = 0;
      for (u = t + 1; u < nSlots; u++) sp += courts - ks[u];
      spareAfter.push(sp);
    }

    var remaining = target.slice();
    var last = [];
    for (p = 0; p < n; p++) last.push(-99);
    var partners = new Set();
    var schedule = [];
    var carry = 0;

    for (t = 0; t < nSlots; t++) {
      var left = nSlots - t;
      for (p = 0; p < n; p++) {
        var cap = first[p] > t ? Math.ceil((nSlots - first[p]) / 2)
          : (last[p] === t - 1 ? Math.ceil((left - 1) / 2) : Math.ceil(left / 2));
        if (remaining[p] > cap) return null;
      }
      var eligible = [];
      for (p = 0; p < n; p++) if (first[p] <= t && remaining[p] > 0 && last[p] !== t - 1) eligible.push(p);
      var urgent = new Set();
      eligible.forEach(function (x) { if (remaining[x] > Math.ceil((left - 1) / 2)) urgent.add(x); });
      var want = Math.min(courts, ks[t] + carry, Math.floor(eligible.length / 4));
      var need = Math.ceil(urgent.size / 4);
      if (need > want) return null;

      var slotMatches = null;
      for (var k = want; k >= need && !slotMatches; k--) {        // 못 넣으면 한 경기 줄여 다음 시간대로 넘긴다
        if (k === 0) { slotMatches = []; break; }
        for (var attempt = 0; attempt < SLOT_ATTEMPTS; attempt++) {
          var keyed = eligible.map(function (x, idx) {
            return { p: x, u: urgent.has(x) ? 0 : 1, v: -remaining[x] + rng() * 1.5, idx: idx };
          });
          keyed.sort(function (A, B) { return (A.u - B.u) || (A.v - B.v) || (A.idx - B.idx); });
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
      carry = ks[t] + carry - slotMatches.length;
      if (carry > spareAfter[t]) return null;

      slotMatches.forEach(function (m, ci) {
        schedule.push({ slot: t, court: ci + 1, t1: m.t1, t2: m.t2, type: m.type });
        partners.add(pairKey(m.t1[0], m.t1[1]));
        partners.add(pairKey(m.t2[0], m.t2[1]));
        m.t1.concat(m.t2).forEach(function (x) { remaining[x] -= 1; last[x] = t; });
      });
    }
    for (p = 0; p < n; p++) if (remaining[p]) return null;
    return schedule;
  }

  /*
   * 화면이 부르는 대진 탐색 (1.2.0). 늦게 온 사람이 없으면 createSearch(1.1.0)를 그대로 돌려준다 → 난수 순서까지 같음.
   * timing: {start: "HH:MM", minutes}. roster의 각 사람에 arrival("HH:MM" 또는 빈칸)이 있을 수 있다
   */
  function createSearchTimed(roster, courts, games, seed, timing) {
    var info = arrivalInfo(roster, courts, games, timing);
    if (!info.late.length) return createSearch(roster, courts, games, seed);

    var tg = lateTargets(roster, courts, games, seed, timing);
    var sc = roster.map(function (p) { return GRADE_SCORE[p.grade]; });
    var gd = roster.map(function (p) { return p.gender; });
    var first = info.people.map(function (p) { return p.f; });
    var rng = makeRng(seed);
    var state = { tries: 0, found: 0, best: null, bestScore: null, done: info.S === 0 || tg.reason !== null };

    function step(budgetMs) {
      var until = Date.now() + budgetMs;
      while (!state.done && Date.now() < until) {
        state.tries += 1;
        var s = tryBuildLate(sc, gd, tg.target, first, info.S, courts, tg.total, rng);
        if (s) {
          state.found += 1;
          var score = repeatOpponentPairs(s);            // 6.4
          if (state.best === null || score < state.bestScore) { state.best = s; state.bestScore = score; }
          if (state.found >= SOLUTIONS_TO_COMPARE) state.done = true;
        }
        if (state.tries >= MAX_RESTARTS) state.done = true;
      }
      return { done: state.done, tries: state.tries, found: state.found, maxTries: MAX_RESTARTS };
    }

    function result() {
      return {
        ok: state.best !== null,
        matches: state.best || [],
        repeatOpp: state.bestScore,
        found: state.found,
        tries: state.tries,
        fewer: tg.fewer,                                   // 1경기 적게 배정된 정시 참가자 (6.6 ④)
        parityFail: tg.reason === "parity",
        noRoom: tg.reason === "noRoom",
        zeroMin: tg.reason === "zeroMin",
        late: info.late.map(function (p) {
          return { index: p.index, arrival: p.arrival, f: p.f, m: p.m, L: p.L, U: p.U, target: tg.target ? tg.target[p.index] : null };
        }),
        targetTotal: tg.total,
        plan: info.plan,
        seed: seed,
        version: SCHEDULER_VERSION
      };
    }

    return { step: step, result: result };
  }

  // 5절 상충 안내 + 참가 시각. 늦게 온 사람이 있으면 성별 짝수 안내만 6.6 목표 계산 결과로 판정한다 (그 밖은 그대로)
  function checkFeasibilityTimed(roster, courts, games, timing, seed) {
    var warns = checkFeasibility(roster, courts, games);
    var info = arrivalInfo(roster, courts, games, timing);
    if (!info.late.length || info.S === 0) return warns;
    var tg = lateTargets(roster, courts, games, seed || 0, timing);
    warns = warns.filter(function (w) { return w.reason.indexOf("남자 출전 횟수 합(") !== 0; });
    if (tg.reason === "parity") {
      warns.push({
        reason: "늦게 오는 사람의 경기 수를 조절하고 정시 참가자를 1경기 적게 해도 남자 또는 여자의 출전 횟수 합을 짝수로 만들 수 없습니다. 한 경기에 남자·여자는 0·2·4명씩 들어가기 때문입니다.",
        fix: "1인당 경기 수를 바꿔 보세요."
      });
    }
    return warns;
  }

  global.Scheduler = {
    SCHEDULER_VERSION: SCHEDULER_VERSION,
    GRADE_SCORE: GRADE_SCORE,
    PLAYERS_PER_COURT_RULE: PLAYERS_PER_COURT_RULE,
    MAX_GRADE_DIFF: MAX_GRADE_DIFF,
    MAX_RESTARTS: MAX_RESTARTS,
    SOLUTIONS_TO_COMPARE: SOLUTIONS_TO_COMPARE,
    sortRoster: sortRoster,
    recommendedCourts: recommendedCourts,
    computePlan: computePlan,
    checkFeasibility: checkFeasibility,
    slotTime: slotTime,
    createSearch: createSearch,
    // 1.2.0 (6.6)
    parseHM: parseHM,
    arrivalInfo: arrivalInfo,
    lateTargets: lateTargets,
    createSearchTimed: createSearchTimed,
    checkFeasibilityTimed: checkFeasibilityTimed
  };
})(this);
