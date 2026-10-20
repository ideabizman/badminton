/*
 * app.js — 화면 동작. 대진 생성 규칙은 scheduler.js, 자기 점검은 checker.js, 실패 안내는 advice.js에 있다.
 * 명단은 이 브라우저 안에서만 다루고, 외부로 보내지 않는다.
 * 개정 8 (W5b): ① 설정 → ② 명단 → ③ 결과. 1인당 경기 수는 입력하지 않고 참여 시간에 비례해 계산한다.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "w_badminton_last_roster";   // 명단 + 설정(plan 2.7)을 함께 저장
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
  var UI_BUILD = "2026-10-20";
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
    running: null
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
  var VIEWS = ["home", "settings", "roster", "result"];
  var currentView = "home";

  function show(view) {
    currentView = view;
    VIEWS.forEach(function (v) { $("view-" + v).hidden = v !== view; });
    if (view === "result") updateStale();
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
    var idx = VIEWS.indexOf(currentView);
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

  function renderHome() {
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
      maxGames: map["1인당 최대 경기 수"] || "", slots: map["시간대 수"] || ""
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
    var same = fs.version === Scheduler.SCHEDULER_VERSION;
    var v1 = /^1\./.test(fs.version);
    if (hm(fs.end)) s.end = hm(fs.end);
    else if (v1 && /^\d+$/.test(fs.slots)) s.end = Scheduler.slotTime(s.start, s.minutes, parseInt(fs.slots, 10));
    s.maxGames = /^\d+$/.test(fs.maxGames) ? parseInt(fs.maxGames, 10) : null;
    fillSettingsInputs(s);
    state.settings = s;
    if (same && /^\d{6}$/.test(fs.seed)) $("set-seed").value = fs.seed;
    state.fileNotice.push("불러온 파일의 설정(" + s.start + "–" + s.end + ", " + s.minutes + "분, " + s.courts + "면" +
      (s.maxGames ? ", 1인당 최대 " + s.maxGames + "경기" : "") + ")을 ① 설정에 채웠습니다." +
      (same && /^\d{6}$/.test(fs.seed) ? " 대진 번호 " + fs.seed + "도 채웠습니다." : ""));
    if (!same) state.fileNotice.push("⚠ 이 파일은 앱 버전 " + fs.version + "로 만들었고 지금은 " + Scheduler.SCHEDULER_VERSION + "입니다. 앱 버전이 달라 같은 대진이 나오지 않습니다. 명단과 설정만 불러왔습니다.");
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
      $("run-text").textContent = "대진을 찾는 중입니다… " + st.M + "경기로 시도 · 조건에 맞는 대진 " + st.found + "/" + Scheduler.SOLUTIONS_TO_COMPARE +
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

  function buildResult(res, roster, s, seed) {
    var score = Scheduler.GRADE_SCORE;
    var genderOf = {};
    roster.forEach(function (p) { genderOf[p.name] = p.gender; });
    var matches = res.matches.slice().sort(function (a, b) { return (a.slot - b.slot) || (a.court - b.court); });
    var rows = matches.map(function (m, i) {
      var t1 = m.t1.map(function (p) { return roster[p].name; });
      var t2 = m.t2.map(function (p) { return roster[p].name; });
      var s1 = m.t1.reduce(function (a, p) { return a + score[roster[p].grade]; }, 0);
      var s2 = m.t2.reduce(function (a, p) { return a + score[roster[p].grade]; }, 0);
      return { no: i + 1, slot: m.slot, time: Scheduler.slotTime(s.start, s.minutes, m.slot), court: m.court,
        t1: t1, t2: t2, type: m.type, s1: s1, s2: s2,
        show1: shownTeam(t1, m.type, genderOf), show2: shownTeam(t2, m.type, genderOf) };   // 화면·이미지용
    });
    var games = {}, slotsOf = {};
    roster.forEach(function (p) { games[p.name] = 0; slotsOf[p.name] = {}; });
    rows.forEach(function (r) { r.t1.concat(r.t2).forEach(function (p) { games[p] += 1; slotsOf[p][r.slot] = true; }); });
    var iv = res.iv;
    var people = roster.map(function (p, i) {
      var x = iv.people[i];
      return { name: p.name, gender: p.gender, grade: p.grade, arrival: p.arrival, leave: p.leave,
        arrivalShown: p.arrival || s.start, leaveShown: p.leave || s.end,
        f: x.f, l: x.l, m: x.m, late: x.late, early: x.early, q: res.q[i], target: res.target[i],
        games: games[p.name], doubles: res.doubles[i], slots: slotsOf[p.name] };
    });
    var byName = {};
    people.forEach(function (p) { byName[p.name] = p; });
    var opts = { start: s.start, end: s.end, minutes: s.minutes, courts: s.courts, maxGames: s.maxGames };
    state.result = {
      settings: s,
      seed: seed,
      version: res.version,
      roster: roster,
      people: people,
      byName: byName,
      rows: rows,
      games: games,
      S: res.S,
      M: res.M,
      upper: res.upper,
      ub: res.ub,
      loads: res.loads,
      reductions: res.reductions,
      totalDoubles: res.totalDoubles,
      repeatOpp: res.repeatOpp,
      found: res.found,
      tries: res.tries,
      lateCount: people.filter(function (p) { return p.late; }).length,
      earlyCount: people.filter(function (p) { return p.early; }).length,
      lastEnd: lastEndText(s, res.loads),
      check: Checker.check(roster, rows, opts),
      snapshot: snapshot(roster, s, seed)          // 나중에 명단·설정이 바뀌었는지 비교
    };
    renderResult();
  }

  function summaryText(R) {
    var s = R.settings;
    return R.roster.length + "명 · " + s.courts + "면 · " + R.rows.length + "경기 · 빈 코트 " + (s.courts * R.S - R.rows.length) +
      " · 2연속 " + R.totalDoubles + "회" + (R.lateCount ? " · 늦게 옴 " + R.lateCount + "명" : "") + (R.earlyCount ? " · 일찍 감 " + R.earlyCount + "명" : "");
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
    $("result-summary").textContent = summaryText(R);

    // 6.6 M 줄임 · 계산으로 정해진 빈 코트 이유
    var red = $("result-reduced");
    clear(red);
    var full = s.courts * R.S;
    var empty = full - R.rows.length;
    if (R.M < R.upper) {
      var why = R.reductions.map(function (r) { return r.reason; });
      red.appendChild(el("p", null, [el("b", { text: "코트를 모두 채우는 대진을 찾지 못해 " + R.M + "경기로 만들었습니다(빈 코트 " + empty + "칸)." })]));
      red.appendChild(el("p", { class: "hint", text: "계산한 최대 " + R.upper + "경기에서 줄인 이유: " +
        (why.indexOf("search") >= 0 ? "규칙을 모두 지키는 대진을 찾지 못함" : "") +
        (why.indexOf("search") >= 0 && why.indexOf("parity") >= 0 ? ", " : "") +
        (why.indexOf("parity") >= 0 ? "남자·여자 출전 합을 짝수로 맞춤" : "") + "." }));
    }
    if (R.upper < full) {
      var pl = { ub: Object.assign({ M: R.upper }, R.ub), parityDrops: R.reductions.filter(function (r) { return r.reason === "parity" && r.from > R.M && R.M === r.to; }).map(function (r) { return r.from; }) };
      var why2 = emptyReasons(pl, s);
      if (why2.length) {
        red.appendChild(el("p", { text: "코트 " + full + "칸 중 " + (full - R.upper) + "칸은 계산으로 비게 됩니다:" }));
        why2.forEach(function (w) { red.appendChild(el("p", { class: "hint", text: "· " + w })); });
      }
    }
    if (R.lastEnd && R.lastEnd !== endFull) red.appendChild(el("p", null, [el("b", { text: "실제 마지막 경기 종료 " + R.lastEnd })]));
    red.hidden = !red.firstChild;

    var chk = $("result-check");
    clear(chk);
    var ok = R.check.total === 0;
    chk.appendChild(el("p", null, [el("b", { text: ok ? "규칙 점검: 모두 통과 (위반 0건)" : "규칙 점검: 위반 " + R.check.total + "건 — 이 대진표는 쓰지 마세요" })]));
    var t = el("table", { class: "check" });
    t.appendChild(el("tr", null, ["항목", "내용", "위반", "판정"].map(function (h) { return el("th", { text: h }); })));
    R.check.items.forEach(function (it) {
      t.appendChild(el("tr", null, [
        el("td", { text: it.code }), el("td", { class: "left", text: it.item }),
        el("td", { text: String(it.count) }),
        el("td", { class: it.count === 0 ? "pass" : "fail", text: it.count === 0 ? "통과" : "실패" })
      ]));
    });
    chk.appendChild(el("div", { class: "table-wrap" }, [t]));
    chk.appendChild(el("p", { class: "hint", text: "점검은 대진을 만든 코드와 따로 만든 코드(checker.js)가 명단과 대진표를 다시 읽어 셉니다." }));

    // 참여 구간이 다른 사람 표 (참가·퇴장·몫·실제)
    var ivBox = $("result-iv");
    clear(ivBox);
    var diff = R.people.filter(function (p) { return p.late || p.early; });
    if (diff.length) {
      ivBox.appendChild(el("p", null, [el("b", { text: "늦게 오거나 일찍 가는 사람 " + diff.length + "명" })]));
      var lt = el("table");
      lt.appendChild(el("tr", null, ["이름", "참가", "퇴장", "참여 시간대", "몫", "실제"].map(function (h) { return el("th", { text: h }); })));
      diff.slice().sort(function (a, b) { return (a.f - b.f) || (a.l - b.l); }).forEach(function (p) {
        lt.appendChild(el("tr", null, [p.name, p.arrivalShown, p.leaveShown, p.m + "개", p.q.toFixed(2), p.games + "경기"].map(function (v) { return el("td", { text: String(v) }); })));
      });
      ivBox.appendChild(el("div", { class: "table-wrap" }, [lt]));
      ivBox.appendChild(el("p", { class: "hint", text: "몫 = 출전 자리(4 × 총 경기 수)를 참여 시간대 수에 비례해 나눈 값. 실제 경기 수는 몫의 내림 또는 올림입니다." }));
    }
    ivBox.hidden = !diff.length;

    renderGrid();
    renderMineOptions();
    setResultTab("grid");
    $("result-error").textContent = "";
    $("kakao-result").hidden = true;
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
      var tr = el("tr", null, [el("th", { text: Scheduler.slotTime(s.start, s.minutes, slot) + "~" + Scheduler.slotTime(s.start, s.minutes, slot + 1) })]);
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
    if (p.late || p.early) box.appendChild(el("p", { class: "late-line", text: "참여 " + intervalLabel(s, p.f, p.l) + " (참가 " + p.arrivalShown + " · 퇴장 " + p.leaveShown + ") · 몫 " + p.q.toFixed(2) + "경기" }));
    var t = el("table");
    t.appendChild(el("tr", null, ["시간", "코트", "파트너", "상대", "종류"].map(function (h) { return el("th", { text: h }); })));
    mine.forEach(function (r) {
      var myTeam = r.t1.indexOf(name) >= 0 ? r.t1 : r.t2;
      var other = myTeam === r.t1 ? r.show2 : r.show1;
      var partner = myTeam.filter(function (x) { return x !== name; })[0];
      var timeCell = el("td", null, [r.time]);
      if (p.slots[r.slot - 1] || p.slots[r.slot + 1]) timeCell.appendChild(el("span", { class: "dbl", text: "연속" }));   // 2연속인 경기
      t.appendChild(el("tr", null, [
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
    header(ws, ["이름", "성별", "급수", "급수 점수", "참가 시각", "퇴장 시각", "참여 시간대 수", "몫", "배정 경기 수", "2연속 횟수"]);
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
    });
    widths(ws, [14, 8, 8, 11, 11, 11, 15, 9, 13, 11]);

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
      ["규칙", "급수 점수", "A=4, B=3, C=2, D=1, 초심=0", ""],
      ["규칙", "방식", "로테이션 복식", "매 경기 파트너·상대 교체"],
      ["규칙", "경기 종류", "남복 vs 남복, 여복 vs 여복, 혼복 vs 혼복", "혼복 팀 = 남 1 + 여 1"],
      ["규칙", "급수 균형", "두 팀 급수 합 차이 ≤ 1", ""],
      ["규칙", "연속 경기", "3연속 금지 (2연속은 코트를 채우는 데 필요할 때만)", "2연속 횟수 사람 간 차이 ≤ 1"],
      ["규칙", "파트너", "같은 파트너 2회 이상 금지", ""],
      ["규칙", "완화", "없음", "규칙을 모두 지키는 대진만 만든다"]
    ];
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
      else put(ws, r, 5, it.count === 0 ? "통과" : "실패", { bold: true, fill: it.count === 0 ? XL.ok : XL.ng });
      put(ws, r, 6, it.detail, { left: true, wrap: true });
      r++;
    });
    put(ws, r + 1, 2, "필수 항목(ⓐ~ⓗ) 위반 합계", { bold: true, left: true });
    put(ws, r + 1, 4, R.check.total, { bold: true });
    put(ws, r + 1, 5, R.check.total === 0 ? "통과" : "실패", { bold: true, fill: R.check.total === 0 ? XL.ok : XL.ng });
    put(ws, r + 2, 2, "checker.js(대진 생성 코드와 별도)가 명단과 대진표를 다시 읽어 센 값", { left: true });
    widths(ws, [8, 34, 30, 11, 8, 60]);

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
    var name = "대진표_" + R.settings.date.replace(/-/g, "") + "_" + R.seed + ".xlsx";
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
    $("result-again").addEventListener("click", function () { runGenerate(true); });
    $("result-roster").addEventListener("click", enterRoster);

    show("home");
  }

  init();
})();
