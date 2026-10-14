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
  var SCHEDULER_VERSION = "1.1.0";

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
    createSearch: createSearch
  };
})(this);
