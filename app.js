/*
 * app.js — 화면 동작. 대진 생성 규칙은 scheduler.js, 자기 점검은 checker.js, 실패 안내는 advice.js에 있다.
 * 명단은 이 브라우저 안에서만 다루고, 외부로 보내지 않는다.
 * 개정 8 (W5b): ① 설정 → ② 명단 → ③ 결과. 1인당 경기 수는 입력하지 않고 참여 시간에 비례해 계산한다.
 * 개정 10 (W7): ③ 결과의 [진행 중 변경] → 진행 중 재편성 화면(8.1). 오늘 대진은 이 기기에만 저장한다(plan_w7.md 2.2).
 */
(function () {
  "use strict";

  var STORAGE_KEY = "w_badminton_last_roster";   // 명단 + 설정(plan 2.7)을 함께 저장
  var TODAY_KEY = "w_badminton_today";            // 재편성용 오늘 대진 (plan_w7.md 2.2, 이 기기 안에만)
  var TODAY_FORMAT = 1;
  var CHANGE_LABEL = { same: "그대로", absent: "불참", arrival: "참가 시각 변경", leave: "일찍 감", "new": "새로 옴" };
  var GENDERS = ["남", "여"];
  var GRADES = ["A", "B", "C", "D", "초심"];
  var COLUMN_ALIASES = { name: ["이름", "성명"], gender: ["성별"], grade: ["급수", "출전급수"] };
  // 4절: 참가·퇴장 시각 열. 없어도 열 고르기 상자를 띄우지 않는다
  var ARRIVAL_ALIASES = ["참가시각", "참가 시각", "도착시각", "도착 시각"];
  var LEAVE_ALIASES = ["퇴장시각", "퇴장 시각", "종료시각", "종료 시각"];
  var TIME_FORMAT_MSG = { arrival: "참가 시각은 19:30처럼 시:분으로 넣어 주세요", leave: "퇴장 시각은 21:00처럼 시:분으로 넣어 주세요" };
  var NO_SLOT_MSG = "이 참가·퇴장 시각으로는 경기할 시간대가 없습니다";
  var PICK_WINDOW_MIN = 120;   // 4.1: 참가·퇴장 시각 풀다운은 시작 후·종료 전 2시간 이내
  var MIN_PLAYERS = 8;
  var STEP_BUDGET_MS = 40;     // 한 번에 계산하는 시간. 그 사이에 화면을 다시 그린다
  // 화면 수정일 (12절: 다시 올린 뒤 새 화면이 보이는지 확인용). 생성 결과와 관계없으므로 SCHEDULER_VERSION과 따로 둔다.
  // 바꿀 때 index.html의 ?v= 날짜도 함께 바꾼다
  var UI_BUILD = "2026-10-22 W7c2";
  var STALE_MSG = "명단·설정이 바뀌었습니다. [다시 만들기]를 눌러야 반영됩니다";
  // 카톡 안 브라우저 (4.3). 브라우저 정보는 이 기기 안에서 읽기만 한다
  var IN_KAKAO = /KAKAOTALK/i.test(navigator.userAgent || "");

  var state = {
    roster: [],             // [{name, gender, grade, arrival, leave, xa, xl}] (입력 그대로, 정리는 normalize에서). xa·xl = Excel에서 온 값
    settings: null,         // 마지막으로 확인한 올바른 설정 {date, start, end, minutes, courts, maxGames}
    replaySeed: "",         // "대진 번호로 다시 보기"로 들어온 번호
    fileSettings: null,     // 불러온 Excel의 '대진표 생성 기준' 값 (이 앱이 저장한 파일일 때)
    fileNotice: [],
    result: null,
    running: null,
    today: null,            // 오늘 대진 {format, savedAt, appVersion, date, settings, current, rounds} (저장소와 같은 내용, 저장이 안 되는 브라우저에서도 이 화면 동안은 씀)
    restForm: null          // 진행 중 변경 화면의 입력 (newRestForm). edits: {이름: {absent, arrival, leave}}, newcomers, 열린 카드·이름 버튼, showAll: 미리보기 사람별 표 [전체 보기]
  };

  // ── 작은 도우미 ─────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "class") node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function pad2(v) { return (v < 10 ? "0" : "") + v; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function dateLabel(s) {
    var d = new Date(s + "T00:00:00");
    if (isNaN(d)) return s;
    return s + " (" + "일월화수목금토".charAt(d.getDay()) + ")";
  }

  function defaultSettings() {
    return { date: todayStr(), start: "19:00", end: "21:30", minutes: 15, courts: 3, maxGames: null };
  }

  // "4경기 27명 · 3경기 4명" (많은 경기부터)
  function distText(values) {
    var d = {};
    values.forEach(function (v) { d[v] = (d[v] || 0) + 1; });
    return Object.keys(d).map(Number).sort(function (a, b) { return b - a; }).map(function (k) { return k + "경기 " + d[k] + "명"; }).join(" · ");
  }

  // ── 화면 전환 ───────────────────────────────────────────
  var VIEWS = ["home", "settings", "roster", "result", "rest"];
  var currentView = "home";

  function show(view) {
    currentView = view;
    VIEWS.forEach(function (v) { $("view-" + v).hidden = v !== view; });
    if (view === "result") { updateStale(); refreshResultButtons(); }
    refreshSteps();
    window.scrollTo(0, 0);
  }

  // ── 진행 표시를 눌러 단계 이동 (8절) ─────────────────────
  function rosterStatus() {
    var checks = validate(state.roster);
    var n = 0, warn = 0;
    checks.forEach(function (c) { if (!c.blank) n += 1; if (c.msgs.length) warn += 1; });
    return { n: n, warn: warn, ok: warn === 0 && n >= MIN_PLAYERS };
  }

  // 단계마다 누를 수 없으면 그 이유, 누를 수 있으면 ""
  function stepLock(step) {
    if (state.running) return "대진을 찾는 중입니다. 끝나거나 [멈추기]를 누른 뒤 옮길 수 있습니다";
    if (step === "roster" && readSettings().errors.length) return "① 설정을 먼저 마쳐 주세요 (" + readSettings().errors[0] + ")";
    if (step === "result" && !state.result) return "아직 만든 대진표가 없습니다. ② 명단에서 [대진 만들기]를 눌러 주세요";
    return "";
  }

  function refreshSteps() {
    $("step-msg").textContent = "";
    var idx = VIEWS.indexOf(currentView === "rest" ? "result" : currentView);   // 진행 중 변경은 ③ 결과 위에 겹친 화면
    document.querySelectorAll(".steps [data-step]").forEach(function (b) {
      var step = b.getAttribute("data-step");
      var i = VIEWS.indexOf(step);
      var locked = i !== idx && !!stepLock(step);   // 지금 보고 있는 단계는 흐리게 하지 않는다
      b.classList.toggle("active", i === idx);
      b.classList.toggle("done", i < idx);
      b.classList.toggle("locked", locked);
      b.setAttribute("aria-disabled", locked ? "true" : "false");
      if (i === idx) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    });
  }

  function goStep(step) {
    var why = stepLock(step);
    if (why) { $("step-msg").textContent = why; return; }
    if (step === currentView) return;
    if (currentView === "rest" && state.running) return;
    if (step === "settings") enterSettings();
    else if (step === "roster") enterRoster();
    else if (step === "result") show("result");
  }

  // ── 결과가 지금 명단·설정과 맞는지 (8절) ─────────────────
  function snapshot(roster, s, seed) {
    return JSON.stringify({
      roster: roster.map(function (p) { return [p.name, p.gender, p.grade, p.arrival, p.leave]; }),
      settings: [s.date, s.start, s.end, s.minutes, s.courts, s.maxGames, seed]
    });
  }

  function currentSnapshot() {
    var rs = readSettings();
    if (rs.errors.length) return "(설정 오류)";
    return snapshot(Scheduler.sortRoster(validPlayers()), rs.s, $("set-seed").value.trim());
  }

  function isStale() { return !!state.result && currentSnapshot() !== state.result.snapshot; }
  function updateStale() { $("result-stale").hidden = !isStale(); }

  function confirmIfStale(what) {
    if (!isStale()) return true;
    return window.confirm(STALE_MSG + "\n\n이전 결과로 " + what + "할까요?");
  }

  // ── ① 설정 (5절) ───────────────────────────────────────
  function fillSettingsInputs(s) {
    $("set-date").value = s.date;
    $("set-start").value = s.start;
    $("set-end").value = s.end;
    $("set-minutes").value = s.minutes;
    $("set-courts").value = s.courts;
    $("set-max").value = s.maxGames ? String(s.maxGames) : "";
  }

  function readSettings() {
    var errors = [];
    var maxRaw = $("set-max").value.trim();
    var s = {
      date: $("set-date").value,
      start: $("set-start").value.slice(0, 5),
      end: $("set-end").value.slice(0, 5),
      minutes: Number($("set-minutes").value),
      courts: Number($("set-courts").value),
      maxGames: maxRaw === "" ? null : Number(maxRaw)
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) errors.push("날짜를 골라 주세요.");
    var st = Scheduler.parseHM(s.start), en = Scheduler.parseHM(s.end);
    if (st === null) errors.push("시작 시각을 넣어 주세요.");
    if (en === null) errors.push("종료 시각을 넣어 주세요.");
    if (!(Number.isInteger(s.minutes) && s.minutes >= 1)) errors.push("경기 시간은 1 이상의 정수(분)로 넣어 주세요.");
    if (!(Number.isInteger(s.courts) && s.courts >= 1)) errors.push("코트 수는 1 이상의 정수로 넣어 주세요.");
    if (s.maxGames !== null && !(Number.isInteger(s.maxGames) && s.maxGames >= 1)) errors.push("1인당 최대 경기 수는 1 이상의 정수로 넣거나 비워 주세요.");
    var S = 0;
    if (st !== null && en !== null) {
      if (en <= st) errors.push("종료 시각은 시작 시각보다 늦어야 합니다.");
      else if (errors.length === 0) {
        S = Scheduler.slots(s).S;
        if (S < 2) errors.push("시간대가 " + S + "개뿐입니다. 경기 시간 2번 이상이 들어가도록 시각이나 경기 시간을 바꿔 주세요.");
      }
    }
    return { s: s, errors: errors, S: S };
  }

  function enterSettings() {
    fillSettingsInputs(state.settings || defaultSettings());
    renderSettingsNotice();
    refreshSettings();
    show("settings");
  }

  function renderSettingsNotice() {
    var box = $("settings-notice");
    clear(box);
    var lines = [];
    if (state.replaySeed) lines.push("대진 번호 " + state.replaySeed + "로 다시 봅니다. 그날의 설정을 확인하고, 다음 화면에서 명단을 넣어 주세요.");
    lines.forEach(function (t) { box.appendChild(el("p", { text: t })); });
    box.hidden = lines.length === 0;
  }

  function refreshSettings() {
    var rs = readSettings();
    $("settings-error").textContent = rs.errors.join(" ");
    $("settings-next").disabled = rs.errors.length > 0;
    var box = $("settings-preview");
    clear(box);
    if (!rs.errors.length) {
      var s = rs.s;
      state.settings = s;
      var used = rs.S * s.minutes;
      var t = el("table", { class: "preview-table" });
      [["시간대 수", rs.S + "개 (" + s.start + "–" + Scheduler.slotTime(s.start, s.minutes, rs.S) + ", " + s.minutes + "분씩)"],
       ["최대 경기 수", (s.courts * rs.S) + "경기 (코트 " + s.courts + "면 × " + rs.S + "개 시간대)"]].forEach(function (it) {
        t.appendChild(el("tr", null, [el("th", { text: it[0] }), el("td", { class: "left", text: it[1] })]));
      });
      box.appendChild(t);
      var gap = Scheduler.parseHM(s.end) - Scheduler.parseHM(s.start) - used;
      if (gap > 0) box.appendChild(el("p", { class: "hint", text: "마지막 " + gap + "분은 경기 시간보다 짧아 쓰지 않습니다 (마지막 경기 종료 " + Scheduler.slotTime(s.start, s.minutes, rs.S) + ")." }));
    }
    box.appendChild(el("p", { class: "hint", text: "예: 19:00–21:30, 15분, 3면 → 10개 시간대, 최대 30경기" }));
    refreshSteps();
  }

  // ── ② 명단: 정리와 확인 (4절) ────────────────────────────
  function normalize(p) {
    var name = String(p.name == null ? "" : p.name).trim();
    var gender = String(p.gender == null ? "" : p.gender).trim();
    var grade = String(p.grade == null ? "" : p.grade).trim();
    var arrival = String(p.arrival == null ? "" : p.arrival).trim();   // 앞뒤 공백 제거만
    var leave = String(p.leave == null ? "" : p.leave).trim();
    if (/^[a-d]$/.test(grade)) grade = grade.toUpperCase();   // 허용된 자동 처리는 공백 제거와 a–d 대문자뿐
    return { name: name, gender: gender, grade: grade, arrival: arrival, leave: leave, xa: !!p.xa, xl: !!p.xl };
  }

  function isBlank(p) { return !p.name && !p.gender && !p.grade; }

  function validPlayers() {
    return state.roster.map(normalize).filter(function (p) { return !isBlank(p); });
  }

  function goodSettings() {
    var rs = readSettings();
    return rs.errors.length ? null : rs.s;
  }

  // 빈 줄은 빼고, 각 줄의 ⚠ 내용을 돌려준다
  function validate(roster) {
    var rows = roster.map(normalize);
    var counts = {};
    rows.forEach(function (p) { if (p.name) counts[p.name] = (counts[p.name] || 0) + 1; });
    var s = goodSettings();
    return rows.map(function (p) {
      if (isBlank(p)) return { blank: true, msgs: [] };
      var msgs = [];
      if (!p.name) msgs.push("이름을 넣어 주세요");
      else if (counts[p.name] > 1) msgs.push("같은 이름이 있습니다. " + p.name + "(1)처럼 구분해 주세요");
      if (!p.gender) msgs.push("성별을 골라 주세요");
      else if (GENDERS.indexOf(p.gender) < 0) msgs.push("'" + p.gender + "'는 쓸 수 없는 성별입니다 (남/여)");
      if (!p.grade) msgs.push("급수를 골라 주세요");
      else if (GRADES.indexOf(p.grade) < 0) msgs.push("'" + p.grade + "'는 쓸 수 없는 급수입니다 (A/B/C/D/초심)");
      var badA = p.arrival && Scheduler.parseHM(p.arrival) === null;
      var badL = p.leave && Scheduler.parseHM(p.leave) === null;
      if (badA) msgs.push(TIME_FORMAT_MSG.arrival);
      if (badL) msgs.push(TIME_FORMAT_MSG.leave);
      if (!badA && !badL && s && Scheduler.intervals([p], s).people[0].m <= 0) msgs.push(NO_SLOT_MSG);   // 4.1 참여 구간 확인
      return { blank: false, msgs: msgs };
    });
  }

  function choiceSelect(values, current, onChange) {
    var sel = el("select");
    sel.appendChild(el("option", { value: "", text: "고르기" }));
    values.forEach(function (v) { sel.appendChild(el("option", { value: v, text: v })); });
    if (current && values.indexOf(current) < 0) {
      // 정해진 값이 아닌 표기는 추측하지 않고 그대로 보여 준다
      sel.appendChild(el("option", { value: current, text: current + " ⚠" }));
    }
    sel.value = current || "";
    sel.addEventListener("change", function () { onChange(sel.value); });
    return sel;
  }

  // 4.1 풀다운 항목: 참가 = 시작 + i × 경기 시간 (2시간 이내, 마지막 시간대까지), 퇴장 = 종료 − i × 경기 시간 (2시간 이내, 첫 시간대 끝까지)
  function timeOptions(kind, s) {
    var S = Scheduler.slots(s).S, st = Scheduler.parseHM(s.start), en = Scheduler.parseHM(s.end), d = s.minutes;
    var out = [], i;
    if (kind === "arrival") {
      out.push({ value: "", text: s.start + "(정시)" });
      for (i = 1; i * d <= PICK_WINDOW_MIN && i < S; i++) out.push({ value: Scheduler.fmtHM(st + i * d), text: Scheduler.fmtHM(st + i * d) });
    } else {
      out.push({ value: "", text: s.end + "(끝까지)" });
      for (i = 1; i * d <= PICK_WINDOW_MIN && en - i * d >= st + d; i++) out.push({ value: Scheduler.fmtHM(en - i * d), text: Scheduler.fmtHM(en - i * d) });
    }
    return out;
  }

  // 참가·퇴장 시각 선택 상자. 항목에 없는 값은 버리거나 반올림하지 않고 끝에 덧붙여 선택해 둔다 (4.1)
  function timeSelect(kind, p, s, rowNo) {
    var sel = el("select", { class: "time", "aria-label": rowNo + "번째 줄 " + (kind === "arrival" ? "참가" : "퇴장") + " 시각" });
    var opts = timeOptions(kind, s);
    var v = p[kind] || "";
    var dflt = kind === "arrival" ? s.start : s.end;
    opts.forEach(function (o) { sel.appendChild(el("option", { value: o.value, text: o.text })); });
    var cur = v;
    if (v === "" || v === dflt) cur = "";
    else if (!opts.some(function (o) { return o.value === v; })) {
      var label = Scheduler.parseHM(v) === null ? v + " ⚠" : v + ((kind === "arrival" ? p.xa : p.xl) ? " (Excel 값)" : " (이전 값)");
      sel.appendChild(el("option", { value: v, text: label }));
    }
    sel.value = cur;
    sel.addEventListener("change", function () {
      p[kind] = sel.value;
      if (kind === "arrival") p.xa = false; else p.xl = false;
      refreshRosterChecks();
    });
    return sel;
  }

  function enterRoster() {
    if (readSettings().errors.length) { enterSettings(); return; }
    renderRoster();
    renderReplayNotice();
    $("run-status").hidden = true;
    show("roster");
  }

  function renderRoster() {
    var body = $("roster-body");
    clear(body);
    var s = goodSettings() || defaultSettings();
    state.roster.forEach(function (p, i) {
      var tr = el("tr");
      tr.appendChild(el("td", { class: "num", text: String(i + 1) }));
      var name = el("input", { type: "text", placeholder: "이름" });
      name.value = p.name || "";
      name.addEventListener("input", function () { p.name = name.value; refreshRosterChecks(); });
      tr.appendChild(el("td", null, [name]));
      var np = normalize(p);
      tr.appendChild(el("td", null, [choiceSelect(GENDERS, np.gender, function (v) { p.gender = v; refreshRosterChecks(); })]));
      tr.appendChild(el("td", null, [choiceSelect(GRADES, np.grade, function (v) { p.grade = v; refreshRosterChecks(); })]));
      tr.appendChild(el("td", null, [timeSelect("arrival", p, s, i + 1)]));
      tr.appendChild(el("td", null, [timeSelect("leave", p, s, i + 1)]));
      tr.appendChild(el("td", { class: "warn" }));
      var del = el("button", { type: "button", class: "subtle", text: "삭제", "aria-label": (i + 1) + "번째 줄 삭제" });
      del.addEventListener("click", function () { state.roster.splice(i, 1); renderRoster(); });
      tr.appendChild(el("td", null, [del]));
      body.appendChild(tr);
    });
    refreshRosterChecks();
  }

  function refreshRosterChecks() {
    var checks = validate(state.roster);
    var trs = $("roster-body").children;
    var warnCount = 0;
    checks.forEach(function (c, i) {
      var tr = trs[i];
      if (!tr) return;
      var cell = tr.children[6];
      cell.textContent = c.msgs.length ? "⚠ " + c.msgs.join(" / ") : (c.blank ? "(빈 줄)" : "");
      warnCount += c.msgs.length ? 1 : 0;
      var msgs = c.msgs.join(" ");
      tr.children[1].firstChild.classList.toggle("bad", /이름/.test(msgs));
      tr.children[2].firstChild.classList.toggle("bad", /성별/.test(msgs));
      tr.children[3].firstChild.classList.toggle("bad", /급수/.test(msgs));
      tr.children[4].firstChild.classList.toggle("bad", /참가/.test(msgs));
      tr.children[5].firstChild.classList.toggle("bad", /퇴장/.test(msgs));
    });

    var players = state.roster.map(normalize).filter(function (p, i) { return !checks[i].blank; });
    renderSummary(players, warnCount);

    var reasons = [];
    if (warnCount > 0) reasons.push("⚠ 표시가 " + warnCount + "줄 있습니다. 고친 뒤 대진을 만들 수 있습니다.");
    if (players.length < MIN_PLAYERS) reasons.push("8명 이상이어야 합니다 (지금 " + players.length + "명).");
    var seed = $("set-seed").value.trim();
    if (seed && !/^\d{6}$/.test(seed)) reasons.push("대진 번호는 6자리 숫자입니다 (비우면 새 번호).");
    $("roster-run").disabled = reasons.length > 0 || !!state.running;
    $("roster-block").textContent = reasons.join(" ");
    renderPreview(warnCount === 0 && players.length >= MIN_PLAYERS ? players : null);
    refreshSteps();
  }

  function renderSummary(players, warnCount) {
    var box = $("roster-summary");
    clear(box);
    var men = players.filter(function (p) { return p.gender === "남"; }).length;
    var women = players.filter(function (p) { return p.gender === "여"; }).length;
    var s = goodSettings();
    var late = 0, early = 0;
    if (s) {
      var ok = players.filter(function (p) { return (!p.arrival || Scheduler.parseHM(p.arrival) !== null) && (!p.leave || Scheduler.parseHM(p.leave) !== null); });
      Scheduler.intervals(ok, s).people.forEach(function (x) { if (x.late) late++; if (x.early) early++; });
    }
    box.appendChild(el("p", null, [
      el("b", { text: "인원 " + players.length + "명" }),
      " · 남 " + men + " / 여 " + women + " · 늦게 오는 사람 " + late + "명 · 일찍 가는 사람 " + early + "명" + (warnCount ? " · ⚠ " + warnCount + "줄" : "")
    ]));
    var t = el("table");
    var head = el("tr", null, [el("th", { text: "급수" })]);
    var rowM = el("tr", null, [el("th", { text: "남" })]);
    var rowW = el("tr", null, [el("th", { text: "여" })]);
    GRADES.forEach(function (g) {
      head.appendChild(el("th", { text: g }));
      rowM.appendChild(el("td", { text: String(players.filter(function (p) { return p.gender === "남" && p.grade === g; }).length) }));
      rowW.appendChild(el("td", { text: String(players.filter(function (p) { return p.gender === "여" && p.grade === g; }).length) }));
    });
    t.appendChild(head); t.appendChild(rowM); t.appendChild(rowW);
    box.appendChild(el("div", { class: "table-wrap" }, [t]));
  }

  function lastEndText(s, loads) {
    var last = -1;
    loads.forEach(function (k, t) { if (k > 0) last = t; });
    return last >= 0 ? Scheduler.slotTime(s.start, s.minutes, last + 1) : null;
  }

  function intervalLabel(s, f, l) {
    return Scheduler.slotTime(s.start, s.minutes, f) + "–" + Scheduler.slotTime(s.start, s.minutes, l + 1);
  }

  // 빈 코트가 생기는 이유 (계산으로 정해지는 것만)
  function emptyReasons(pl, s) {
    var ub = pl.ub, out = [];
    if (ub.byH < ub.full && ub.byH === ub.M) {
      out.push(s.maxGames ? "1인당 최대 경기 수 " + s.maxGames + "경기 때문에 전원이 뛰어도 " + ub.byH + "경기까지입니다"
        : "참여 시간대가 짧은 사람이 많아 " + ub.byH + "경기까지입니다");
    }
    if (ub.bySlot < ub.full) out.push("와 있는 사람이 적은 시간대는 코트를 다 채울 수 없습니다");
    if (ub.byWindow < ub.bySlot) out.push("3연속 경기 금지 때문에 세 시간대를 연달아 꽉 채울 수 없습니다 (한 사람은 세 시간대 중 최대 2경기)");
    if (pl.parityDrops.length) out.push("남자·여자 출전 합을 짝수로 맞추려고 " + pl.parityDrops.join("·") + "경기를 건너뛰었습니다");
    return out;
  }

  // 5.1 ② 명단 화면의 예상 정보 (생성 전, 6.4–6.5 계산값)
  function renderPreview(players) {
    var box = $("roster-preview");
    clear(box);
    var s = goodSettings();
    if (!players || !s) {
      box.appendChild(el("p", { class: "hint", text: "명단을 완성하면(8명 이상, ⚠ 0개) 예상 경기 수를 보여 드립니다." }));
      return;
    }
    var roster = Scheduler.sortRoster(players);
    var seedTxt = $("set-seed").value.trim();
    var pl = Scheduler.plan(roster, s, /^\d{6}$/.test(seedTxt) ? parseInt(seedTxt, 10) : 0);
    var S = pl.iv.S;
    box.appendChild(el("p", null, [el("b", { text: "예상 (대진을 만들기 전 계산)" })]));
    if (pl.M <= 0) {
      box.appendChild(el("p", { text: "이 명단·설정으로는 만들 수 있는 경기가 없습니다." }));
      emptyReasons(pl, s).forEach(function (r) { box.appendChild(el("p", { class: "hint", text: "· " + r })); });
      return;
    }
    var empty = s.courts * S - pl.M;
    var items = [
      ["예상 총 경기 수", pl.M + "경기 (최대 " + (s.courts * S) + "경기 중, 빈 코트 " + empty + "칸)"],
      ["시간대별 경기 수", pl.loads.join(" / ")],
      ["1인당 경기 수", distText(pl.quota.target)]
    ];
    var end = lastEndText(s, pl.loads);
    if (end && end !== Scheduler.slotTime(s.start, s.minutes, S)) items.push(["실제 마지막 경기 종료", end]);
    var t = el("table", { class: "preview-table" });
    items.forEach(function (it) { t.appendChild(el("tr", null, [el("th", { text: it[0] }), el("td", { class: "left", text: it[1] })])); });
    box.appendChild(el("div", { class: "table-wrap" }, [t]));

    // 참여 구간별 몫
    var groups = {}, order = [];
    pl.iv.people.forEach(function (p) {
      var k = p.f + "-" + p.l;
      if (!groups[k]) { groups[k] = { f: p.f, l: p.l, m: p.m, q: pl.quota.q[p.index], g: [] }; order.push(k); }
      groups[k].g.push(pl.quota.target[p.index]);
    });
    order.sort(function (a, b) { return (groups[a].f - groups[b].f) || (groups[b].l - groups[a].l); });
    var gt = el("table", { class: "preview-table" });
    gt.appendChild(el("tr", null, ["참여 구간", "시간대", "인원", "몫", "경기 수"].map(function (h) { return el("th", { text: h }); })));
    order.forEach(function (k) {
      var g = groups[k];
      gt.appendChild(el("tr", null, [intervalLabel(s, g.f, g.l), g.m + "개", g.g.length + "명", g.q.toFixed(2), distText(g.g)].map(function (v) { return el("td", { text: String(v) }); })));
    });
    box.appendChild(el("p", { class: "hint", text: "참여 구간별 몫 = 출전 자리(4 × 경기 수)를 참여 시간대 수에 비례해 나눈 값" }));
    box.appendChild(el("div", { class: "table-wrap" }, [gt]));

    var why = emptyReasons(pl, s);
    if (empty > 0 && why.length) {
      box.appendChild(el("p", { text: "빈 코트가 생기는 이유:" }));
      why.forEach(function (r) { box.appendChild(el("p", { class: "hint", text: "· " + r })); });
    }
    if (Scheduler.needsDoubles(pl.iv, pl.quota.target, pl.loads).length) {
      box.appendChild(el("p", { class: "late-line", text: "코트를 모두 채우려면 일부 참가자가 2연속 경기를 합니다." }));
    }
    var zero = pl.iv.people.filter(function (p) { return pl.quota.q[p.index] < 1; }).map(function (p) { return roster[p.index].name; });
    if (zero.length) box.appendChild(el("p", { class: "late-line", text: zero.join(", ") + " 님은 참여 시간이 짧아 경기가 없을 수 있습니다." }));
    box.appendChild(el("p", { class: "hint", text: "실제 대진이 이 값과 다르면 결과 화면에 그 이유를 보여 드립니다." }));
  }

  // ── 지난 명단 + 설정 (3절: 이 기기 안에 하나만) ─────────────
  function loadLast() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ok: true, data: null };
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.roster)) return { ok: true, data: null };
      return { ok: true, data: data };
    } catch (e) {
      return { ok: false, data: null };
    }
  }

  function saveLast(players, s) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        savedAt: todayStr(),
        roster: players.map(function (p) { return { name: p.name, gender: p.gender, grade: p.grade, arrival: p.arrival, leave: p.leave }; }),
        settings: { start: s.start, end: s.end, minutes: s.minutes, courts: s.courts, maxGames: s.maxGames }
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── 오늘 대진 (plan_w7.md 2.2: 이름으로 저장, 재편성 회차마다 직전 바탕을 함께) ─────
  function loadToday() {
    try {
      var raw = window.localStorage.getItem(TODAY_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || d.format !== TODAY_FORMAT || !d.current || !Array.isArray(d.current.rows) || !Array.isArray(d.rounds)) return null;
      return d;
    } catch (e) {
      return null;
    }
  }

  function saveToday(d) {
    state.today = d;
    try {
      d.savedAt = new Date().toISOString();
      window.localStorage.setItem(TODAY_KEY, JSON.stringify(d));
      return true;
    } catch (e) {
      return false;
    }
  }

  function todayData() { return state.today || loadToday(); }

  function plainRoster(roster) {
    return roster.map(function (p) { return { name: p.name, gender: p.gender, grade: p.grade, arrival: p.arrival || "", leave: p.leave || "" }; });
  }

  function plainRows(rows) {
    return rows.map(function (r) { return { slot: r.slot, court: r.court, type: r.type, t1: r.t1.slice(), t2: r.t2.slice() }; });
  }

  // 결과(state.result)를 저장할 수 있는 모양으로
  function currentOf(R) {
    return { seed: R.seed, version: R.version, roster: plainRoster(R.roster), rows: plainRows(R.rows), meta: R.meta };
  }

  function renderHome() {
    var td = loadToday();
    var tb = $("home-today");
    if (td && td.date === todayStr()) {
      tb.hidden = false;
      $("home-today-hint").hidden = false;
      $("home-today-hint").textContent = "오늘 대진: 대진 번호 " + td.current.seed + " · " + td.current.roster.length + "명" +
        (td.rounds.length ? " · 진행 중 변경 " + td.rounds.length + "회" : "");
    } else {
      tb.hidden = true;
      $("home-today-hint").hidden = true;
    }
    var last = loadLast();
    var btn = $("home-last");
    if (!last.ok) {
      btn.disabled = true;
      $("home-last-hint").textContent = "이 브라우저에서는 기억할 수 없음 (지난 명단을 저장하지 못합니다).";
    } else if (!last.data) {
      btn.disabled = true;
      $("home-last-hint").textContent = "아직 기억해 둔 명단이 없습니다.";
    } else {
      btn.disabled = false;
      $("home-last-hint").textContent = "지난 명단: " + last.data.roster.length + "명 (" + last.data.savedAt + " 저장)" + (last.data.settings ? " · 지난 설정도 함께 불러옵니다" : "");
    }
  }

  // ── Excel 불러오기 (4절) ─────────────────────────────────
  function cellText(v) {
    if (v == null) return "";
    if (typeof v === "object") {
      if (Array.isArray(v.richText)) return v.richText.map(function (r) { return r.text; }).join("");
      if ("result" in v) return cellText(v.result);
      if ("text" in v) return cellText(v.text);
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return "";
    }
    return String(v);
  }

  function colLetter(i) {   // 1 → A
    var s = "";
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  /*
   * 4.2 시각 칸 → 글자. Excel 시각 셀(ExcelJS가 1899-12-30·31 날짜로 줌)은 "HH:MM"으로 바꾼다.
   * 초가 있으면 "HH:MM:SS", 날짜가 붙은 값은 "YYYY-MM-DD HH:MM"으로 그대로 보여 ⚠를 붙이게 한다 (추측하지 않음)
   */
  function timeText(v) {
    if (v instanceof Date) {
      var d = new Date(Math.round(v.getTime() / 1000) * 1000);   // 소수 오차로 19:29:59.999가 되는 것만 바로잡음
      var hms = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + (d.getUTCSeconds() ? ":" + pad2(d.getUTCSeconds()) : "");
      if (d.getUTCFullYear() === 1899 && d.getUTCMonth() === 11 && d.getUTCDate() >= 30) return hms;
      return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate()) + " " + hms;
    }
    if (v && typeof v === "object" && "result" in v) return timeText(v.result);
    return cellText(v).trim();
  }

  var pendingSheet = null;   // 열을 고르는 동안 들고 있는 표 [[...], ...]
  var pendingRaw = null;     // 같은 표의 셀 값 그대로 (시각 셀용)

  function readExcel(file) {
    $("excel-error").textContent = "";
    $("column-picker").hidden = true;
    if (typeof ExcelJS === "undefined") {
      $("excel-error").textContent = "Excel 기능을 불러오지 못했습니다. lib 폴더가 index.html 옆에 있는지 확인해 주세요.";
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { $("excel-error").textContent = "파일을 읽지 못했습니다."; };
    reader.onload = function () {
      var wb = new ExcelJS.Workbook();
      wb.xlsx.load(reader.result).then(function () {
        var ws = wb.worksheets[0];
        if (!ws) throw new Error("시트가 없습니다.");
        var table = [], raw = [];
        var width = ws.columnCount;
        ws.eachRow({ includeEmpty: true }, function (row, r) {
          var vals = [], raws = [];
          for (var c = 1; c <= width; c++) {
            var v = row.getCell(c).value;
            vals.push(cellText(v).trim());
            raws.push(v);
          }
          table[r - 1] = vals;
          raw[r - 1] = raws;
        });
        for (var i = 0; i < table.length; i++) if (!table[i]) { table[i] = []; raw[i] = []; }
        if (!table.length) throw new Error("빈 시트입니다.");
        state.fileSettings = readFileSettings(wb);
        pendingSheet = table;
        pendingRaw = raw;
        var header = table[0];
        var found = {};
        Object.keys(COLUMN_ALIASES).forEach(function (k) {
          for (var j = 0; j < COLUMN_ALIASES[k].length; j++) {
            var idx = header.indexOf(COLUMN_ALIASES[k][j]);
            if (idx >= 0) { found[k] = idx; break; }
          }
        });
        [["arrival", ARRIVAL_ALIASES], ["leave", LEAVE_ALIASES]].forEach(function (x) {
          for (var a = 0; a < x[1].length; a++) {
            var ai = header.indexOf(x[1][a]);
            if (ai >= 0) { found[x[0]] = ai; break; }
          }
        });
        if ("name" in found && "gender" in found && "grade" in found) applySheet(found);
        else showColumnPicker(header, found);
      }).catch(function (e) {
        $("excel-error").textContent = "Excel 파일을 읽지 못했습니다 (.xlsx 파일인지 확인해 주세요). " + (e && e.message ? e.message : "");
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function showColumnPicker(header, found) {
    ["name", "gender", "grade", "arrival", "leave"].forEach(function (k) {
      var sel = $("pick-" + k);
      clear(sel);
      sel.appendChild(el("option", { value: "", text: k === "arrival" ? "없음 (모두 정시)" : k === "leave" ? "없음 (모두 끝까지)" : "고르기" }));
      header.forEach(function (h, i) {
        sel.appendChild(el("option", { value: String(i), text: colLetter(i + 1) + "열" + (h ? ": " + h : "") }));
      });
      sel.value = k in found ? String(found[k]) : "";
    });
    $("column-picker").hidden = false;
  }

  function applySheet(cols) {
    var rows = pendingSheet.slice(1).map(function (r, i) {
      var a = cols.arrival != null ? timeText(pendingRaw[i + 1][cols.arrival]) : "";
      var l = cols.leave != null ? timeText(pendingRaw[i + 1][cols.leave]) : "";
      return { name: r[cols.name] || "", gender: r[cols.gender] || "", grade: r[cols.grade] || "", arrival: a, leave: l, xa: !!a, xl: !!l };
    }).filter(function (p) { return !isBlank(normalize(p)); });
    if (validPlayers().length && !window.confirm("지금 표에 있는 명단을 지우고 Excel 명단(" + rows.length + "명)으로 바꿀까요?")) return;
    state.roster = rows;
    $("column-picker").hidden = true;
    pendingSheet = null;
    pendingRaw = null;
    applyFileSettings();
    renderRoster();
    renderReplayNotice();
  }

  // 이 앱이 저장한 Excel이면 '대진표 생성 기준' 시트에서 설정·대진 번호·앱 버전을 읽는다
  function readFileSettings(wb) {
    var ws = wb.getWorksheet("대진표 생성 기준");
    if (!ws) return null;
    var map = {};
    ws.eachRow(function (row) {
      var key = cellText(row.getCell(2).value).trim();
      if (key) map[key] = cellText(row.getCell(3).value).trim();
    });
    if (!map["앱 버전"]) return null;
    return {
      version: map["앱 버전"], seed: map["대진 번호"] || "", date: map["날짜"] || "", start: map["시작 시각"] || "",
      end: map["종료 시각"] || "", minutes: map["경기 시간(분)"] || "", courts: map["코트 수"] || "",
      maxGames: map["1인당 최대 경기 수"] || "", slots: map["시간대 수"] || "",
      M: map["총 경기 수"] || "", upper: map["상한"] || "",                 // 7절 다시 보기 판정 (plan_w7b 3.1)
      rest: !!wb.getWorksheet("재편성 기록"), firstSeed: map["처음 대진 번호"] || ""   // 재편성 결과 파일 (Q6)
    };
  }

  /*
   * 7절: 불러온 파일의 설정을 ① 설정에 채운다. 같은 앱 버전이면 대진 번호도 채운다.
   * 1.x 파일은 종료 시각이 없으므로 시작 + 시간대 수 × 경기 시간으로 채우고, 대진 번호는 채우지 않는다 (명단·설정만)
   */
  function applyFileSettings() {
    var fs = state.fileSettings;
    state.fileNotice = [];
    if (!fs) return;
    var s = Object.assign({}, goodSettings() || state.settings || defaultSettings());
    var hm = function (v) { return /^\d{1,2}:\d{2}$/.test(v) ? pad2(parseInt(v, 10)) + v.slice(v.indexOf(":")) : null; };
    if (/^\d{4}-\d{2}-\d{2}$/.test(fs.date)) s.date = fs.date;
    if (hm(fs.start)) s.start = hm(fs.start);
    if (/^\d+$/.test(fs.minutes)) s.minutes = parseInt(fs.minutes, 10);
    if (/^\d+$/.test(fs.courts)) s.courts = parseInt(fs.courts, 10);
    // 2.0.0·2.1.0 파일은 경기 수를 줄이지 않았으면(총 경기 수 = 상한) 2.2.0에서도 같은 대진 (plan_w7b 3.1).
    // 재편성 결과 파일은 번호로 다시 만들 수 없다 (plan_w7 Q6)
    var sameRule = Scheduler.REPLAY_VERSIONS.indexOf(fs.version) >= 0;
    var same = !fs.rest && Scheduler.replaySame(fs.version, fs.M, fs.upper);
    var v1 = /^1\./.test(fs.version);
    if (hm(fs.end)) s.end = hm(fs.end);
    else if (v1 && /^\d+$/.test(fs.slots)) s.end = Scheduler.slotTime(s.start, s.minutes, parseInt(fs.slots, 10));
    s.maxGames = /^\d+$/.test(fs.maxGames) ? parseInt(fs.maxGames, 10) : null;
    fillSettingsInputs(s);
    state.settings = s;
    if (same && /^\d{6}$/.test(fs.seed)) $("set-seed").value = fs.seed;
    // 같은 대진이 나오지 않는 파일(재편성·경기 수를 줄인 2.x·1.x): 앞의 번호가 남아 다른 대진이 만들어지지 않게 비운다 (Q6, W7 결함 1, plan_w7b 3.1)
    else $("set-seed").value = "";
    state.fileNotice.push("불러온 파일의 설정(" + s.start + "–" + s.end + ", " + s.minutes + "분, " + s.courts + "면" +
      (s.maxGames ? ", 1인당 최대 " + s.maxGames + "경기" : "") + ")을 ① 설정에 채웠습니다." +
      (same && /^\d{6}$/.test(fs.seed) ? " 대진 번호 " + fs.seed + "도 채웠습니다." : ""));
    if (fs.rest) {
      state.fileNotice.push("⚠ 진행 중에 바꾼 대진은 파일로 다시 만들 수 없습니다(대진을 만든 기기에서만 이어서 바꿀 수 있습니다). 명단과 설정만 불러왔습니다." +
        (/^\d{6}$/.test(fs.firstSeed) ? " 처음 대진은 대진 번호 " + fs.firstSeed + "로 다시 볼 수 있습니다" +
          (fs.version !== Scheduler.SCHEDULER_VERSION ? "(앱 버전이 바뀌어 다를 수 있음)." : ".") : ""));
    } else if (same && fs.version !== Scheduler.SCHEDULER_VERSION) {
      state.fileNotice.push("이 파일은 앱 버전 " + fs.version + "으로 만들었습니다. " + Scheduler.SCHEDULER_VERSION + "은 코트를 다 채우지 못할 때만 다르게 만들므로 이 대진은 같게 나옵니다.");
    } else if (sameRule) {
      state.fileNotice.push("⚠ 이 파일은 앱 버전 " + fs.version + "으로 만들었습니다. " + Scheduler.SCHEDULER_VERSION + "은 코트를 더 채우도록 바뀌어 같은 대진이 나오지 않을 수 있습니다. 명단과 설정만 불러왔습니다.");
    } else if (!same) {
      state.fileNotice.push("⚠ 이 파일은 앱 버전 " + fs.version + "로 만들었고 지금은 " + Scheduler.SCHEDULER_VERSION + "입니다. 앱 버전이 달라 같은 대진이 나오지 않습니다. 명단과 설정만 불러왔습니다.");
    }
    state.fileSettings = null;   // 한 번만 채운다
  }

  function renderReplayNotice() {
    var box = $("replay-notice");
    clear(box);
    var lines = [];
    if (state.replaySeed) lines.push("대진 번호 " + state.replaySeed + "로 다시 봅니다. 그날의 명단을 지난 명단 또는 Excel 불러오기로 넣어 주세요.");
    lines = lines.concat(state.fileNotice || []);
    lines.forEach(function (t) { box.appendChild(el("p", { text: t })); });
    if (state.replaySeed) {
      var last = loadLast();
      if (last.data) {
        var b = el("button", { type: "button", text: "지난 명단 불러오기 (" + last.data.roster.length + "명)" });
        b.addEventListener("click", function () {
          if (validPlayers().length && !window.confirm("지금 표의 명단을 지난 명단으로 바꿀까요?")) return;
          state.roster = last.data.roster.map(normalize);
          renderRoster();
        });
        box.appendChild(b);
      }
    }
    box.hidden = lines.length === 0;
  }

  function setMethod(method) {
    document.querySelectorAll("[data-method]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-method") === method);
    });
    $("method-excel").hidden = method !== "excel";
  }

  // 첫 화면에서 시작: 설정 → 명단 순서 (8절)
  function startNew(roster, settings, seed) {
    state.roster = roster;
    state.settings = settings ? Object.assign(defaultSettings(), settings, { date: todayStr() }) : null;
    state.fileSettings = null;
    state.fileNotice = [];
    state.result = null;
    $("set-seed").value = seed || "";
    setMethod("direct");
    enterSettings();
  }

  // ── 대진 만들기 ─────────────────────────────────────────
  function newSeed() {
    var a = new Uint32Array(1);
    window.crypto.getRandomValues(a);
    return String(100000 + (a[0] % 900000));
  }

  function runGenerate(forceNewSeed) {
    var rs = readSettings();
    if (rs.errors.length) { enterSettings(); return; }
    if (!rosterStatus().ok) { enterRoster(); return; }
    // Q1 (검토 반영): 오늘 대진에 진행 중 변경이 있으면 덮어쓰기 전에 묻는다 (생성 전에)
    var td = todayData();
    if (td && td.rounds.length &&
        !window.confirm("오늘 대진에 진행 중 변경이 " + td.rounds.length + "회 있습니다. 새 대진을 만들면 그 기록이 지워집니다. 새로 만들까요?")) return;
    var s = rs.s;
    var players = validPlayers();
    var roster = Scheduler.sortRoster(players);   // 7절: 입력 순서와 관계없이 같은 대진
    var seed = $("set-seed").value.trim();
    if (forceNewSeed || !/^\d{6}$/.test(seed)) seed = newSeed();
    $("set-seed").value = seed;
    state.settings = s;
    var saved = saveLast(players, s);

    var search = Scheduler.createSearch(roster, s, parseInt(seed, 10));
    var run = state.running = { cancelled: false };
    $("run-fail").hidden = true;
    $("run-status").hidden = false;
    $("roster-run").disabled = true;
    $("run-text").textContent = "대진을 찾는 중입니다… (대진 번호 " + seed + ")";
    $("run-progress").value = 0;
    $("roster-block").textContent = saved ? "" : "이 브라우저에서는 기억할 수 없음 (지난 명단을 저장하지 못했습니다).";

    function tick() {
      if (run.cancelled) return finish(null);
      var st = search.step(STEP_BUDGET_MS);
      var pct = Math.max(st.found / Scheduler.SOLUTIONS_TO_COMPARE, st.tries / st.maxTries) * 100;
      $("run-progress").value = Math.min(100, pct);
      $("run-text").textContent = "대진을 찾는 중입니다… " + st.M + "경기로 시도" + (st.relaxing ? "(2연속 차이를 허용해 다시)" : "") + " · 조건에 맞는 대진 " + st.found + "/" + Scheduler.SOLUTIONS_TO_COMPARE +
        "개 · 시도 " + st.tries + "회 (대진 번호 " + seed + ")";
      if (st.done) finish(search.result());
      else setTimeout(tick, 0);
    }

    function finish(res) {
      state.running = null;
      $("run-status").hidden = true;
      refreshRosterChecks();
      if (!res) return;
      if (!res.ok) return showFailure(res, roster, s, seed);
      buildResult(res, roster, s, seed);
      // 오늘 대진으로 저장 (재편성 기록은 지움, Q1)
      saveToday({ format: TODAY_FORMAT, appVersion: Scheduler.SCHEDULER_VERSION, date: s.date,
        settings: { start: s.start, end: s.end, minutes: s.minutes, courts: s.courts, maxGames: s.maxGames },
        current: currentOf(state.result), rounds: [] });
      show("result");
    }

    if (currentView !== "roster") show("roster");   // 진행 상황은 ② 화면에 보인다
    else refreshSteps();
    setTimeout(tick, 0);
  }

  // 안내 내용은 advice.js가 고른다 (생성 코드와 분리)
  function showFailure(res, roster, s, seed) {
    var adv = Advice.forFailure(roster, Object.assign({ seed: seed }, s), res);
    var box = $("run-fail");
    clear(box);
    box.appendChild(el("b", { text: adv.title }));
    box.appendChild(el("p", { text: adv.intro.text }));
    var ul = el("ul");
    adv.items.forEach(function (it) { ul.appendChild(el("li", { "data-kind": it.kind, text: it.text })); });
    box.appendChild(el("p", { text: "바꿔 볼 항목:" }));
    box.appendChild(ul);
    if (adv.offerNewSeed) {
      var again = el("button", { type: "button", id: "fail-new-seed", text: "새 번호로 다시 만들기" });
      again.addEventListener("click", function () { runGenerate(true); });
      box.appendChild(el("div", { class: "row" }, [again]));
    }
    box.hidden = false;
  }

  // ── 결과 (8절 ③) ───────────────────────────────────────
  // 화면과 이미지에서만 혼복 팀은 남자를 먼저 보인다. t1·t2(생성 순서)는 그대로 두고 Excel·자기 점검은 그것을 쓴다
  function shownTeam(team, type, genderOf) {
    if (type !== "혼복" || genderOf[team[0]] === "남") return team.slice();
    return [team[1], team[0]];
  }

  // 생성 결과(번호) → 저장·표시용 이름 행
  function nameRows(matches, roster) {
    return matches.map(function (m) {
      return { slot: m.slot, court: m.court, type: m.type, t1: m.t1.map(function (p) { return roster[p].name; }), t2: m.t2.map(function (p) { return roster[p].name; }) };
    });
  }

  function byNameMap(roster, arr) {
    var o = {};
    roster.forEach(function (p, i) { o[p.name] = arr[i]; });
    return o;
  }

  function textRows(rows, s) {
    return rows.map(function (r, i) {
      return { no: i + 1, time: Scheduler.slotTime(s.start, s.minutes, r.slot), court: r.court, t1: r.t1, t2: r.t2, type: r.type };
    });
  }

  function buildResult(res, roster, s, seed) {
    var meta = { M: res.M, upper: res.upper, ub: res.ub, reductions: res.reductions, repeatOpp: res.repeatOpp, found: res.found, tries: res.tries,
      q: byNameMap(roster, res.q), target: byNameMap(roster, res.target),
      relaxed: res.relaxed, gap: res.gap, phase: res.phase, relaxTries: res.relaxTries };
    state.result = makeResult({ settings: s, seed: seed, version: res.version, roster: roster, rows: nameRows(res.matches, roster), meta: meta });
    renderResult();
  }

  /*
   * 저장된 값(이름 행)으로 결과를 만든다. 새로 만든 대진·재편성·"오늘 대진 이어서" 모두 이 함수를 지난다 (6.8.1: 바탕은 값 자체).
   * o: {settings, seed, version, roster, rows: [{slot, court, type, t1, t2}], meta, rest: null | {n, T, baseSeed, baseRows, history}}
   */
  function makeResult(o) {
    var s = o.settings, roster = o.roster, meta = o.meta || {};
    var score = Scheduler.GRADE_SCORE;
    var genderOf = {}, gradeOf = {};
    roster.forEach(function (p) { genderOf[p.name] = p.gender; gradeOf[p.name] = p.grade; });
    var sorted = o.rows.slice().sort(function (a, b) { return (a.slot - b.slot) || (a.court - b.court); });
    var rows = sorted.map(function (m, i) {
      var s1 = m.t1.reduce(function (a, p) { return a + score[gradeOf[p]]; }, 0);
      var s2 = m.t2.reduce(function (a, p) { return a + score[gradeOf[p]]; }, 0);
      return { no: i + 1, slot: m.slot, time: Scheduler.slotTime(s.start, s.minutes, m.slot), court: m.court,
        t1: m.t1.slice(), t2: m.t2.slice(), type: m.type, s1: s1, s2: s2,
        show1: shownTeam(m.t1, m.type, genderOf), show2: shownTeam(m.t2, m.type, genderOf) };   // 화면·이미지용
    });
    var S = Scheduler.slots(s).S;
    var loads = [];
    for (var t = 0; t < S; t++) loads.push(0);
    var games = {}, slotsOf = {};
    roster.forEach(function (p) { games[p.name] = 0; slotsOf[p.name] = {}; });
    rows.forEach(function (r) { loads[r.slot] += 1; r.t1.concat(r.t2).forEach(function (p) { games[p] += 1; slotsOf[p][r.slot] = true; }); });
    var iv = Scheduler.intervals(roster, s);
    var rest = o.rest || null, rm = meta.rest || null;
    function dbl(name, from) {
      var k = 0;
      for (var t2 = from; t2 < S - 1; t2++) if (slotsOf[name][t2] && slotsOf[name][t2 + 1]) k++;
      return k;
    }
    var people = roster.map(function (p, i) {
      var x = iv.people[i];
      var o2 = { name: p.name, gender: p.gender, grade: p.grade, arrival: p.arrival, leave: p.leave,
        arrivalShown: p.arrival || s.start, leaveShown: p.leave || s.end,
        f: x.f, l: x.l, m: x.m, late: x.late, early: x.early, q: (meta.q || {})[p.name], target: (meta.target || {})[p.name],
        games: games[p.name], doubles: dbl(p.name, 0), slots: slotsOf[p.name] };
      if (rest && rm) {
        o2.change = rm.changeOf[p.name] || "same";
        o2.g0 = rm.g0[p.name]; o2.rho = rm.rho[p.name]; o2.r = rm.r[p.name];
        o2.restDoubles = dbl(p.name, rest.T);
        o2.q = o2.g0 + o2.rho;            // 하루 몫 = 지금까지 + 남은 몫
        o2.target = o2.g0 + o2.r;
      }
      return o2;
    });
    var byName = {};
    people.forEach(function (p) { byName[p.name] = p; });
    // relaxed: 생성 코드가 ②에서 ⓗ(ⓗ′)를 완화했다는 기록 — 자기 점검은 차이 2 이상을 위반 대신 참고로 (plan_w7b 2.4)
    var opts = { start: s.start, end: s.end, minutes: s.minutes, courts: s.courts, maxGames: s.maxGames, relaxed: !!meta.relaxed };
    var dayDoubles = people.reduce(function (a, p) { return a + p.doubles; }, 0);
    var R = {
      settings: s,
      seed: o.seed,
      version: o.version,
      roster: roster,
      people: people,
      byName: byName,
      rows: rows,
      games: games,
      S: S,
      M: meta.M,
      upper: meta.upper,
      ub: meta.ub,
      loads: loads,
      reductions: meta.reductions || [],
      totalDoubles: rest ? people.reduce(function (a, p) { return a + p.restDoubles; }, 0) : dayDoubles,
      dayDoubles: dayDoubles,
      repeatOpp: meta.repeatOpp,
      found: meta.found,
      tries: meta.tries,
      meta: meta,
      rest: rest,
      lateCount: people.filter(function (p) { return p.late; }).length,
      earlyCount: people.filter(function (p) { return p.early; }).length,
      lastEnd: lastEndText(s, loads),
      check: rest ? Checker.checkRest(roster, textRows(rest.baseRows, s), textRows(rows, s), opts, rest.T) : Checker.check(roster, rows, opts),
      snapshot: snapshot(roster, s, o.seed)          // 나중에 명단·설정이 바뀌었는지 비교
    };
    return R;
  }

  function summaryText(R) {
    var s = R.settings;
    if (R.rest) {
      return R.roster.length + "명 · " + s.courts + "면 · 하루 " + R.rows.length + "경기(남은 " + R.M + "경기) · 빈 코트 " + (s.courts * R.S - R.rows.length) +
        " · 남은 2연속 " + R.totalDoubles + "회";
    }
    return R.roster.length + "명 · " + s.courts + "면 · " + R.rows.length + "경기 · 빈 코트 " + (s.courts * R.S - R.rows.length) +
      " · 2연속 " + R.totalDoubles + "회" + (R.lateCount ? " · 늦게 옴 " + R.lateCount + "명" : "") + (R.earlyCount ? " · 일찍 감 " + R.earlyCount + "명" : "");
  }

  // "재편성 N회 · HH:MM 기준" (8.1 결과)
  function restLine(R) {
    var s = R.settings;
    return "재편성 " + R.rest.n + "회 · " + Scheduler.slotTime(s.start, s.minutes, R.rest.T) + " 기준";
  }

  // R1 설명 (Q7 검토 반영: 실패 안내가 아니라 미리보기·결과 화면의 설명)
  function boundaryNoteText(note, s) {
    if (!note) return "";
    return Scheduler.slotTime(s.start, s.minutes, note.slot) + "에는 " + (note.games ? note.games + "경기만" : "경기를 하지 않고") +
      " 합니다. 방금 두 경기를 이어서 한 " + note.rested + "명은 쉬어야 합니다.";
  }

  function renderResult() {
    var R = state.result;
    var s = R.settings;
    var meta = $("result-meta");
    clear(meta);
    var endFull = Scheduler.slotTime(s.start, s.minutes, R.S);
    [["날짜", dateLabel(s.date)], ["대진 번호", R.seed], ["앱 버전", R.version],
     ["시간", s.start + " ~ " + endFull + (R.lastEnd && R.lastEnd !== endFull ? " (실제 마지막 경기 종료 " + R.lastEnd + ")" : "")]].forEach(function (x) {
      meta.appendChild(el("span", null, [x[0] + " ", el("b", { text: String(x[1]) })]));
    });
    var ri = $("result-rest-info");
    clear(ri);
    if (R.rest) {
      ri.appendChild(el("p", null, [el("b", { text: restLine(R) }), " · 대진 번호 " + R.seed + " (바탕 " + R.rest.baseSeed + ")"]));
      ri.appendChild(el("p", { class: "hint", text: "회색 시간대는 이미 진행된 경기입니다(대진표대로 한 것으로 봅니다). 그 뒤 시간대를 다시 짰습니다." }));
      var nt = boundaryNoteText(R.meta.rest.note, s);
      if (nt) ri.appendChild(el("p", { class: "late-line", text: nt }));
    }
    ri.hidden = !R.rest;
    $("result-summary").textContent = summaryText(R);

    // 6.6 M 줄임 · 계산으로 정해진 빈 코트 이유
    var red = $("result-reduced");
    clear(red);
    var full = s.courts * R.S;
    var empty = full - R.rows.length;
    if (R.rest) {
      if (R.M < R.upper) {
        red.appendChild(el("p", null, [el("b", { text: "남은 시간을 모두 채우는 대진을 찾지 못해 남은 경기를 " + R.M + "경기로 만들었습니다(계산한 최대 " + R.upper + "경기)." })]));
      }
    } else if (R.M < R.upper) {
      var why = R.reductions.map(function (r) { return r.reason; });
      red.appendChild(el("p", null, [el("b", { text: "코트를 모두 채우는 대진을 찾지 못해 " + R.M + "경기로 만들었습니다(빈 코트 " + empty + "칸)." })]));
      red.appendChild(el("p", { class: "hint", text: "계산한 최대 " + R.upper + "경기에서 줄인 이유: " +
        (why.indexOf("search") >= 0 ? "규칙을 모두 지키는 대진을 찾지 못함" : "") +
        (why.indexOf("search") >= 0 && why.indexOf("parity") >= 0 ? ", " : "") +
        (why.indexOf("parity") >= 0 ? "남자·여자 출전 합을 짝수로 맞춤" : "") + "." }));
    }
    if (!R.rest && R.upper < full) {
      var pl = { ub: Object.assign({ M: R.upper }, R.ub), parityDrops: R.reductions.filter(function (r) { return r.reason === "parity" && r.from > R.M && R.M === r.to; }).map(function (r) { return r.from; }) };
      var why2 = emptyReasons(pl, s);
      if (why2.length) {
        red.appendChild(el("p", { text: "코트 " + full + "칸 중 " + (full - R.upper) + "칸은 계산으로 비게 됩니다:" }));
        why2.forEach(function (w) { red.appendChild(el("p", { class: "hint", text: "· " + w })); });
      }
    }
    if (R.lastEnd && R.lastEnd !== endFull) red.appendChild(el("p", null, [el("b", { text: "실제 마지막 경기 종료 " + R.lastEnd })]));
    red.hidden = !red.firstChild;

    renderCheck(R);

    // 참여 구간이 다른 사람 표 (참가·퇴장·몫·실제)
    var ivBox = $("result-iv");
    clear(ivBox);
    var diff = R.people.filter(function (p) { return p.late || p.early; });
    if (R.rest) {
      // 지금까지 g0 + 남은 r = 하루 합계 (변동이 있는 사람·남은 경기 0인 사람을 먼저)
      ivBox.appendChild(el("p", null, [el("b", { text: "사람별 경기 수 (지금까지 + 남은 = 하루 합계)" })]));
      ivBox.appendChild(restTable(R.people, R.meta.rest.lambda, gamesOfRows(R.rest.baseRows)));
      ivBox.hidden = false;
    } else if (diff.length) {
      ivBox.appendChild(el("p", null, [el("b", { text: "늦게 오거나 일찍 가는 사람 " + diff.length + "명" })]));
      var lt = el("table");
      lt.appendChild(el("tr", null, ["이름", "참가", "퇴장", "참여 시간대", "몫", "실제"].map(function (h) { return el("th", { text: h }); })));
      diff.slice().sort(function (a, b) { return (a.f - b.f) || (a.l - b.l); }).forEach(function (p) {
        lt.appendChild(el("tr", null, [p.name, p.arrivalShown, p.leaveShown, p.m + "개", p.q.toFixed(2), p.games + "경기"].map(function (v) { return el("td", { text: String(v) }); })));
      });
      ivBox.appendChild(el("div", { class: "table-wrap" }, [lt]));
      ivBox.appendChild(el("p", { class: "hint", text: "몫 = 출전 자리(4 × 총 경기 수)를 참여 시간대 수에 비례해 나눈 값. 실제 경기 수는 몫의 내림 또는 올림입니다." }));
    }
    if (!R.rest) ivBox.hidden = !diff.length;

    renderGrid();
    renderMineOptions();
    setResultTab("grid");
    $("result-error").textContent = "";
    $("kakao-result").hidden = true;
  }

  // 규칙 점검 (8절 개정 11): 모두 통과면 한 줄(누르면 펼침), 위반이 있으면 위반 항목만 + 펼치면 전체. 완화했으면 참고 한 줄
  function checkTable(items) {
    var t = el("table", { class: "check" });
    t.appendChild(el("tr", null, ["항목", "내용", "위반", "판정"].map(function (h) { return el("th", { text: h }); })));
    items.forEach(function (it) {
      var note = it.relaxNote && it.count === 0;
      t.appendChild(el("tr", null, [
        el("td", { text: it.code }), el("td", { class: "left", text: it.item }),
        el("td", { text: String(it.count) }),
        el("td", { class: it.count ? "fail" : note ? "note" : "pass", text: it.count ? "실패" : note ? "참고" : "통과" })
      ]));
    });
    return el("div", { class: "table-wrap" }, [t]);
  }

  // 2연속 차이 (ⓗ, 재편성은 ⓗ′) — 자기 점검이 다시 센 값
  function fairGap(R) {
    var it = R.check.items.filter(function (x) { return x.code === "ⓗ" || x.code === "ⓗ′"; })[0];
    return it ? it.gap : 0;
  }

  function renderCheck(R) {
    var chk = $("result-check");
    clear(chk);
    var ok = R.check.total === 0;
    var hint = el("p", { class: "hint", text: "점검은 대진을 만든 코드와 따로 만든 코드(checker.js)가 명단과 대진표를 다시 읽어 셉니다." });
    if (ok) {
      chk.appendChild(el("details", { class: "check-all" }, [el("summary", null, [el("b", { text: "✓ 규칙 점검 모두 통과" })]), checkTable(R.check.items), hint]));
    } else {
      chk.appendChild(el("p", null, [el("b", { class: "fail-text", text: "규칙 점검: 위반 " + R.check.total + "건 — 이 대진표는 쓰지 마세요" })]));
      chk.appendChild(checkTable(R.check.items.filter(function (it) { return it.count > 0; })));
      chk.appendChild(el("details", { class: "check-all" }, [el("summary", { text: "전체 항목 보기" }), checkTable(R.check.items), hint]));
    }
    if (R.check.relaxNote) chk.appendChild(el("p", { class: "late-line", id: "result-relax-note", text: "참고: 코트를 채우려고 2연속 차이 " + R.check.relaxNote + " 허용" }));
  }

  function renderGrid() {
    var R = state.result;
    var s = R.settings;
    var box = $("rtab-grid");
    clear(box);
    var t = el("table", { class: "grid" });
    var head = el("tr", null, [el("th", { text: "시간" })]);
    for (var c = 1; c <= s.courts; c++) head.appendChild(el("th", { text: "코트 " + c }));
    t.appendChild(head);
    var bySlot = {};
    R.rows.forEach(function (r) { bySlot[r.slot + ":" + r.court] = r; });
    for (var slot = 0; slot < R.S; slot++) {
      var done = R.rest && slot <= R.rest.T;   // 진행된 시간대 (Q2: 회색 + "진행됨")
      var th = el("th", { text: Scheduler.slotTime(s.start, s.minutes, slot) + "~" + Scheduler.slotTime(s.start, s.minutes, slot + 1) });
      if (done) th.appendChild(el("div", { class: "done-tag", text: "진행됨" }));
      var tr = el("tr", done ? { class: "fixed" } : null, [th]);
      if (!R.loads[slot]) {
        // D3: 경기가 하나도 없는 시간대는 줄 전체에 한 문구
        tr.appendChild(el("td", { class: "noslot", colspan: String(s.courts), text: "이 시간에는 경기 없음" }));
      } else {
        for (c = 1; c <= s.courts; c++) {
          var m = bySlot[slot + ":" + c];
          if (m) {
            tr.appendChild(el("td", { class: "match t-" + m.type }, [
              el("div", { class: "kind", text: m.type }),
              el("div", { text: m.show1.join(" · ") }),
              el("div", { class: "vs", text: "vs" }),
              el("div", { text: m.show2.join(" · ") })
            ]));
          } else {
            tr.appendChild(el("td", { class: "empty", text: "(빈 코트)" }));
          }
        }
      }
      t.appendChild(tr);
    }
    box.appendChild(t);
    var legend = el("div", { class: "legend" });
    ["남복", "여복", "혼복"].forEach(function (k) {
      var cls = { "남복": "--men", "여복": "--women", "혼복": "--mixed" }[k];
      var span = el("span", { text: k });
      span.style.background = "var(" + cls + ")";
      legend.appendChild(span);
    });
    box.appendChild(legend);
  }

  function renderMineOptions() {
    var R = state.result;
    var sel = $("mine-name");
    clear(sel);
    sel.appendChild(el("option", { value: "", text: "이름을 고르세요" }));
    R.roster.forEach(function (p) { sel.appendChild(el("option", { value: p.name, text: p.name })); });
    clear($("mine-list"));
  }

  function renderMine(name) {
    var R = state.result;
    var s = R.settings;
    var box = $("mine-list");
    clear(box);
    if (!name) return;
    var p = R.byName[name];
    var mine = R.rows.filter(function (r) { return r.t1.indexOf(name) >= 0 || r.t2.indexOf(name) >= 0; });
    box.appendChild(el("p", null, [el("b", { text: name }), " 님은 " + mine.length + "경기입니다." + (p.doubles ? " (2연속 " + p.doubles + "회)" : "")]));
    if (R.rest) box.appendChild(el("p", { class: "late-line", text: "지금까지 " + p.g0 + "경기 + 남은 " + p.r + "경기 = 하루 " + (p.g0 + p.r) + "경기" +
      (p.change !== "same" ? " · " + CHANGE_LABEL[p.change === "absent-played" ? "absent" : p.change] : "") }));
    if (p.late || p.early) box.appendChild(el("p", { class: "late-line", text: "참여 " + intervalLabel(s, p.f, p.l) + " (참가 " + p.arrivalShown + " · 퇴장 " + p.leaveShown + ") · 몫 " + p.q.toFixed(2) + "경기" }));
    var t = el("table");
    t.appendChild(el("tr", null, ["시간", "코트", "파트너", "상대", "종류"].map(function (h) { return el("th", { text: h }); })));
    mine.forEach(function (r) {
      var myTeam = r.t1.indexOf(name) >= 0 ? r.t1 : r.t2;
      var other = myTeam === r.t1 ? r.show2 : r.show1;
      var partner = myTeam.filter(function (x) { return x !== name; })[0];
      var timeCell = el("td", null, [r.time]);
      if (p.slots[r.slot - 1] || p.slots[r.slot + 1]) timeCell.appendChild(el("span", { class: "dbl", text: "연속" }));   // 2연속인 경기
      var done = R.rest && r.slot <= R.rest.T;
      if (done) timeCell.appendChild(el("span", { class: "done-tag", text: "진행됨" }));
      t.appendChild(el("tr", done ? { class: "fixed" } : null, [
        timeCell, el("td", { text: String(r.court) }),
        el("td", { text: partner }), el("td", { text: other.join(" · ") }), el("td", { text: r.type })
      ]));
    });
    box.appendChild(el("div", { class: "table-wrap" }, [t]));
  }

  function setResultTab(tab) {
    document.querySelectorAll("[data-rtab]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-rtab") === tab);
    });
    $("rtab-grid").hidden = tab !== "grid";
    $("rtab-mine").hidden = tab !== "mine";
  }

  // ── 진행 중 재편성 (6.8, 8.1, plan_w7.md 2.9) ─────────────────────
  function fracNum(x) { return x && x.d ? x.n / x.d : 0; }

  // 화면·Excel에 보일 때만 약분 (계산은 scheduler.js의 분자/분모 그대로)
  function fracText(x) {
    if (!x || !x.d) return "-";
    var a = Math.abs(x.n), b = x.d;
    while (b) { var t = a % b; a = b; b = t; }
    var g = a || 1;
    return (x.n / g) + "/" + (x.d / g);
  }

  // 바탕 대진(이름 행)에서 사람별 하루 경기 수
  function gamesOfRows(rows) {
    var g = {};
    rows.forEach(function (r) { r.t1.concat(r.t2).forEach(function (x) { g[x] = (g[x] || 0) + 1; }); });
    return g;
  }

  /*
   * 미리보기의 동점 표시 (8.1 개정 11, plan_w7b 3.4): 같은 소수점 묶음 중 일부만 ⌈ρ⌉를 받으면 누가 받을지는 대진을 만들 때
   * 정해지므로 그 묶음은 "⌊ρ⌋ 또는 ⌈ρ⌉". 돌려주는 값: 사람마다 null 또는 [⌊ρ⌋, ⌈ρ⌉]
   */
  function tieRanges(rho, r) {
    var groups = {};
    rho.forEach(function (v, i) {
      var lo = Math.floor(v + 1e-9), fr = v - lo;
      if (fr < 1e-9) return;
      var key = Math.round(fr * 1e6);
      (groups[key] = groups[key] || []).push(i);
    });
    var out = rho.map(function () { return null; });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var got = g.filter(function (i) { return r[i] > Math.floor(rho[i] + 1e-9); }).length;
      if (got > 0 && got < g.length) g.forEach(function (i) { var lo = Math.floor(rho[i] + 1e-9); out[i] = [lo, lo + 1]; });
    });
    return out;
  }

  /*
   * 사람별 "지금까지 + 남은 = 하루 합계" 표 (8.1-3). 변동이 있는 사람 → 남은 경기 0인 사람 → 나머지.
   * 개정 11: 기본은 변동을 입력한 사람 + 하루 합계가 바탕(baseGames)과 달라진(달라질 수 있는) 사람만, [전체 보기]로 모두.
   * 개정 12: view({showAll})를 주면 고른 보기를 거기에 둔다 — 입력 중 미리보기를 다시 그려도 보기가 유지되게(결함 고침)
   * 개정 13 (W7c 1절 (나)): [바뀐 사람만]은 변동을 넣은 사람 + "또는" 범위 **전체가** 바탕과 다른 사람. 범위 안에 바탕 값이 든 사람은
   * 빼고 표 아래 "N명은 한 경기 달라질 수 있습니다" 한 줄. 결과 표는 alt가 없으므로(정수) 실제로 하루 합계가 달라진 사람
   * people: [{name, change, g0, rho, r, alt: null | [lo, hi]}]
   */
  function restTable(people, lambda, baseGames, view) {
    var order = people.slice().sort(function (a, b) {
      var ka = a.change !== "same" ? 0 : (a.r === 0 ? 1 : 2), kb = b.change !== "same" ? 0 : (b.r === 0 ? 1 : 2);
      return (ka - kb) || cmpName(a.name, b.name);
    });
    function totals(p) { return p.alt ? [p.g0 + p.alt[0], p.g0 + p.alt[1]] : [p.g0 + p.r]; }
    function changed(p) {
      var b = baseGames[p.name] || 0;
      return p.change !== "same" || totals(p).every(function (v) { return v !== b; });
    }
    function maybe(p) {
      var b = baseGames[p.name] || 0;
      return !changed(p) && totals(p).some(function (v) { return v !== b; });
    }
    var maybeN = order.filter(maybe).length;
    var wrap = el("div", { class: "rest-people-box" });
    view = view || { showAll: false };
    function draw() {
      clear(wrap);
      var showAll = !!view.showAll;
      var list = showAll ? order : order.filter(changed);
      var btn = el("button", { type: "button", class: "subtle rest-toggle", text: showAll ? "바뀐 사람만" : "전체 보기 (" + order.length + "명)" });
      btn.addEventListener("click", function () { keepScroll(function () { view.showAll = !showAll; draw(); }); });
      if (!list.length) {
        wrap.appendChild(el("p", { class: "rest-none", text: "경기 수가 바뀐 사람이 없습니다." }));
      } else {
        var t = el("table", { class: "rest-people" });
        t.appendChild(el("tr", null, ["이름", "변동", "지금까지", "남은 몫", "남은", "하루 합계"].map(function (h) { return el("th", { text: h }); })));
        list.forEach(function (p) {
          var ch = p.change === "absent-played" ? "불참(지난 경기 그대로)" : CHANGE_LABEL[p.change] || "그대로";
          var rTxt = p.alt ? p.alt[0] + " 또는 " + p.alt[1] + "경기" : p.r + "경기";
          var dTxt = p.alt ? (p.g0 + p.alt[0]) + " 또는 " + (p.g0 + p.alt[1]) + "경기" : (p.g0 + p.r) + "경기";
          t.appendChild(el("tr", p.change !== "same" ? { class: "changed" } : null,
            [p.name, ch, p.g0 + "경기", p.rho.toFixed(2), rTxt, dTxt].map(function (v) { return el("td", { text: String(v) }); })));
        });
        wrap.appendChild(el("div", { class: "table-wrap" }, [t]));
      }
      if (!showAll && maybeN) wrap.appendChild(el("p", { class: "rest-maybe", text: maybeN + "명은 한 경기 달라질 수 있습니다" }));
      if (!showAll) wrap.appendChild(el("p", { class: "hint", text: "변동을 넣은 사람과 하루 경기 수가 바탕 대진과 확실히 달라지는 사람만 보입니다." }));
      wrap.appendChild(el("div", { class: "row" }, [btn]));
      if (people.some(function (p) { return p.alt; })) wrap.appendChild(el("p", { class: "hint", text: "‘또는’은 같은 몫인 사람 중 누가 한 경기 더 할지 대진을 만들 때 정해집니다." }));
      if (lambda) wrap.appendChild(el("p", { class: "hint", text: "남은 몫 = λ × 참여 시간대 수 − 지금까지 경기 (0 이상, 할 수 있는 최대 이하). λ = " +
        fracText(lambda) + " ≈ " + fracNum(lambda).toFixed(3) + " (참여 시간대 1칸당 경기 수, 모두에게 같음)" }));
    }
    draw();
    return wrap;
  }

  // 다시 그려도 화면 위치가 그대로이게 (8.1 개정 11: 상태를 바꾸면 맨 위로 튀던 문제)
  function keepScroll(fn) {
    var y = window.scrollY;
    fn();
    if (window.scrollY !== y) window.scrollTo(0, y);
  }

  function focusNoScroll(node) {
    try { node.focus({ preventScroll: true }); } catch (e) { node.focus(); }
  }

  function cmpName(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // [진행 중 변경]을 쓸 수 있는지 (2절: 이 기기에서 만든 대진만)
  function restLock() {
    if (!state.result) return "대진표가 없습니다.";
    if (isStale()) return "명단·설정이 바뀌어 지금 대진과 맞지 않습니다. [다시 만들기]를 누르거나 원래대로 돌려 주세요.";
    if (state.running) return "대진을 찾는 중입니다.";
    return "";
  }

  function refreshResultButtons() {
    var R = state.result;
    if (!R) return;
    $("result-undo").hidden = !R.rest;
    $("result-again").textContent = R.rest ? "같은 변동, 새 번호로 다시 짜기" : "다시 만들기 (새 번호)";
    var why = restLock();
    $("result-rest").disabled = !!why;
    $("result-rest-msg").textContent = why && R ? why : "";
  }

  // 진행 중 변경 화면이 바탕으로 보는 결과 (보통은 지금 결과, "같은 변동으로 다시 짜기"는 마지막 회차의 바탕)
  var restViewBase = null;
  function viewBase() { return restViewBase || state.result; }

  function renderRestView(R) { restViewBase = R; renderRest(); }

  // 바탕 = 지금 결과 자체 (6.8.1)
  function restBase() {
    var R = viewBase();
    return { roster: plainRoster(R.roster), rows: plainRows(R.rows), seed: R.seed };
  }

  function nowMinutes() {
    if (window.__W7_NOW__) return window.__W7_NOW__;      // 시험용으로 시각을 정할 수 있게 (시험 페이지만 씀)
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  // 2.3 기준 시간대 기본값. "" = 기본값 없음(날짜가 오늘이 아님), -1 = 시작 전
  function defaultT(s, minT) {
    if (s.date !== todayStr()) return "";
    var st = Scheduler.parseHM(s.start), S = Scheduler.slots(s).S, now = nowMinutes();
    var T;
    if (now < st) T = -1;
    else T = Math.min(S - 1, Math.floor((now - st) / s.minutes));
    return Math.max(T, minT);
  }

  function enterRest() {
    var why = restLock();
    if (why) { $("result-rest-msg").textContent = why; return; }
    var R = state.result, s = R.settings;
    var minT = R.rest ? R.rest.T : -1;                    // Q14: 직전 회차의 T보다 앞은 고를 수 없음
    restViewBase = null;
    state.restForm = newRestForm(defaultT(s, minT), minT);
    $("rest-seed").value = "";
    $("rest-fail").hidden = true;
    $("rest-status").hidden = true;
    renderRest();
    show("rest");
  }

  function newRestForm(T, minT) {
    return { T: T, minT: minT, edits: {}, newcomers: [], open: null, picker: false, filter: "", seed: "", showAll: false };
  }

  function restT() { var v = state.restForm.T; return v === "" ? null : Number(v); }

  // 기준 시간대 버튼을 누름 (개정 12: 풀다운 대신 버튼 줄)
  function setRestT(v) {
    var F = state.restForm;
    F.T = v === "" ? "" : Number(v);
    // 기준이 바뀌면 조건에 안 맞게 된 값을 고친다: 지난 경기가 생긴 사람의 참가는 원래대로, 바꾼 시각이 새 항목보다 앞이면 첫 값으로
    var g = playedUntil(restT());
    var S = viewBase().S, s = viewBase().settings, T = restT(), who = rosterByName(viewBase());
    Object.keys(F.edits).forEach(function (n) {
      var e = F.edits[n], b = baseTimes(who[n].p, s);
      if (T === null || T < 0 || T >= S - 1) return;
      var first = Scheduler.slotTime(s.start, s.minutes, T + 1);
      if (g[n] > 0) e.arrival = b.arrival;
      ["arrival", "leave"].forEach(function (k) {
        if (Scheduler.parseHM(e[k]) !== Scheduler.parseHM(b[k]) && Scheduler.parseHM(e[k]) < Scheduler.parseHM(first)) e[k] = first;
      });
    });
    F.newcomers.forEach(function (nc) {
      if (T === null || T < 0 || T >= S - 1) return;
      var first = Scheduler.slotTime(s.start, s.minutes, T + 1);
      if (!nc.arrival || Scheduler.parseHM(nc.arrival) < Scheduler.parseHM(first)) nc.arrival = first;
    });
    keepScroll(function () {
      renderRest();
      // 다시 그린 기준 버튼 줄에서 누른 버튼에 초점을 돌려준다 (화면은 움직이지 않게)
      var on = $("rest-T").querySelector("button.choice.on");
      if (on) focusNoScroll(on);
    });
  }

  function slotLabel(s, t) {
    return Scheduler.slotTime(s.start, s.minutes, t) + " 경기 중 (" + Scheduler.slotTime(s.start, s.minutes, t) + "–" + Scheduler.slotTime(s.start, s.minutes, t + 1) + ")";
  }

  function renderRest() {
    var R = viewBase(), s = R.settings, F = state.restForm, S = R.S;
    // 1. 기준 시간대: 버튼 줄 (개정 12). 버튼에는 시작 시각만, 고른 시간대는 아래 한 줄에 풀어 쓴다
    var box = $("rest-T");
    var opts = [];
    if (F.minT < 0) opts.push({ value: "-1", text: "시작 전" });
    for (var t = Math.max(0, F.minT); t < S; t++) opts.push({ value: String(t), text: Scheduler.slotTime(s.start, s.minutes, t), label: slotLabel(s, t) });
    clear(box);
    box.appendChild(choiceButtons(opts, String(F.T), setRestT, "기준 시간대"));
    var T = restT();
    $("rest-T-label").textContent = T === null ? "기준 시간을 고르세요 (지금 하고 있는 경기의 시작 시각)" :
      T < 0 ? "시작 전" : slotLabel(s, T) + " — 이 경기까지는 그대로 둡니다";
    $("rest-round").textContent = R.rest ? "이번이 " + (R.rest.n + 1) + "번째 변경입니다 (직전 기준 " + Scheduler.slotTime(s.start, s.minutes, R.rest.T) + ")." : "";
    renderRestGrid();
    renderRestInput();
    renderRestPreview();
  }

  // 고정되는 시간대를 작은 격자에서 회색으로 (8.1-1)
  function renderRestGrid() {
    var R = viewBase(), s = R.settings, T = restT();
    var box = $("rest-grid");
    clear(box);
    var tbl = el("table", { class: "grid mini" });
    var bySlot = {};
    R.rows.forEach(function (r) { (bySlot[r.slot] = bySlot[r.slot] || []).push(r); });
    for (var slot = 0; slot < R.S; slot++) {
      var fixed = T !== null && slot <= T;
      var cells = (bySlot[slot] || []).map(function (r) { return r.show1.concat(r.show2).join(", "); });
      tbl.appendChild(el("tr", fixed ? { class: "fixed" } : null, [
        el("th", { text: Scheduler.slotTime(s.start, s.minutes, slot) }),
        el("td", { class: "left", text: (fixed ? "진행됨 · " : "") + (cells.length ? cells.join(" / ") : "경기 없음") })
      ]));
    }
    box.appendChild(tbl);
  }

  // 0…T에 뛴 경기 수
  function playedUntil(T) {
    var R = viewBase(), g = {};
    R.roster.forEach(function (p) { g[p.name] = 0; });
    if (T === null) return g;
    R.rows.forEach(function (r) { if (r.slot <= T) r.t1.concat(r.t2).forEach(function (x) { g[x] += 1; }); });
    return g;
  }

  /*
   * 사람 카드의 시각 버튼 (8.1 개정 13, 6.8.2): arrival = t_(T+1)…t_(S−1), leave = t_(T+1)("지금 끝나고")…t_(S−1) + "끝까지"(값 = 종료 시각).
   * orig(원래 값)가 항목에 없으면 시각 순서대로 끼워 넣고, 원래 값 버튼에는 "(원래)"를 붙인다. orig가 없으면(새로 온 사람) 표시 없음
   */
  function cardTimeOptions(kind, s, T, S, orig) {
    var out = [];
    for (var k = T + 1; k < S; k++) {
      var v = Scheduler.slotTime(s.start, s.minutes, k);
      out.push({ value: v, text: v + (kind === "leave" && k === T + 1 ? " 지금 끝나고" : "") });
    }
    if (kind === "leave") out.push({ value: s.end, text: "끝까지" });
    if (orig) {
      var om = Scheduler.parseHM(orig);
      var hit = out.filter(function (o) { return Scheduler.parseHM(o.value) === om; })[0];
      if (!hit) {
        hit = { value: orig, text: orig };
        var at = 0;
        while (at < out.length && Scheduler.parseHM(out[at].value) < om) at++;
        out.splice(at, 0, hit);
      }
      hit.text += "(원래)";
    }
    return out;
  }

  /*
   * 누름 버튼 줄 (8.1 개정 12: 휴대폰 선택 목록 창에 붙는 (이전, 다음) 버튼이 불편해 <select> 대신 씀).
   * opts: [{value, text, disabled, label}]. 누르면 버튼을 지우지 않고 고른 표시만 바꾼 뒤 onPick(value) —
   * 누른 버튼이 그대로 있어 초점·화면 위치가 움직이지 않는다(개정 11의 스크롤 원칙). 흐린 버튼은 누를 수 없다
   */
  function choiceButtons(opts, value, onPick, label) {
    var box = el("div", { class: "choices", role: "group" });
    if (label) box.setAttribute("aria-label", label);
    var btns = opts.map(function (o) {
      var b = el("button", { type: "button", class: "choice", "data-value": o.value, text: o.text });
      if (o.label) b.setAttribute("aria-label", o.label);
      if (o.disabled) b.disabled = true;
      b.addEventListener("click", function () {
        if (b.disabled) return;
        mark(o.value);
        onPick(o.value);
      });
      box.appendChild(b);
      return b;
    });
    function mark(v) {
      btns.forEach(function (b) {
        var on = b.getAttribute("data-value") === v;
        b.className = on ? "choice on" : "choice";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    mark(value);
    return box;
  }

  /*
   * 2. 변동 (8.1 개정 13): 이름 칸 → 이름 버튼 → 사람 카드, 아래에 "변동 N명" 요약.
   * 화면 입력 F.edits[이름] = {absent, arrival, leave}(그 사람의 지금 값, 처음엔 원래 값), F.newcomers = [{name, gender, grade, arrival, leave}].
   * F.open = 열린 카드 {name} 또는 {nc: 새로 온 사람}, F.picker = 이름 버튼이 펼쳐졌는지, F.filter = 거르는 글자
   */
  function restInputOk() {
    var R = viewBase(), T = restT();
    return T !== null && T >= 0 && T < R.S - 1;
  }

  function rosterByName(R) {
    var m = {};
    R.roster.forEach(function (p, i) { m[p.name] = { p: p, x: R.people[i] }; });
    return m;
  }

  // 원래(바탕) 참가·퇴장 시각. "" = 정시·끝까지 → 시작·종료 시각으로 (같은 값끼리 비교되게)
  function baseTimes(p, s) { return { arrival: p.arrival || s.start, leave: p.leave || s.end }; }

  function editOf(F, p, s) {
    if (!F.edits[p.name]) { var b = baseTimes(p, s); F.edits[p.name] = { absent: false, arrival: b.arrival, leave: b.leave }; }
    return F.edits[p.name];
  }

  /*
   * 한 사람의 실제 변동 (8.1 개정 13: "바뀐 사람" = 원래 값과 실제로 다른 사람). 불참은 늘 다름(시각 변경은 무시),
   * 참가·퇴장은 원래 값과 다를 때만 — 눌렀다가 원래 값으로 돌아오면 변동이 아니다. 돌려주는 값: Scheduler 변동 목록 모양 [{kind, name, …}]
   */
  function personChanges(p, e, s) {
    if (!e) return [];
    if (e.absent) return [{ kind: "absent", name: p.name }];
    var b = baseTimes(p, s), out = [];
    if (Scheduler.parseHM(e.arrival) !== Scheduler.parseHM(b.arrival)) out.push({ kind: "arrival", name: p.name, arrival: e.arrival });
    if (Scheduler.parseHM(e.leave) !== Scheduler.parseHM(b.leave)) out.push({ kind: "leave", name: p.name, leave: e.leave });
    return out;
  }

  function renderRestInput() {
    var F = state.restForm;
    $("rest-name").setAttribute("aria-expanded", F.picker ? "true" : "false");
    $("rest-picker").hidden = !F.picker;
    if ($("rest-filter").value !== F.filter) $("rest-filter").value = F.filter;
    if (F.picker) renderRestNames();
    if (F.open && F.open.nc && F.newcomers.indexOf(F.open.nc) < 0) F.open = null;
    renderRestCard();
    refreshRestSum();
  }

  // 이름 버튼 (가나다순, 맨 앞 [＋ 새로 온 사람]). 이미 바꾼 사람은 주황 테두리. 글자를 치면 그 글자가 든 이름만
  function renderRestNames() {
    var R = viewBase(), s = R.settings, F = state.restForm;
    var box = $("rest-names");
    clear(box);
    var q = F.filter.trim();
    var add = el("button", { type: "button", class: "choice add", "data-add": "1", text: q ? "＋ 새로 온 사람 \"" + q + "\"" : "＋ 새로 온 사람" });
    if (!restInputOk()) add.disabled = true;
    add.addEventListener("click", function () { if (!add.disabled) addNewcomer(q); });
    box.appendChild(add);
    var items = R.roster.map(function (p) { return { name: p.name, marked: personChanges(p, F.edits[p.name], s).length > 0, open: { name: p.name } }; })
      .concat(F.newcomers.filter(function (nc) { return nc.name; }).map(function (nc) { return { name: nc.name, marked: true, open: { nc: nc }, isNew: true }; }));
    items.sort(function (a, b) { return cmpName(a.name, b.name); });
    items.filter(function (it) { return !q || it.name.indexOf(q) >= 0; }).forEach(function (it) {
      var b = el("button", { type: "button", class: "choice" + (it.marked ? " marked" : ""), "data-name": it.name, text: it.name });
      if (it.isNew) b.setAttribute("data-new", "1");
      b.addEventListener("click", function () { openCard(it.open); });
      box.appendChild(b);
    });
  }

  function toggleNames() {
    var F = state.restForm;
    keepScroll(function () {
      F.picker = !F.picker;
      if (F.picker) F.open = null;            // 이름 버튼을 펼치면 카드는 닫는다
      else F.filter = "";
      renderRestInput();
    });
  }

  // 카드 열기 (이름 버튼·[✎ 고치기]). 이름 버튼은 닫고 글자도 지운다. 화면 위치는 그대로, 카드가 화면 밖이면 그 카드만 보이게
  function openCard(open) {
    var F = state.restForm;
    keepScroll(function () {
      F.picker = false;
      F.filter = "";
      F.open = open;
      renderRestInput();
    });
    var card = $("rest-card"), r = card.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) card.scrollIntoView({ block: "nearest" });
  }

  // [＋ 새로 온 사람]: 친 글자를 이름으로. 이름을 안 쳤으면 카드의 이름 칸에 초점(이때만 키보드)
  function addNewcomer(name) {
    var R = viewBase(), s = R.settings, T = restT();
    var nc = { name: name, gender: "", grade: "", arrival: Scheduler.slotTime(s.start, s.minutes, T + 1), leave: "" };
    state.restForm.newcomers.push(nc);
    openCard({ nc: nc });
    if (!name) { var inp = $("rest-card").querySelector("input"); if (inp) focusNoScroll(inp); }
    keepScroll(renderRestPreview);
  }

  // 새로 온 사람의 이름 ⚠ (4절 규칙: 빈칸·중복). 성별·급수가 비었으면 함께
  function newcomerWarn(nc) {
    var R = viewBase(), msgs = [];
    if (!nc.name) msgs.push("이름을 넣어 주세요");
    else if (R.roster.some(function (p) { return p.name === nc.name; }) ||
      state.restForm.newcomers.some(function (o) { return o !== nc && o.name === nc.name; })) msgs.push("같은 이름이 있습니다. " + nc.name + "(1)처럼 구분해 주세요");
    if (!nc.gender || !nc.grade) msgs.push("성별·급수를 골라 주세요");
    return msgs;
  }

  /*
   * 사람 카드: 이름 · 지금까지, 성별·급수(기존 참가자는 잠금), 참가·퇴장 시각 버튼 줄, [불참], [원래대로]·[닫기].
   * 누르면 바로 반영하고 카드를 다시 그린 뒤 누른 버튼에 초점을 돌려준다(화면 위치 그대로 — 개정 11)
   */
  function renderRestCard() {
    var R = viewBase(), s = R.settings, F = state.restForm, T = restT(), S = R.S;
    var card = $("rest-card");
    clear(card);
    card.hidden = !F.open;
    if (!F.open) return;
    var tOk = restInputOk(), g = playedUntil(T);
    var nc = F.open.nc, who = nc ? null : rosterByName(R)[F.open.name];
    if (!nc && !who) { F.open = null; card.hidden = true; return; }
    var p = who && who.p, e = p ? (F.edits[p.name] || { absent: false, arrival: baseTimes(p, s).arrival, leave: baseTimes(p, s).leave }) : null;
    var played = p ? g[p.name] : 0;

    function changed(focus) {
      keepScroll(function () {
        renderRestCard();
        refreshRestSum();
        renderRestPreview();
        if (state.restForm.picker) renderRestNames();
        if (focus) { var b = $("rest-card").querySelector(focus); if (b) focusNoScroll(b); }
      });
    }
    function row(label, key, opts, value, onPick, lock) {
      var r = el("div", { class: "card-row" }, [el("span", { class: "card-label", text: label })]);
      var box = choiceButtons(opts, value, function (v) { onPick(v); changed('[data-row="' + key + '"] button[data-value="' + v + '"]'); }, label);
      box.setAttribute("data-row", key);
      r.appendChild(box);
      if (lock) r.appendChild(el("span", { class: "card-lock", text: lock }));
      card.appendChild(r);
    }

    // 머리: 이름 · 지금까지 (새로 온 사람은 이름 칸)
    var head = el("p", { class: "card-head" });
    if (nc) {
      var name = el("input", { type: "text", placeholder: "이름", "aria-label": "새로 온 사람 이름" });
      name.value = nc.name;
      name.addEventListener("input", function () {
        nc.name = name.value.trim();
        // 이름 칸은 그대로 두고(초점·키보드 유지) ⚠·요약·미리보기만 다시
        keepScroll(function () { paintWarn(); refreshRestSum(); renderRestPreview(); });
      });
      head.appendChild(name);
      head.appendChild(document.createTextNode(" · 새로 온 사람"));
    } else {
      head.textContent = p.name + " · 지금까지 " + (T === null ? "-" : played + "경기");
    }
    card.appendChild(head);

    // 성별·급수: 기존 참가자는 잠금 (지난 경기는 그때의 급수로 짝을 맞췄으므로)
    var gv = nc ? nc.gender : p.gender, kv = nc ? nc.grade : p.grade;
    row("성별", "gender", GENDERS.map(function (x) { return { value: x, text: x, disabled: !nc }; }), gv, function (v) { nc.gender = v; });
    row("급수", "grade", GRADES.map(function (x) { return { value: x, text: x, disabled: !nc }; }), kv, function (v) { nc.grade = v; });
    if (!nc) card.appendChild(el("p", { class: "card-lock", text: "진행 중에는 성별·급수를 바꾸지 않음" }));

    // 참가·퇴장 시각
    if (!tOk) {
      card.appendChild(el("p", { class: "card-lock", text: "시각은 기준 시간대(뒤에 남은 시간이 있을 때)를 고른 뒤 바꿀 수 있습니다" }));
    } else if (nc) {
      var na = Scheduler.parseHM(nc.arrival), nl = Scheduler.parseHM(nc.leave || s.end);
      row("참가", "arrival", cardTimeOptions("arrival", s, T, S, "").map(function (o) { o.disabled = Scheduler.parseHM(o.value) >= nl; return o; }),
        nc.arrival, function (v) { nc.arrival = v; });
      row("퇴장", "leave", cardTimeOptions("leave", s, T, S, "").map(function (o) { o.disabled = Scheduler.parseHM(o.value) <= na; return o; }),
        nc.leave || s.end, function (v) { nc.leave = v === s.end ? "" : v; });
    } else {
      var b = baseTimes(p, s), ea = Scheduler.parseHM(e.arrival), elv = Scheduler.parseHM(e.leave);
      var gone = who.x.l <= T;                       // 이미 퇴장 시각이 지남
      if (played > 0) {
        row("참가", "arrival", [{ value: b.arrival, text: b.arrival + "(원래)", disabled: true }], b.arrival, function () {}, "지난 경기가 있어 참가 시각은 못 바꿈");
      } else {
        row("참가", "arrival", cardTimeOptions("arrival", s, T, S, b.arrival).map(function (o) { o.disabled = e.absent || Scheduler.parseHM(o.value) >= elv; return o; }),
          e.arrival, function (v) { editOf(F, p, s).arrival = v; });
      }
      if (gone) {
        row("퇴장", "leave", [{ value: b.leave, text: b.leave + "(원래)", disabled: true }], b.leave, function () {}, "이미 퇴장 시각이 지남");
      } else {
        row("퇴장", "leave", cardTimeOptions("leave", s, T, S, b.leave).map(function (o) { o.disabled = e.absent || Scheduler.parseHM(o.value) <= ea; return o; }),
          e.leave, function (v) { editOf(F, p, s).leave = v; });
      }
    }

    // [불참] (기존 참가자): 누르면 켜고 다시 누르면 끈다. 켜면 시각 변경은 지운다. 지난 경기가 있으면 "지금 뒤로 빠짐"(긴 설명은 요약에 한 번)
    if (!nc) {
      var ab = el("button", { type: "button", class: "choice" + (e.absent ? " on" : ""), "data-key": "absent", "aria-pressed": e.absent ? "true" : "false", text: "불참" });
      ab.addEventListener("click", function () {
        var x = editOf(F, p, s), bt = baseTimes(p, s);
        x.absent = !x.absent;
        x.arrival = bt.arrival; x.leave = bt.leave;
        changed('[data-key="absent"]');
      });
      var ar = el("div", { class: "card-row" }, [ab]);
      if (e.absent && played > 0) ar.appendChild(el("span", { class: "rest-short", text: "지금 뒤로 빠짐" }));
      card.appendChild(ar);
    }

    var warn = el("div");
    card.appendChild(warn);
    function paintWarn() {
      clear(warn);
      if (nc) newcomerWarn(nc).forEach(function (m) { warn.appendChild(el("p", { class: "error", text: "⚠ " + m })); });
    }
    paintWarn();

    // [원래대로]: 이 사람 변동 지우기(카드는 열린 채 원래 값), 새로 온 사람이면 지우고 카드 닫기 · [닫기]
    var undo = el("button", { type: "button", "data-key": "undo", text: "원래대로" });
    undo.addEventListener("click", function () {
      if (nc) { F.newcomers.splice(F.newcomers.indexOf(nc), 1); F.open = null; }
      else delete F.edits[p.name];
      changed(nc ? null : '[data-key="undo"]');
    });
    var close = el("button", { type: "button", "data-key": "close", text: "닫기" });
    close.addEventListener("click", function () { keepScroll(function () { F.open = null; renderRestCard(); }); });
    card.appendChild(el("div", { class: "card-actions" }, [undo, close]));
  }

  // "변동 N명" 요약 (8.1 개정 13): 사람마다 한 줄 "남자04 · 일찍 감 20:00 [✎ 고치기]". 지난 경기가 있는 사람의 불참은 긴 설명을 여기 한 번
  function refreshRestSum() {
    var R = viewBase(), s = R.settings, F = state.restForm;
    var lines = [];
    R.roster.slice().sort(function (a, b) { return cmpName(a.name, b.name); }).forEach(function (p) {
      var cs = personChanges(p, F.edits[p.name], s);
      if (cs.length) lines.push({ name: p.name, text: cs.map(function (c) { return partText(c, s.end); }).join(" · "), open: { name: p.name } });
    });
    F.newcomers.forEach(function (nc) {
      lines.push({ name: nc.name || "(이름 없음)", text: partText({ kind: "new", gender: nc.gender || "?", grade: nc.grade || "?", arrival: nc.arrival, leave: nc.leave }, s.end), open: { nc: nc } });
    });
    $("rest-changes-sum").textContent = lines.length ? "변동 " + lines.length + "명" : "변동 없음 (남은 대진을 새 번호로 다시 짭니다)";
    var ul = $("rest-changes-list");
    clear(ul);
    lines.forEach(function (x) {
      var b = el("button", { type: "button", class: "subtle", text: "✎ 고치기" });
      b.addEventListener("click", function () { openCard(x.open); });
      ul.appendChild(el("li", { "data-name": x.name }, [el("span", { text: x.name + " · " + x.text }), b]));
    });
    var g = playedUntil(restT());
    var played = restChanges().filter(function (c) { return c.kind === "absent" && g[c.name] > 0; }).map(function (c) { return c.name; });
    var nt = $("rest-changes-note");
    nt.textContent = played.length ? played.join("·") + " 불참: 지난 경기는 그대로 두고, 지금 경기 뒤로는 빠집니다." : "";
    nt.hidden = !played.length;
  }

  // 화면 입력 → Scheduler 변동 목록. 원래 값과 같은 것은 넣지 않는다(요약·사람별 표·재편성 기록이 모두 이 목록을 씀)
  function restChanges() {
    var F = state.restForm, out = [], R = viewBase();
    R.roster.slice().sort(function (a, b) { return cmpName(a.name, b.name); }).forEach(function (p) {
      out = out.concat(personChanges(p, F.edits[p.name], R.settings));
    });
    F.newcomers.forEach(function (nc) {
      out.push({ kind: "new", name: nc.name, gender: nc.gender, grade: nc.grade, arrival: nc.arrival, leave: nc.leave });
    });
    return out;
  }

  // 변동 하나의 글 (이름 빼고). end = 종료 시각: 퇴장을 종료 시각으로 바꾼 것은 "퇴장 끝까지"
  function partText(c, end) {
    if (c.kind === "absent") return "불참";
    if (c.kind === "arrival") return "참가 " + c.arrival;
    if (c.kind === "leave") return c.leave === end ? "퇴장 끝까지" : "일찍 감 " + c.leave;
    return "새로 옴(" + c.gender + " " + c.grade + ", " + c.arrival + "–" + (c.leave || "끝까지") + ")";
  }

  function changeText(c, end) { return c.name + " " + partText(c, end); }

  // 3. 미리보기 (계산만, 탐색 없음)
  function renderRestPreview() {
    var R = viewBase(), s = R.settings, T = restT();
    var box = $("rest-preview");
    clear(box);
    $("rest-run").disabled = true;
    if (T === null) { box.appendChild(el("p", { class: "hint", text: "기준 시간을 고르면 남은 경기 수를 계산해 보여 드립니다." })); return; }
    if (T < 0) { box.appendChild(el("p", { class: "error", text: "아직 시작 전입니다. 새로 만들기를 쓰세요." })); return; }
    if (T >= R.S - 1) { box.appendChild(el("p", { class: "error", text: "다시 짤 시간대가 없습니다." })); return; }
    var bad = [];
    var names = {};
    R.roster.forEach(function (p) { names[p.name] = true; });
    state.restForm.newcomers.forEach(function (nc) {
      if (!nc.name) bad.push("새로 온 사람의 이름을 넣어 주세요");
      else if (names[nc.name]) bad.push(nc.name + ": 같은 이름이 있습니다. " + nc.name + "(1)처럼 구분해 주세요");
      else names[nc.name] = true;
      if (!nc.gender || !nc.grade) bad.push((nc.name || "새로 온 사람") + ": 성별·급수를 골라 주세요");
    });
    if (bad.length) { bad.forEach(function (b) { box.appendChild(el("p", { class: "error", text: "⚠ " + b })); }); return; }
    var pl = Scheduler.restPlan(restBase(), s, T, restChanges(), 0);
    if (pl.reason === "input") { pl.errors.forEach(function (e) { box.appendChild(el("p", { class: "error", text: "⚠ " + e })); }); return; }
    var S = R.S, full = s.courts * (S - T - 1);
    if (!pl.ok) {
      box.appendChild(el("p", { class: "error", text: pl.reason === "empty" ? "남은 시간에 경기를 할 수 있는 사람이 4명이 안 됩니다." :
        "남은 경기에서 남자·여자 출전 합을 짝수로 맞출 수 없습니다." }));
      return;
    }
    var rest = pl.loads.slice(T + 1);
    var items = [
      ["남은 경기 수", pl.M + "경기 (" + Scheduler.slotTime(s.start, s.minutes, T + 1) + "부터, 최대 " + full + "경기 중 빈 코트 " + (full - pl.M) + "칸)"],
      ["시간대별", rest.map(function (k, i) { return Scheduler.slotTime(s.start, s.minutes, T + 1 + i) + " " + k; }).join(" / ")]
    ];
    var t = el("table", { class: "preview-table" });
    items.forEach(function (it) { t.appendChild(el("tr", null, [el("th", { text: it[0] }), el("td", { class: "left", text: it[1] })])); });
    box.appendChild(el("div", { class: "table-wrap" }, [t]));
    var nt = boundaryNoteText(pl.rb.note, s);
    if (nt) box.appendChild(el("p", { class: "late-line", text: nt }));
    var alt = tieRanges(pl.quota.q, pl.quota.target);
    var people = pl.roster.map(function (p, i) {
      return { name: p.name, change: pl.changeOf[p.name] || "same", g0: pl.rp[i].g0, rho: pl.quota.q[i], r: pl.quota.target[i], alt: alt[i] };
    });
    box.appendChild(restTable(people, pl.quota.lambda, R.games, state.restForm));   // 고른 보기는 입력 사이에 유지 (개정 12)
    var dbl = people.some(function (p, i) { return p.r > Math.ceil(pl.rp[i].mRest / 2) || (pl.rp[i].runAtT >= 1 && pl.rp[i].mRest > 0 && p.r >= pl.rp[i].mRest); });
    if (dbl || nt) box.appendChild(el("p", { class: "late-line", text: "남은 시간을 채우려면 일부 참가자가 2연속 경기를 합니다." }));
    box.appendChild(el("p", { class: "hint", text: "실제 대진이 이 값과 다르면 결과 화면에 이유를 보여 드립니다." }));
    $("rest-run").disabled = !!state.running || !!state.restForm.locked;
  }

  // 마지막 회차의 바탕(= 그 회차 전 대진)을 결과 모양으로
  function baseOfLastRound() {
    var td = todayData();
    var last = td.rounds[td.rounds.length - 1];
    return resultFromToday({ date: td.date, settings: td.settings, current: last.before, rounds: td.rounds.slice(0, -1) });
  }

  // 변동 목록 → 화면 입력 (같은 변동으로 다시 짤 때). R = 그 회차의 바탕
  function formFromChanges(R, T, minT, changes) {
    var F = newRestForm(T, minT), who = rosterByName(R);
    changes.forEach(function (c) {
      if (c.kind === "new") { F.newcomers.push({ name: c.name, gender: c.gender, grade: c.grade, arrival: c.arrival, leave: c.leave || "" }); return; }
      if (!who[c.name]) return;
      var e = editOf(F, who[c.name].p, R.settings);
      if (c.kind === "absent") e.absent = true;
      else e[c.kind] = c[c.kind];
    });
    return F;
  }

  /*
   * forceNewSeed: 새 번호. again: {T, changes, replaceLast} — 결과 화면의 "같은 변동, 새 번호로 다시 짜기"(마지막 회차를 그 바탕에서 다시)
   */
  function runRest(forceNewSeed, again) {
    var R = again && again.replaceLast ? baseOfLastRound() : state.result, s = R.settings;
    var T = again ? again.T : restT();
    var changes = again ? again.changes : restChanges();
    var seed = again ? "" : $("rest-seed").value.trim();
    if (forceNewSeed || !/^\d{6}$/.test(seed)) { do { seed = newSeed(); } while (seed === R.seed || (again && seed === state.result.seed)); }
    var base = { roster: plainRoster(R.roster), rows: plainRows(R.rows), seed: R.seed };
    var round = { n: (R.rest ? R.rest.n : 0) + 1, T: T, baseSeed: R.seed, seed: seed, changes: changes };
    var search = Scheduler.createRestSearch(base, s, T, changes, parseInt(seed, 10));
    var run = state.running = { cancelled: false };
    if (again && currentView !== "rest") {
      state.restForm = formFromChanges(R, T, R.rest ? R.rest.T : -1, changes);
      state.restForm.locked = true;    // 바탕이 화면의 결과와 다르므로 이 화면에서 입력을 바꿔 다시 짜지 않는다
      show("rest");
      renderRestView(R);
    }
    $("rest-fail").hidden = true;
    $("rest-status").hidden = false;
    $("rest-run").disabled = true;
    $("rest-text").textContent = "남은 대진을 찾는 중입니다… (대진 번호 " + seed + ")";
    $("rest-progress").value = 0;

    function tick() {
      if (run.cancelled) return finish(null);
      var st = search.step(STEP_BUDGET_MS);
      $("rest-progress").value = Math.min(100, Math.max(st.found / Scheduler.SOLUTIONS_TO_COMPARE, st.tries / st.maxTries) * 100);
      $("rest-text").textContent = "남은 대진을 찾는 중입니다… 남은 " + st.M + "경기로 시도" + (st.relaxing ? "(2연속 차이를 허용해 다시)" : "") + " · 찾은 대진 " + st.found + "/" + Scheduler.SOLUTIONS_TO_COMPARE +
        "개 · 시도 " + st.tries + "회 (대진 번호 " + seed + ")";
      if (st.done) finish(search.result());
      else setTimeout(tick, 0);
    }

    function finish(res) {
      state.running = null;
      $("rest-status").hidden = true;
      if (!res) { if (!(again && again.replaceLast)) renderRestPreview(); return; }
      if (!res.ok) {
        showRestFailure(res, s, { T: T, changes: changes, replaceLast: !!(again && again.replaceLast) });
        if (!(again && again.replaceLast)) renderRestPreview();
        return;
      }
      var roster = res.roster;
      var restMeta = {
        n: round.n, T: T, baseSeed: R.seed, changes: changes, changeOf: res.changeOf,
        g0: byNameMap(roster, res.rp.map(function (p) { return p.g0; })), H: byNameMap(roster, res.rp.map(function (p) { return p.H; })),
        rho: byNameMap(roster, res.q), r: byNameMap(roster, res.target), lambda: res.lambda, Mrest: res.M, upper: res.upper, note: res.note,
        restDoubles: res.totalDoubles, dayDoubles: res.dayDoubles
      };
      var meta = { M: res.M, upper: res.upper, ub: res.ub, reductions: res.reductions, repeatOpp: res.repeatOpp, found: res.found, tries: res.tries,
        q: {}, target: {}, rest: restMeta, relaxed: res.relaxed, gap: res.gap, phase: res.phase, relaxTries: res.relaxTries };
      var td = todayData() || { format: TODAY_FORMAT, appVersion: Scheduler.SCHEDULER_VERSION, date: s.date,
        settings: { start: s.start, end: s.end, minutes: s.minutes, courts: s.courts, maxGames: s.maxGames }, current: currentOf(R), rounds: [] };
      var before = currentOf(R);
      var relax = { relaxed: res.relaxed, gap: res.gap };
      var history = (R.rest ? R.rest.history : []).concat([{ n: round.n, T: T, baseSeed: R.seed, seed: seed, changes: changes,
        lambda: res.lambda, Mrest: res.M, version: res.version, relax: relax }]);
      state.result = makeResult({ settings: s, seed: seed, version: res.version, roster: roster, rows: nameRows(res.matches, roster), meta: meta,
        rest: { n: round.n, T: T, baseSeed: R.seed, baseRows: base.rows, history: history } });
      td.current = currentOf(state.result);
      td.rounds = (again && again.replaceLast ? td.rounds.slice(0, -1) : td.rounds).concat([{ n: round.n, T: T, baseSeed: R.seed, seed: seed, changes: changes,
        lambda: res.lambda, Mrest: res.M, version: res.version, relax: relax, before: before }]);
      td.appVersion = Scheduler.SCHEDULER_VERSION;
      saveToday(td);
      // ② 명단·대진 번호도 바뀐 명단으로 (낡은 결과 판정이 맞도록)
      state.roster = roster.map(normalize);
      $("set-seed").value = seed;
      state.result.snapshot = currentSnapshot();
      renderResult();
      show("result");
    }
    setTimeout(tick, 0);
  }

  function showRestFailure(res, s, again) {
    var adv = Advice.forRestFailure(res, s);
    var box = $("rest-fail");
    clear(box);
    box.appendChild(el("b", { text: adv.title }));
    box.appendChild(el("p", { text: adv.intro.text }));
    if (adv.items.length) {
      var ul = el("ul");
      adv.items.forEach(function (it) { ul.appendChild(el("li", { "data-kind": it.kind, text: it.text })); });
      box.appendChild(ul);
    }
    box.setAttribute("data-kinds", adv.kinds.join(","));
    if (adv.offerNewSeed) {
      var b = el("button", { type: "button", id: "rest-new-seed", text: "새 번호로 다시 짜기" });
      b.addEventListener("click", function () { runRest(true, again); });
      box.appendChild(el("div", { class: "row" }, [b]));
    }
    box.hidden = false;
  }

  // 저장된 오늘 대진 → 결과 (재편성 회차가 있으면 마지막 회차 정보와 함께)
  function resultFromToday(td) {
    var s = Object.assign({ date: td.date }, td.settings);
    var cur = td.current;
    var last = td.rounds.length ? td.rounds[td.rounds.length - 1] : null;
    var rest = null;
    if (last && cur.meta && cur.meta.rest) {
      rest = { n: last.n, T: last.T, baseSeed: last.baseSeed, baseRows: last.before.rows,
        history: td.rounds.map(function (r) { return { n: r.n, T: r.T, baseSeed: r.baseSeed, seed: r.seed, changes: r.changes, lambda: r.lambda, Mrest: r.Mrest, version: r.version, relax: r.relax }; }) };
    }
    return makeResult({ settings: s, seed: cur.seed, version: cur.version, roster: cur.roster, rows: cur.rows, meta: cur.meta, rest: rest });
  }

  function showToday(td) {
    var s = Object.assign({ date: td.date }, td.settings);
    state.settings = s;
    fillSettingsInputs(s);
    state.roster = td.current.roster.map(normalize);
    state.replaySeed = "";
    state.fileNotice = [];
    $("set-seed").value = td.current.seed;
    state.result = resultFromToday(td);
    state.result.snapshot = currentSnapshot();
    renderResult();
    show("result");
  }

  // [재편성 취소]: 마지막 회차의 바탕으로 되돌린다 (plan 2.2)
  function undoRest() {
    var td = todayData();
    if (!td || !td.rounds.length) return;
    if (!window.confirm("마지막 진행 중 변경(" + td.rounds.length + "회)을 취소하고 그 전 대진으로 돌아갈까요?")) return;
    var last = td.rounds[td.rounds.length - 1];
    td.current = last.before;
    td.rounds = td.rounds.slice(0, -1);
    saveToday(td);
    showToday(td);
  }

  // ── Excel 저장 (9절) ───────────────────────────────────
  var XL = {
    font: { name: "Arial", size: 10 },
    head: { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE4EE" } },
    border: (function () { var b = { style: "thin", color: { argb: "FFA6A6A6" } }; return { top: b, left: b, bottom: b, right: b }; })(),
    type: { "남복": "FFDCE9F7", "여복": "FFFBE3EA", "혼복": "FFE6F2DF" },
    ok: "FFE6F2DF", ng: "FFF8D7DA", empty: "FFF2F2F2"
  };

  function put(ws, r, c, v, opt) {
    opt = opt || {};
    var cell = ws.getCell(r, c);
    cell.value = v;                                     // 수식이 아닌 값만 쓴다
    cell.font = Object.assign({}, XL.font, opt.bold ? { bold: true } : {});
    cell.alignment = { horizontal: opt.left ? "left" : "center", vertical: "middle", wrapText: !!opt.wrap };
    cell.border = XL.border;
    if (opt.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opt.fill } };
    if (opt.text) cell.numFmt = "@";
    return cell;
  }

  function header(ws, labels) {
    labels.forEach(function (h, i) {
      var cell = put(ws, 1, i + 1, h, { bold: true });
      cell.fill = XL.head;
    });
  }

  function widths(ws, list) { list.forEach(function (w, i) { ws.getColumn(i + 1).width = w; }); }

  function buildWorkbook(R) {
    var s = R.settings;
    var wb = new ExcelJS.Workbook();
    wb.creator = "배드민턴 대진표 만들기 " + R.version;
    var full = s.courts * R.S;

    // 1) 참가자 명단 — 첫 번째 시트, 1행 머리글 (9절)
    var ws = wb.addWorksheet("참가자 명단", { views: [{ state: "frozen", ySplit: 1 }] });
    header(ws, ["이름", "성별", "급수", "급수 점수", "참가 시각", "퇴장 시각", "참여 시간대 수", "몫", "배정 경기 수", "2연속 횟수"]
      .concat(R.rest ? ["변동", "지금까지 경기", "남은 몫", "남은 배정", "하루 합계"] : []));
    R.people.forEach(function (p, i) {
      var r = i + 2;
      put(ws, r, 1, p.name, { text: true });
      put(ws, r, 2, p.gender);
      put(ws, r, 3, p.grade);
      put(ws, r, 4, Scheduler.GRADE_SCORE[p.grade]);
      put(ws, r, 5, p.arrivalShown, { text: true });
      put(ws, r, 6, p.leaveShown, { text: true });
      put(ws, r, 7, p.m);
      put(ws, r, 8, Math.round(p.q * 1000) / 1000);
      put(ws, r, 9, p.games);
      put(ws, r, 10, p.doubles);
      if (R.rest) {
        put(ws, r, 11, p.change === "absent-played" ? "불참(지난 경기 있음)" : CHANGE_LABEL[p.change] || "그대로");
        put(ws, r, 12, p.g0);
        put(ws, r, 13, Math.round(p.rho * 1000) / 1000);
        put(ws, r, 14, p.r);
        put(ws, r, 15, p.g0 + p.r);
      }
    });
    widths(ws, [14, 8, 8, 11, 11, 11, 15, 9, 13, 11].concat(R.rest ? [20, 13, 10, 10, 10] : []));

    // 2) 대진표 생성 기준
    ws = wb.addWorksheet("대진표 생성 기준");
    header(ws, ["구분", "항목", "값", "비고"]);
    var men = R.roster.filter(function (p) { return p.gender === "남"; }).length;
    var typeCnt = { "남복": 0, "여복": 0, "혼복": 0 };
    R.rows.forEach(function (r) { typeCnt[r.type] += 1; });
    var endFull = Scheduler.slotTime(s.start, s.minutes, R.S);
    var info = [
      ["기록", "날짜", s.date, ""],
      ["기록", "대진 번호", R.seed, "같은 설정·명단(참가·퇴장 시각 포함)·번호·앱 버전이면 같은 대진"],
      ["기록", "앱 버전", R.version, "scheduler.js의 SCHEDULER_VERSION"],
      ["설정", "시작 시각", s.start, ""],
      ["설정", "종료 시각", s.end, "마지막 경기가 이 시각까지 끝남"],
      ["설정", "경기 시간(분)", s.minutes, "경기 사이 휴식 없음"],
      ["설정", "코트 수", s.courts, ""],
      ["설정", "1인당 최대 경기 수", s.maxGames ? s.maxGames : "제한 없음", "선택 항목"],
      ["계산", "참가 인원", R.roster.length, "남 " + men + " / 여 " + (R.roster.length - men) + " · 늦게 옴 " + R.lateCount + "명 · 일찍 감 " + R.earlyCount + "명"],
      ["계산", "시간대 수", R.S, "⌊(종료 − 시작) ÷ 경기 시간⌋"],
      ["계산", "최대 경기 수", full, "코트 수 × 시간대 수"],
      ["계산", "상한", R.upper, "시간대별 min(코트, ⌊와 있는 인원/4⌋) 합 " + R.ub.bySlot + ", 3칸 창 조건 " + R.ub.byWindow + ", ⌊Σ상한/4⌋ " + R.ub.byH + " 중 작은 값"],
      ["계산", "총 경기 수", R.rows.length, R.rows.length < R.upper ? "상한에서 줄임: " + R.reductions.map(function (x) { return x.from + "→" + x.to + "(" + (x.reason === "parity" ? "성별 짝수" : "탐색") + ")"; }).join(", ") : "상한과 같음"],
      ["계산", "빈 코트", full - R.rows.length, "빈 코트는 뒤쪽 시간대로 (6.5)"],
      ["계산", "시간대별 경기 수", R.loads.join(" / "), ""],
      ["계산", "실제 마지막 경기 종료", R.lastEnd || "-", R.lastEnd && R.lastEnd !== endFull ? "뒤쪽 시간대가 비어 " + endFull + "보다 일찍 끝남" : ""],
      ["계산", "1인당 경기 수", distText(R.people.map(function (p) { return p.games; })), "몫 = 4 × 총 경기 수 × 참여 시간대 수 ÷ Σ참여 시간대 수 (내림 또는 올림, 6.4)"],
      ["계산", "2연속 총 횟수", R.totalDoubles, "사람 간 차이 ≤ 1 (참가자 명단 시트에 사람별 값)"],
      ["계산", "경기 종류별 수", "남복 " + typeCnt["남복"] + " / 여복 " + typeCnt["여복"] + " / 혼복 " + typeCnt["혼복"], "비율은 정하지 않음"],
      ["계산", "같은 상대와 2회 이상 만난 쌍", R.repeatOpp, "참고 지표(규칙 아님). 찾은 대진 " + R.found + "개 중 (시도 " + R.tries + "회)"],
      // 개정 11 (9절): 독립 검증이 ⓗ·ⓗ′를 "위반"과 "참고"로 가르는 근거
      ["계산", "2연속 공평 완화", R.meta.relaxed ? "예" : "아니오", R.meta.relaxed ? "코트를 채우려고 같은 경기 수에서 2연속 차이를 허용함 (6.5 ②)" : "2연속 차이 ≤ 1을 지킴"],
      ["계산", "2연속 차이", fairGap(R), (R.rest ? "남은 시간대 2연속(ⓗ′, 남은 경기 1 이상인 사람)" : "2연속(ⓗ)") + "의 최대 − 최소"],
      ["규칙", "급수 점수", "A=4, B=3, C=2, D=1, 초심=0", ""],
      ["규칙", "방식", "로테이션 복식", "매 경기 파트너·상대 교체"],
      ["규칙", "경기 종류", "남복 vs 남복, 여복 vs 여복, 혼복 vs 혼복", "혼복 팀 = 남 1 + 여 1"],
      ["규칙", "급수 균형", "두 팀 급수 합 차이 ≤ 1", ""],
      ["규칙", "연속 경기", "3연속 금지 (2연속은 코트를 채우는 데 필요할 때만)", "2연속 횟수 사람 간 차이 ≤ 1"],
      ["규칙", "파트너", "같은 파트너 2회 이상 금지", ""],
      R.meta.relaxed ? ["규칙", "완화", "2연속 공평 " + (R.rest ? "(ⓗ′)" : "(ⓗ)"), "코트를 채우려고 차이 " + fairGap(R) + " 허용. 나머지 규칙(3연속 금지 포함)은 완화하지 않음"]
        : ["규칙", "완화", "없음", "규칙을 모두 지키는 대진만 만든다"]
    ];
    if (R.rest) {
      var rm = R.meta.rest, h0 = R.rest.history[0];
      info.splice(3, 0,
        ["기록", "재편성 회차", R.rest.n, "진행 중 변경 횟수 (재편성 기록 시트)"],
        ["기록", "기준 시간대", Scheduler.slotTime(s.start, s.minutes, R.rest.T), "이 시간대까지 진행된 것으로 보고 고정"],
        ["기록", "바탕 대진 번호", R.rest.baseSeed, "이번 재편성의 바탕 대진"],
        ["기록", "처음 대진 번호", h0 ? h0.baseSeed : R.rest.baseSeed, "재편성 전 처음 대진 (대진 번호로 다시 볼 수 있음)"],
        ["계산", "남은 경기 수 M′", R.M, "상한 " + R.upper + (R.M < R.upper ? " (탐색에서 줄임)" : "")],
        ["계산", "λ (참여 시간대 1칸당 경기 수)", fracText(rm.lambda), "≈ " + fracNum(rm.lambda).toFixed(4) + " · 남은 몫 = λ × 참여 시간대 수 − 지금까지 경기"],
        ["계산", "남은 2연속 총 횟수", R.totalDoubles, "남은 경기 1 이상인 사람 간 차이 ≤ 1 (ⓗ′). 하루 전체 " + R.dayDoubles + "회"]);
      info.forEach(function (row) {
        if (row[1] === "상한") { row[2] = R.upper; row[3] = "남은 시간대의 M′ 상한 (6.8.3: 시간대 " + R.ub.bySlot + ", 3칸 창 " + R.ub.byWindow + ", ⌊ΣH′/4⌋ " + R.ub.byH + " 중 작은 값)"; }
        if (row[1] === "총 경기 수") row[3] = "하루 전체 = 진행된 " + (R.rows.length - R.M) + "경기 + 남은 " + R.M + "경기";
        if (row[1] === "1인당 경기 수") row[3] = "하루 합계 = 지금까지 + 남은 배정 (남은 배정은 남은 몫의 내림 또는 올림, 6.8.4)";
        if (row[1] === "2연속 총 횟수") { row[2] = R.dayDoubles; row[3] = "하루 전체 (참고). 판정은 남은 2연속(ⓗ′)"; }
      });
    }
    info.forEach(function (row, i) {
      put(ws, i + 2, 1, row[0]);
      put(ws, i + 2, 2, row[1], { left: true });
      put(ws, i + 2, 3, row[2], { text: typeof row[2] === "string" });
      put(ws, i + 2, 4, row[3], { left: true });
    });
    widths(ws, [8, 28, 40, 64]);

    // 3) 대진표 — verify_schedule.py·verify_v2.py가 읽는 형식. 표 아래에 다른 내용 없음 (경기가 없는 시간대는 행 없음)
    ws = wb.addWorksheet("대진표", { views: [{ state: "frozen", ySplit: 1 }] });
    header(ws, ["경기 순서", "시작 시간", "코트 번호", "팀1 선수1", "팀1 선수2", "팀2 선수1", "팀2 선수2",
      "경기 종류", "팀1 급수 합", "팀2 급수 합", "급수 합 차이"]);
    R.rows.forEach(function (m, i) {
      var r = i + 2;
      put(ws, r, 1, m.no);
      put(ws, r, 2, m.time, { text: true });            // "19:00" 텍스트
      put(ws, r, 3, m.court);
      m.t1.concat(m.t2).forEach(function (p, j) { put(ws, r, 4 + j, p, { text: true }); });
      put(ws, r, 8, m.type, { fill: XL.type[m.type] });
      put(ws, r, 9, m.s1);
      put(ws, r, 10, m.s2);
      put(ws, r, 11, Math.abs(m.s1 - m.s2));
    });
    widths(ws, [10, 10, 10, 12, 12, 12, 12, 10, 12, 12, 12]);

    // 4) 시간×코트 격자 — 경기가 없는 시간대는 줄 전체에 "이 시간에는 경기 없음"
    ws = wb.addWorksheet("시간×코트 격자");
    header(ws, ["시간"].concat(Array.from({ length: s.courts }, function (_, i) { return "코트 " + (i + 1); })));
    var grid = {};
    R.rows.forEach(function (m) { grid[m.slot + ":" + m.court] = m; });
    for (var t = 0; t < R.S; t++) {
      put(ws, t + 2, 1, Scheduler.slotTime(s.start, s.minutes, t) + "~" + Scheduler.slotTime(s.start, s.minutes, t + 1), { text: true });
      if (!R.loads[t]) {
        ws.getRow(t + 2).height = 24;
        for (var c0 = 2; c0 <= s.courts + 1; c0++) put(ws, t + 2, c0, null, { fill: XL.empty });
        if (s.courts > 1) ws.mergeCells(t + 2, 2, t + 2, s.courts + 1);
        put(ws, t + 2, 2, "이 시간에는 경기 없음", { fill: XL.empty, bold: true });
        continue;
      }
      ws.getRow(t + 2).height = 62;
      for (var c = 1; c <= s.courts; c++) {
        var m = grid[t + ":" + c];
        if (m) put(ws, t + 2, c + 1, "[" + m.type + "]\n" + m.t1.join("·") + "\nvs\n" + m.t2.join("·"), { wrap: true, fill: XL.type[m.type], text: true });
        else put(ws, t + 2, c + 1, "(빈 코트)");
      }
    }
    widths(ws, [14].concat(Array.from({ length: s.courts }, function () { return 18; })));

    // 5) 앱 자기 점검 (verify_schedule.py가 쓰는 '검증 결과'와 다른 이름)
    ws = wb.addWorksheet("앱 자기 점검");
    header(ws, ["구분", "항목", "기준", "위반 건수", "판정", "상세 (최대 5건)"]);
    var r = 2;
    R.check.items.concat(R.check.extra).forEach(function (it) {
      put(ws, r, 1, it.code);
      put(ws, r, 2, it.item, { left: true });
      put(ws, r, 3, it.rule, { left: true });
      put(ws, r, 4, it.count);
      if (it.info) put(ws, r, 5, "참고");
      else if (it.relaxNote && it.count === 0) put(ws, r, 5, "참고(완화)", { bold: true });
      else put(ws, r, 5, it.count === 0 ? "통과" : "실패", { bold: true, fill: it.count === 0 ? XL.ok : XL.ng });
      put(ws, r, 6, it.detail, { left: true, wrap: true });
      r++;
    });
    put(ws, r + 1, 2, R.rest ? "필수 항목(ⓐ ⓑ ⓒ ⓓ′ ⓔ ⓕ ⓖ ⓗ′ ⓘ) 위반 합계" : "필수 항목(ⓐ~ⓗ) 위반 합계", { bold: true, left: true });
    put(ws, r + 1, 4, R.check.total, { bold: true });
    put(ws, r + 1, 5, R.check.total === 0 ? "통과" : "실패", { bold: true, fill: R.check.total === 0 ? XL.ok : XL.ng });
    put(ws, r + 2, 2, "checker.js(대진 생성 코드와 별도)가 명단과 대진표를 다시 읽어 센 값", { left: true });
    widths(ws, [8, 34, 30, 11, 8, 60]);

    // 6) 재편성 기록 (9절 개정 10): 회차마다 한 줄
    if (R.rest) {
      ws = wb.addWorksheet("재편성 기록");
      header(ws, ["회차", "기준 시간대", "변동", "바탕 대진 번호", "새 대진 번호", "앱 버전", "λ", "λ (소수)", "남은 경기 수 M′", "2연속 공평 완화"]);
      R.rest.history.forEach(function (h, i) {
        var rr = i + 2;
        put(ws, rr, 1, h.n);
        put(ws, rr, 2, Scheduler.slotTime(s.start, s.minutes, h.T), { text: true });
        put(ws, rr, 3, h.changes.length ? h.changes.map(function (c) { return changeText(c, s.end); }).join(", ") : "변동 없음", { left: true, wrap: true });
        put(ws, rr, 4, h.baseSeed, { text: true });
        put(ws, rr, 5, h.seed, { text: true });
        put(ws, rr, 6, h.version || R.version, { text: true });
        put(ws, rr, 7, fracText(h.lambda), { text: true });
        put(ws, rr, 8, h.lambda ? Math.round(fracNum(h.lambda) * 10000) / 10000 : "-");
        put(ws, rr, 9, h.Mrest);
        // 맨 끝 열 (기존 열 위치는 그대로, plan_w7b 2.4). 2.1.0에서 한 회차는 기록 없음
        put(ws, rr, 10, !h.relax ? "기록 없음" : h.relax.relaxed ? "예 (차이 " + h.relax.gap + ")" : "아니오", { text: true });
      });
      widths(ws, [6, 12, 60, 14, 14, 10, 10, 10, 14, 16]);
    }

    return wb;
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function saveExcel() {
    var R = state.result;
    $("result-error").textContent = "";
    if (IN_KAKAO) { showKakaoResult(); return; }   // 카톡 안에서는 저장을 시도하지 않는다 (4.3)
    if (!confirmIfStale("저장")) return;
    if (typeof ExcelJS === "undefined") {
      $("result-error").textContent = "Excel 기능을 불러오지 못했습니다. lib 폴더가 index.html 옆에 있는지 확인해 주세요.";
      return;
    }
    var name = "대진표_" + R.settings.date.replace(/-/g, "") + "_" + R.seed + (R.rest ? "_재편성" + R.rest.n : "") + ".xlsx";
    buildWorkbook(R).xlsx.writeBuffer().then(function (buf) {
      download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name);
    }).catch(function (e) {
      $("result-error").textContent = "Excel 파일을 만들지 못했습니다. " + (e && e.message ? e.message : "");
    });
  }

  // ── 이미지 공유 (8절) ──────────────────────────────────
  // 휴대폰이 파일 공유를 지원하면 공유 창, 아니면 PNG 내려받기
  function shareImage() {
    var R = state.result;
    $("result-error").textContent = "";
    if (IN_KAKAO) { showKakaoResult(); return; }   // 카톡 안에서는 공유를 시도하지 않는다 (4.3)
    if (!confirmIfStale("공유")) return;
    var name = ScheduleImage.fileName(R);
    ScheduleImage.toPngBlob(R, summaryText(R)).then(function (out) {
      var file = null;
      try { file = new File([out.blob], name, { type: "image/png" }); } catch (e) { file = null; }
      var canShare = false;
      try { canShare = !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch (e) { canShare = false; }
      if (!canShare) { download(out.blob, name); return; }
      return navigator.share({ files: [file], title: "배드민턴 대진표" }).catch(function (e) {
        if (e && e.name === "AbortError") return;      // 사용자가 공유 창을 닫음
        download(out.blob, name);                        // 그 밖의 이유로 공유가 안 되면 내려받기
      });
    }).catch(function (e) {
      $("result-error").textContent = "이미지를 만들지 못했습니다. " + (e && e.message ? e.message : "");
    });
  }

  // ── 카톡 안 브라우저 (4.3) ──────────────────────────────
  // ② 명단 화면 첫머리에 안내. 결과 화면의 안내는 [Excel 저장]·[이미지 공유]를 누를 때 보인다
  function setupKakaoNotice() {
    if (!IN_KAKAO) return;
    var url = String(location.href).split(/[?#]/)[0];
    $("kakao-url").value = url;
    $("kakao-result-url").value = url;
    $("kakao-notice").hidden = false;
  }

  function showKakaoResult() { $("kakao-result").hidden = false; }

  function copyUrl(input, msg) {
    var done = "주소를 복사했습니다. 삼성 인터넷·Chrome 주소창에 붙여 넣어 주세요.";
    function fallback() {
      var ok = false;
      try { input.focus(); input.select(); ok = document.execCommand("copy"); } catch (e) { ok = false; }
      msg.textContent = ok ? done : "주소 칸을 길게 눌러 복사해 주세요.";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(function () { msg.textContent = done; }, fallback);
    } else {
      fallback();
    }
  }

  // ── 연결 ───────────────────────────────────────────────
  function init() {
    $("app-version").textContent = Scheduler.SCHEDULER_VERSION;
    $("build-info").textContent = "앱 버전 " + Scheduler.SCHEDULER_VERSION + " · 화면 수정 " + UI_BUILD;
    renderHome();
    setupKakaoNotice();
    $("kakao-copy").addEventListener("click", function () { copyUrl($("kakao-url"), $("kakao-copy-msg")); });
    $("kakao-result-copy").addEventListener("click", function () { copyUrl($("kakao-result-url"), $("kakao-result-msg")); });

    document.querySelectorAll(".steps [data-step]").forEach(function (b) {
      b.addEventListener("click", function () { goStep(b.getAttribute("data-step")); });
    });

    $("home-new").addEventListener("click", function () {
      state.replaySeed = "";
      startNew([], null, "");
    });
    $("home-last").addEventListener("click", function () {
      var last = loadLast();
      state.replaySeed = "";
      if (last.data) startNew(last.data.roster.map(normalize), last.data.settings || null, "");
    });
    $("home-replay").addEventListener("click", function () {
      var v = $("home-seed").value.trim();
      if (!/^\d{6}$/.test(v)) { $("home-seed-error").textContent = "대진 번호는 6자리 숫자입니다."; return; }
      $("home-seed-error").textContent = "";
      state.replaySeed = v;
      var last = loadLast();
      startNew([], last.data && last.data.settings ? last.data.settings : null, v);   // 지난 설정도 함께 (8절 0)
    });

    ["set-date", "set-start", "set-end", "set-minutes", "set-courts", "set-max"].forEach(function (id) {
      $(id).addEventListener("input", refreshSettings);
    });
    $("settings-back").addEventListener("click", function () { renderHome(); show("home"); });
    $("settings-next").addEventListener("click", enterRoster);

    document.querySelectorAll("[data-method]").forEach(function (b) {
      b.addEventListener("click", function () { setMethod(b.getAttribute("data-method")); });
    });
    $("excel-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) readExcel(f);
      e.target.value = "";
    });
    $("pick-apply").addEventListener("click", function () {
      var cols = {}, bad = false;
      ["name", "gender", "grade"].forEach(function (k) {
        var v = $("pick-" + k).value;
        if (v === "") bad = true; else cols[k] = parseInt(v, 10);
      });
      if (bad) { $("excel-error").textContent = "이름·성별·급수 열을 모두 골라 주세요."; return; }
      ["arrival", "leave"].forEach(function (k) {   // 참가·퇴장 시각 열은 고르지 않아도 된다
        var v = $("pick-" + k).value;
        if (v !== "") cols[k] = parseInt(v, 10);
      });
      var chosen = Object.keys(cols).map(function (k) { return cols[k]; });
      if (chosen.some(function (v, i) { return chosen.indexOf(v) !== i; })) {
        $("excel-error").textContent = "서로 다른 열을 골라 주세요."; return;
      }
      $("excel-error").textContent = "";
      applySheet(cols);
    });

    $("roster-add").addEventListener("click", function () {
      state.roster.push({ name: "", gender: "", grade: "", arrival: "", leave: "" });
      renderRoster();
      var inputs = $("roster-body").querySelectorAll("input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $("roster-clear").addEventListener("click", function () {
      if (state.roster.length && !window.confirm("표의 명단을 모두 지울까요?")) return;
      state.roster = [];
      renderRoster();
    });
    $("set-seed").addEventListener("input", refreshRosterChecks);
    $("roster-back").addEventListener("click", function () {
      if (state.running) state.running.cancelled = true;
      enterSettings();
    });
    $("roster-run").addEventListener("click", function () { runGenerate(false); });
    $("run-cancel").addEventListener("click", function () { if (state.running) state.running.cancelled = true; });

    document.querySelectorAll("[data-rtab]").forEach(function (b) {
      b.addEventListener("click", function () { setResultTab(b.getAttribute("data-rtab")); });
    });
    $("mine-name").addEventListener("change", function () { renderMine($("mine-name").value); });
    $("result-excel").addEventListener("click", saveExcel);
    $("result-image").addEventListener("click", shareImage);
    $("stale-rerun").addEventListener("click", function () {
      if (readSettings().errors.length) { enterSettings(); return; }   // 설정 오류는 ① 화면에서 보인다
      if (!rosterStatus().ok) { enterRoster(); return; }               // 명단이 덜 고쳐졌으면 ② 화면에서
      runGenerate(false);
    });
    $("result-again").addEventListener("click", function () {
      var R = state.result;
      if (R && R.rest) {
        var why = restLock();
        if (why) { $("result-rest-msg").textContent = why; return; }
        var h = R.rest.history[R.rest.history.length - 1];
        runRest(true, { T: h.T, changes: h.changes, replaceLast: true });   // 같은 변동, 새 번호 (마지막 회차를 그 바탕에서 다시)
      } else runGenerate(true);
    });
    $("result-roster").addEventListener("click", enterRoster);

    // 진행 중 재편성 (8.1)
    $("home-today").addEventListener("click", function () {
      var td = loadToday();
      if (td) { state.today = td; showToday(td); }
    });
    $("result-rest").addEventListener("click", enterRest);
    $("result-undo").addEventListener("click", undoRest);
    // 2. 변동 (개정 13): 이름 칸을 누르면 이름 버튼, 글자를 치면 거름 (화면 위치 그대로)
    $("rest-name").addEventListener("click", toggleNames);
    $("rest-filter").addEventListener("input", function () {
      state.restForm.filter = $("rest-filter").value;
      keepScroll(renderRestNames);
    });
    $("rest-run").addEventListener("click", function () { runRest(false, null); });
    $("rest-cancel").addEventListener("click", function () { if (state.running) state.running.cancelled = true; });
    $("rest-back").addEventListener("click", function () {
      if (state.running) state.running.cancelled = true;
      restViewBase = null;
      show("result");
    });

    show("home");
  }

  init();
})();
