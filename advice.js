/*
 * advice.js — 대진을 찾지 못했을 때 보여 줄 안내를 고른다 (CLAUDE.md 개정 8의 6.6, plan_w5b.md 2.6).
 * 생성 코드(scheduler.js)와 따로 두고, 생성 결과·명단·설정을 읽기만 한다. 생성 결과를 바꾸지 않는다.
 *
 * 안내 종류와 순서 (plan Q7): P → B → L → D → A → C
 *   P  성별 짝수 때문에 M이 계속 줄어 한도에 닿음
 *   B  코트 1면·인원 10명 이하 → 1인당 최대 경기 수 넣기
 *   L  늦게 옴·일찍 감 인원이 있음 → 앞(뒤) 시간대 인원 부족
 *   D  2연속이 필요한 설정 (코트에 비해 인원이 적음)
 *   A  P가 아님 → 새 번호로 다시
 *   C  일반 안내 (B가 없을 때만)
 */
(function (global) {
  "use strict";

  var SMALL_GROUP_MAX = 10;   // 코트 1면·인원 10명 이하

  // roster: 정렬한 명단, settings: {start, end, minutes, courts, maxGames, seed}, res: Scheduler 결과(ok가 false)
  function forFailure(roster, settings, res) {
    var n = roster.length;
    var iv = res.iv;
    var parityAll = res.failReason === "parity" ||
      (res.reductions.length > 0 && res.reductions.every(function (r) { return r.reason === "parity"; }) && res.tries === 0);
    var items = [];
    var tried = res.tried && res.tried.length
      ? (res.tried.length > 1 ? res.tried[0] + " → " + res.tried[res.tried.length - 1] + "경기까지" : res.tried[0] + "경기로")
      : "";
    var intro;
    if (res.failReason === "empty") {
      intro = { kind: "E", text: "이 인원·시각으로는 한 시간대에 4명이 모이지 않아 만들 경기가 없습니다." };
    } else if (parityAll) {
      intro = { kind: "P", text: "남자 또는 여자의 출전 횟수 합을 짝수로 맞출 수 없어 만들 수 없었습니다. 한 경기에 남자·여자는 0·2·4명씩 들어가기 때문입니다." };
    } else {
      intro = { kind: "T", text: res.tries + "번 시도했지만(" + tried + " 줄여 가며) 모든 규칙(3연속 없음, 같은 파트너 반복 없음, 같은 종류끼리, 급수 합 차이 1 이하, 경기 수는 참여 시간 비례)을 함께 지키는 대진을 찾지 못했습니다." };
    }

    if (parityAll) {
      items.push({ kind: "P", text: "명단의 남녀 인원을 확인하거나 1인당 최대 경기 수를 바꿔 보세요." });
    }
    var small = settings.courts === 1 && n <= SMALL_GROUP_MAX;
    if (small) {
      items.push({ kind: "B", text: "인원이 적어 같은 사람끼리 자주 만나게 됩니다. ① 설정에서 1인당 최대 경기 수를 넣어(예: 3) 보세요." });
    }
    var late = iv.people.filter(function (p) { return p.late; });
    var early = iv.people.filter(function (p) { return p.early; });
    if (late.length || early.length) {
      var parts = [];
      if (late.length) {
        var lastA = late.map(function (p) { return roster[p.index].arrival; }).sort().pop();
        parts.push("늦게 오는 사람 " + late.length + "명(가장 늦게 " + lastA + ")");
      }
      if (early.length) {
        var firstL = early.map(function (p) { return roster[p.index].leave; }).sort()[0];
        parts.push("일찍 가는 사람 " + early.length + "명(가장 일찍 " + firstL + ")");
      }
      items.push({ kind: "L", text: parts.join(", ") + "이 있습니다. 앞이나 뒤 시간대에 경기할 사람이 모자랄 수 있습니다. 코트 수를 줄여 보세요." });
    }
    var target = res.target && res.target.length ? res.target : null;
    var loads = res.plannedLoads || [];
    if (target && loads.length && Scheduler.needsDoubles(iv, target, loads).length) {
      items.push({ kind: "D", text: "코트에 비해 인원이 적어 일부 참가자가 이어서 뛰어야 합니다. 코트 수를 줄이거나 1인당 최대 경기 수를 넣어 보세요." });
    }
    var newSeed = !parityAll && res.failReason !== "empty";
    if (newSeed) {
      items.push({ kind: "A", text: "같은 설정이라도 대진 번호가 바뀌면 만들어질 수 있습니다. 새 번호로 다시 해 보세요." });
    }
    if (!small) {
      items.push({ kind: "C", text: "코트 수를 줄여 보세요." });
      items.push({ kind: "C", text: "한 성별이나 한 급수에 사람이 아주 적으면 맞출 상대가 없을 수 있습니다. 명단을 확인해 보세요." });
    }
    return {
      title: "규칙을 완화하지 않아 만들 수 없었습니다.",
      intro: intro,
      items: items,
      offerNewSeed: newSeed,
      kinds: [intro.kind].concat(items.map(function (it) { return it.kind; }))
    };
  }

  /*
   * 재편성 실패 안내 (plan_w7.md 2.8, 검토 반영 Q7): R0 → P → N → A. 바탕 대진은 그대로 둔다.
   * res: Scheduler.createRestSearch 결과(ok가 false), settings: 설정
   * N: 새로 온 사람 x(남은 배정 ≥ 1)마다, x와 같은 경기에 들어갈 수 있는 4인 조합(종류·급수 차이 ≤ 1·하루 파트너 기록과 안 겹침)이
   *    남은 배정보다 적으면 N
   */
  function newcomerShort(res) {
    var roster = res.roster, iv = res.iv, T = res.T, out = [];
    if (!iv) return out;
    var sc = { A: 4, B: 3, C: 2, D: 1, "초심": 0 };
    var used = {};
    (res.fixedPairs || []).forEach(function (k) { used[k] = true; });
    function pk(a, b) { return a < b ? a + "," + b : b + "," + a; }
    roster.forEach(function (x, xi) {
      if (res.changeOf[x.name] !== "new" || !(res.target[xi] >= 1)) return;
      var px = iv.people[xi];
      var near = [];
      roster.forEach(function (y, yi) {
        if (yi === xi || !(res.rp[yi] && res.rp[yi].H > 0)) return;
        var py = iv.people[yi];
        if (Math.min(px.l, py.l) >= Math.max(px.f, py.f, T + 1)) near.push(yi);
      });
      var count = 0;
      near.forEach(function (q) {
        if (used[pk(xi, q)]) return;
        var gx = [x.gender, roster[q].gender].sort().join("");
        var s1 = sc[x.grade] + sc[roster[q].grade];
        for (var i = 0; i < near.length; i++) for (var j = i + 1; j < near.length; j++) {
          var a = near[i], b = near[j];
          if (a === q || b === q || used[pk(a, b)]) continue;
          if ([roster[a].gender, roster[b].gender].sort().join("") !== gx) continue;
          if (Math.abs(s1 - sc[roster[a].grade] - sc[roster[b].grade]) > 1) continue;
          count++;
        }
      });
      if (count < res.target[xi]) out.push(x.name);
    });
    return out;
  }

  function forRestFailure(res, settings) {
    var items = [];
    var tried = res.tried && res.tried.length
      ? (res.tried.length > 1 ? res.tried[0] + " → " + res.tried[res.tried.length - 1] + "경기까지" : res.tried[0] + "경기로")
      : "";
    var intro;
    if (res.failReason === "empty") {
      intro = { kind: "R0", text: "남은 시간에 경기를 할 수 있는 사람이 4명이 안 됩니다." };
    } else if (res.failReason === "parity") {
      intro = { kind: "P", text: "남은 경기에서 남자 또는 여자의 출전 횟수 합을 짝수로 맞출 수 없습니다. 한 경기에 남자·여자는 0·2·4명씩 들어가기 때문입니다." };
      items.push({ kind: "P", text: "새로 온 사람이나 불참한 사람의 남녀 구성을 확인해 보세요." });
    } else {
      intro = { kind: "T", text: res.tries + "번 시도했지만(" + tried + " 줄여 가며) 지난 경기를 그대로 두고 모든 규칙을 함께 지키는 남은 대진을 찾지 못했습니다." };
    }
    if (res.failReason === "search") {
      var short = newcomerShort(res);
      if (short.length) items.push({ kind: "N", text: "새로 온 " + short.join(", ") + " 님과 급수·성별이 맞는 상대가 적습니다." });
      items.push({ kind: "A", text: "대진 번호가 바뀌면 짤 수 있을 수 있습니다. [새 번호로 다시 짜기]를 눌러 보세요." });
    }
    return {
      title: "남은 시간의 대진을 규칙대로 짜지 못했습니다. 지금 대진은 그대로입니다.",
      intro: intro,
      items: items,
      offerNewSeed: res.failReason === "search",
      kinds: [intro.kind].concat(items.map(function (it) { return it.kind; }))
    };
  }

  global.Advice = { SMALL_GROUP_MAX: SMALL_GROUP_MAX, forFailure: forFailure, forRestFailure: forRestFailure, newcomerShort: newcomerShort };
})(this);
