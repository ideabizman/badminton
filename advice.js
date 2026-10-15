/*
 * advice.js — 대진을 찾지 못했을 때 보여 줄 안내를 고른다 (CLAUDE.md 5.1).
 * 생성 코드(scheduler.js)와 따로 두고, 생성 결과·명단·설정을 읽기만 한다. 생성 결과를 바꾸지 않는다.
 *
 * 안내 종류와 순서 (2026-10-15 결정: P → B → A → W → C)
 *   P  성별 짝수 조건 실패 (대진 번호를 바꿔도 해결되지 않음)
 *   B  코트 1면·인원 10명 이하 → 1인당 경기 수 줄이기
 *   A  5절 안내가 없고 짝수 조건 실패도 아님 → 새 번호로 다시
 *   W  5절 안내 (이유 → 바꿀 항목)
 *   C  일반 안내 (B가 없을 때만)
 */
(function (global) {
  "use strict";

  var SMALL_GROUP_MAX = 10;   // 5.1: 코트 1면·인원 10명 이하

  // roster: 정렬한 명단, settings: {courts, games}, res: Scheduler 결과(ok가 false)
  function forFailure(roster, settings, res) {
    var n = roster.length;
    var warns = Scheduler.checkFeasibility(roster, settings.courts, settings.games);
    var intro;
    var items = [];

    if (res.parityFail) {
      var fewerTxt = (res.fewer || []).map(function (i) { return roster[i].name + "(" + roster[i].gender + ")"; }).join(", ");
      intro = { kind: "P", text: "남자 또는 여자의 출전 횟수 합이 홀수라 짝을 맞출 수 없습니다. 한 경기에 남자·여자는 0·2·4명씩 들어가기 때문입니다." +
        (fewerTxt ? " 이 대진 번호로는 1경기 적게 배정되는 사람이 " + fewerTxt + "입니다." : "") };
    } else {
      intro = { kind: "T", text: res.tries + "번 시도했지만 모든 규칙(연속 경기 없음, 같은 파트너 반복 없음, 같은 종류끼리, 급수 합 차이 1 이하)을 함께 지키는 대진을 찾지 못했습니다." };
    }

    var small = settings.courts === 1 && n <= SMALL_GROUP_MAX;
    if (small) {
      items.push({ kind: "B", text: "인원이 적어 같은 사람끼리 자주 만나게 됩니다. 1인당 경기 수를 줄여 보세요." });
    }
    var newSeed = !res.parityFail && warns.length === 0;
    if (newSeed) {
      items.push({ kind: "A", text: "같은 설정이라도 대진 번호가 바뀌면 만들어질 수 있습니다. 새 번호로 다시 해 보세요." });
    }
    warns.forEach(function (w) { items.push({ kind: "W", text: w.reason + " → " + w.fix }); });
    if (!small) {
      items.push({ kind: "C", text: "코트 수를 줄여 보세요 (권장 " + Scheduler.recommendedCourts(n) + "면)." });
      items.push({ kind: "C", text: "1인당 경기 수를 줄여 보세요." });
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

  global.Advice = { SMALL_GROUP_MAX: SMALL_GROUP_MAX, forFailure: forFailure };
})(this);
