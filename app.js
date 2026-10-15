/*
 * app.js — 화면 동작. 대진 생성 규칙은 scheduler.js, 자기 점검은 checker.js에 있다.
 * 명단은 이 브라우저 안에서만 다루고, 외부로 보내지 않는다.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "w_badminton_last_roster";
  var GENDERS = ["남", "여"];
  var GRADES = ["A", "B", "C", "D", "초심"];
  var COLUMN_ALIASES = { name: ["이름", "성명"], gender: ["성별"], grade: ["급수", "출전급수"] };
  var MIN_PLAYERS = 8;
  var STEP_BUDGET_MS = 40;   // 한 번에 계산하는 시간. 그 사이에 화면을 다시 그린다
  // 화면 수정일 (12절: 다시 올린 뒤 새 화면이 보이는지 확인용). 생성 결과와 관계없으므로 SCHEDULER_VERSION과 따로 둔다.
  // 바꿀 때 index.html의 ?v= 날짜도 함께 바꾼다
  var UI_BUILD = "2026-10-15";
  var STALE_MSG = "명단·설정이 바뀌었습니다. [다시 만들기]를 눌러야 반영됩니다";

  var state = {
    roster: [],             // [{name, gender, grade}] (입력 그대로, 정리는 normalize에서)
    replaySeed: "",         // "대진 번호로 다시 보기"로 들어온 번호
    fileSettings: null,     // 불러온 Excel의 '대진표 생성 기준' 값 (이 앱이 저장한 파일일 때)
    settings: null,
    settingsRosterSize: null,
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

  // ── 화면 전환 ───────────────────────────────────────────
  var VIEWS = ["home", "roster", "settings", "result"];
  var currentView = "home";

  function show(view) {
    currentView = view;
    VIEWS.forEach(function (v) { $("view-" + v).hidden = v !== view; });
    if (view === "result") updateStale();
    refreshSteps();
    window.scrollTo(0, 0);
  }

  // ── 진행 표시를 눌러 단계 이동 (8절, W4) ─────────────────
  function rosterStatus() {
    var checks = validate(state.roster);
    var n = 0, warn = 0;
    checks.forEach(function (c) { if (!c.blank) n += 1; if (c.msgs.length) warn += 1; });
    return { n: n, warn: warn, ok: warn === 0 && n >= MIN_PLAYERS };
  }

  // 단계마다 누를 수 없으면 그 이유, 누를 수 있으면 ""
  function stepLock(step) {
    if (state.running) return "대진을 찾는 중입니다. 끝나거나 [멈추기]를 누른 뒤 옮길 수 있습니다";
    if (step === "settings") {
      var st = rosterStatus();
      if (!st.ok) return "명단을 먼저 완성해 주세요: 8명 이상, ⚠ 0개 (지금 " + st.n + "명, ⚠ " + st.warn + "개)";
    }
    if (step === "result" && !state.result) return "아직 만든 대진표가 없습니다. ② 설정에서 [대진 만들기]를 눌러 주세요";
    return "";
  }

  // 명단을 고치거나 찾기가 끝나면 다시 그린다. 그때 지난 이유 줄은 지운다
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
    if (step === "roster") { renderRoster(); renderReplayNotice(); show("roster"); }
    else if (step === "settings") goSettings();
    else if (step === "result") show("result");
  }

  // [다음]과 진행 표시 ②가 같은 길로 들어간다. 빈 줄을 정리하고 지난 명단을 저장한다
  function goSettings() {
    var players = validPlayers();
    state.roster = players;
    var saved = saveLast(players);
    enterSettings();
    if (!saved) $("settings-error").textContent = "이 브라우저에서는 기억할 수 없음 (지난 명단을 저장하지 못했습니다).";
  }

  // ── 결과가 지금 명단·설정과 맞는지 (8절, W4) ──────────────
  function snapshot(roster, s) {
    return JSON.stringify({
      roster: roster.map(function (p) { return [p.name, p.gender, p.grade]; }),
      settings: [s.date, s.start, s.minutes, s.courts, s.games, s.seed]
    });
  }

  function currentSnapshot() {
    var rs = readSettings();
    if (rs.errors.length) return "(설정 오류)";
    return snapshot(Scheduler.sortRoster(validPlayers()), rs.s);
  }

  function isStale() {
    return !!state.result && currentSnapshot() !== state.result.snapshot;
  }

  function updateStale() {
    $("result-stale").hidden = !isStale();
  }

  // 낡은 결과를 저장·공유하기 전에 묻는다. 계속하면 true
  function confirmIfStale(what) {
    if (!isStale()) return true;
    return window.confirm(STALE_MSG + "\n\n이전 결과로 " + what + "할까요?");
  }

  // ── 명단: 정리와 확인 (4절) ─────────────────────────────
  function normalize(p) {
    var name = String(p.name == null ? "" : p.name).trim();
    var gender = String(p.gender == null ? "" : p.gender).trim();
    var grade = String(p.grade == null ? "" : p.grade).trim();
    if (/^[a-d]$/.test(grade)) grade = grade.toUpperCase();   // 허용된 자동 처리는 공백 제거와 a–d 대문자뿐
    return { name: name, gender: gender, grade: grade };
  }

  function isBlank(p) { return !p.name && !p.gender && !p.grade; }

  // 빈 줄은 빼고, 각 줄의 ⚠ 내용을 돌려준다
  function validate(roster) {
    var rows = roster.map(normalize);
    var counts = {};
    rows.forEach(function (p) { if (p.name) counts[p.name] = (counts[p.name] || 0) + 1; });
    return rows.map(function (p) {
      if (isBlank(p)) return { blank: true, msgs: [] };
      var msgs = [];
      if (!p.name) msgs.push("이름을 넣어 주세요");
      else if (counts[p.name] > 1) msgs.push("같은 이름이 있습니다. " + p.name + "(1)처럼 구분해 주세요");
      if (!p.gender) msgs.push("성별을 골라 주세요");
      else if (GENDERS.indexOf(p.gender) < 0) msgs.push("'" + p.gender + "'는 쓸 수 없는 성별입니다 (남/여)");
      if (!p.grade) msgs.push("급수를 골라 주세요");
      else if (GRADES.indexOf(p.grade) < 0) msgs.push("'" + p.grade + "'는 쓸 수 없는 급수입니다 (A/B/C/D/초심)");
      return { blank: false, msgs: msgs };
    });
  }

  function validPlayers() {
    return state.roster.map(normalize).filter(function (p) { return !isBlank(p); });
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

  function renderRoster() {
    var body = $("roster-body");
    clear(body);
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
      var cell = tr.children[4];
      cell.textContent = c.msgs.length ? "⚠ " + c.msgs.join(" / ") : (c.blank ? "(빈 줄)" : "");
      warnCount += c.msgs.length ? 1 : 0;
      var msgs = c.msgs.join(" ");
      tr.children[1].firstChild.classList.toggle("bad", /이름/.test(msgs));
      tr.children[2].firstChild.classList.toggle("bad", /성별/.test(msgs));
      tr.children[3].firstChild.classList.toggle("bad", /급수/.test(msgs));
    });

    var players = state.roster.map(normalize).filter(function (p, i) { return !checks[i].blank; });
    renderSummary(players, warnCount);

    var reasons = [];
    if (warnCount > 0) reasons.push("⚠ 표시가 " + warnCount + "줄 있습니다. 고친 뒤 넘어갈 수 있습니다.");
    if (players.length < MIN_PLAYERS) reasons.push("8명 이상이어야 합니다 (지금 " + players.length + "명). 연속 경기 없이 돌아가려면 1코트라도 8명이 필요합니다.");
    $("roster-next").disabled = reasons.length > 0;
    $("roster-block").textContent = reasons.join(" ");
    refreshSteps();
  }

  function renderSummary(players, warnCount) {
    var box = $("roster-summary");
    clear(box);
    var men = players.filter(function (p) { return p.gender === "남"; }).length;
    var women = players.filter(function (p) { return p.gender === "여"; }).length;
    box.appendChild(el("p", null, [
      el("b", { text: "인원 " + players.length + "명" }),
      " · 남 " + men + " / 여 " + women + (warnCount ? " · ⚠ " + warnCount + "줄" : "")
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

  // ── 지난 명단 (3절: 이 기기 안에 하나만) ───────────────────
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

  function saveLast(players) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: todayStr(), roster: players }));
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
      $("home-last-hint").textContent = "지난 명단: " + last.data.roster.length + "명 (" + last.data.savedAt + " 저장)";
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

  var pendingSheet = null;   // 열을 고르는 동안 들고 있는 표 [[...], ...]

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
        var table = [];
        var width = ws.columnCount;
        ws.eachRow({ includeEmpty: true }, function (row, r) {
          var vals = [];
          for (var c = 1; c <= width; c++) vals.push(cellText(row.getCell(c).value).trim());
          table[r - 1] = vals;
        });
        for (var i = 0; i < table.length; i++) if (!table[i]) table[i] = [];
        if (!table.length) throw new Error("빈 시트입니다.");
        state.fileSettings = readFileSettings(wb);
        pendingSheet = table;
        var header = table[0];
        var found = {};
        Object.keys(COLUMN_ALIASES).forEach(function (k) {
          for (var j = 0; j < COLUMN_ALIASES[k].length; j++) {
            var idx = header.indexOf(COLUMN_ALIASES[k][j]);
            if (idx >= 0) { found[k] = idx; break; }
          }
        });
        if ("name" in found && "gender" in found && "grade" in found) {
          applySheet(found);
        } else {
          showColumnPicker(header, found);
        }
      }).catch(function (e) {
        $("excel-error").textContent = "Excel 파일을 읽지 못했습니다 (.xlsx 파일인지 확인해 주세요). " + (e && e.message ? e.message : "");
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function showColumnPicker(header, found) {
    ["name", "gender", "grade"].forEach(function (k) {
      var sel = $("pick-" + k);
      clear(sel);
      sel.appendChild(el("option", { value: "", text: "고르기" }));
      header.forEach(function (h, i) {
        sel.appendChild(el("option", { value: String(i), text: colLetter(i + 1) + "열" + (h ? ": " + h : "") }));
      });
      sel.value = k in found ? String(found[k]) : "";
    });
    $("column-picker").hidden = false;
  }

  function applySheet(cols) {
    var rows = pendingSheet.slice(1).map(function (r) {
      return { name: r[cols.name] || "", gender: r[cols.gender] || "", grade: r[cols.grade] || "" };
    }).filter(function (p) { return !isBlank(normalize(p)); });
    if (validPlayers().length && !window.confirm("지금 표에 있는 명단을 지우고 Excel 명단(" + rows.length + "명)으로 바꿀까요?")) return;
    state.roster = rows;
    $("column-picker").hidden = true;
    pendingSheet = null;
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
      version: map["앱 버전"],
      seed: map["대진 번호"] || "",
      date: map["날짜"] || "",
      start: map["시작 시각"] || "",
      minutes: map["경기 시간(분)"] || "",
      courts: map["코트 수"] || "",
      games: map["1인당 경기 수"] || ""
    };
  }

  function renderReplayNotice() {
    var box = $("replay-notice");
    clear(box);
    var lines = [];
    if (state.replaySeed) {
      lines.push("대진 번호 " + state.replaySeed + "로 다시 봅니다. 그날의 명단을 지난 명단 또는 Excel 불러오기로 넣어 주세요.");
    }
    var fs = state.fileSettings;
    if (fs) {
      lines.push("불러온 파일의 대진 번호 " + (fs.seed || "-") + ", 앱 버전 " + fs.version + ". 설정 화면에 그 값을 채워 둡니다.");
      if (fs.version !== Scheduler.SCHEDULER_VERSION) {
        lines.push("⚠ 이 파일은 앱 버전 " + fs.version + "로 만들었고 지금은 " + Scheduler.SCHEDULER_VERSION + "입니다. 같은 대진이 나오지 않을 수 있습니다.");
      }
    }
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

  function startRoster(roster) {
    state.roster = roster;
    state.fileSettings = null;
    state.result = null;
    setMethod("direct");
    renderRoster();
    renderReplayNotice();
    show("roster");
  }

  // ── 설정 (5절) ─────────────────────────────────────────
  function enterSettings() {
    var players = Scheduler.sortRoster(validPlayers());
    var n = players.length;
    var s = state.settings;
    if (!s) {
      s = state.settings = { date: todayStr(), start: "19:00", minutes: 15, courts: Scheduler.recommendedCourts(n), games: 4, seed: "" };
    } else if (state.settingsRosterSize !== n) {
      s.courts = Scheduler.recommendedCourts(n);   // 인원이 바뀌면 권장값으로 다시 맞춘다
    }
    state.settingsRosterSize = n;
    var fs = state.fileSettings;
    if (fs) {
      if (fs.date) s.date = fs.date;
      if (/^\d{1,2}:\d{2}$/.test(fs.start)) s.start = pad2(parseInt(fs.start, 10)) + fs.start.slice(fs.start.indexOf(":"));
      if (/^\d+$/.test(fs.minutes)) s.minutes = parseInt(fs.minutes, 10);
      if (/^\d+$/.test(fs.courts)) s.courts = parseInt(fs.courts, 10);
      if (/^\d+$/.test(fs.games)) s.games = parseInt(fs.games, 10);
      if (/^\d{6}$/.test(fs.seed)) s.seed = fs.seed;
      state.fileSettings = null;   // 한 번만 채운다
    }
    if (state.replaySeed) { s.seed = state.replaySeed; state.replaySeed = ""; }

    $("set-date").value = s.date;
    $("set-start").value = s.start;
    $("set-minutes").value = s.minutes;
    $("set-courts").value = s.courts;
    $("set-games").value = s.games;
    $("set-seed").value = s.seed;
    $("set-courts-hint").textContent = "권장 " + Scheduler.recommendedCourts(n) + "면 (" + n + "명 ÷ 8, 내림)";
    $("run-status").hidden = true;
    $("run-fail").hidden = true;
    refreshSettings();
    show("settings");
  }

  function readSettings() {
    var errors = [];
    var s = {
      date: $("set-date").value,
      start: $("set-start").value,
      minutes: Number($("set-minutes").value),
      courts: Number($("set-courts").value),
      games: Number($("set-games").value),
      seed: $("set-seed").value.trim()
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) errors.push("날짜를 골라 주세요.");
    if (!/^\d{2}:\d{2}/.test(s.start)) errors.push("시작 시각을 넣어 주세요.");
    else s.start = s.start.slice(0, 5);
    if (!(Number.isInteger(s.minutes) && s.minutes >= 1)) errors.push("경기 시간은 1 이상의 정수(분)로 넣어 주세요.");
    if (!(Number.isInteger(s.courts) && s.courts >= 1)) errors.push("코트 수는 1 이상의 정수로 넣어 주세요.");
    if (!(Number.isInteger(s.games) && s.games >= 1)) errors.push("1인당 경기 수는 1 이상의 정수로 넣어 주세요.");
    if (s.seed && !/^\d{6}$/.test(s.seed)) errors.push("대진 번호는 6자리 숫자입니다 (비우면 새 번호).");
    return { s: s, errors: errors };
  }

  function refreshSettings() {
    var rs = readSettings();
    $("settings-error").textContent = rs.errors.join(" ");
    $("settings-run").disabled = rs.errors.length > 0 || !!state.running;
    var box = $("settings-preview");
    clear(box);
    var warnBox = $("settings-warnings");
    clear(warnBox);
    warnBox.hidden = true;
    if (rs.errors.length) return;
    var s = rs.s;
    state.settings = s;
    var players = validPlayers();
    var n = players.length;
    var plan = Scheduler.computePlan(n, s.courts, s.games);
    var end = Scheduler.slotTime(s.start, s.minutes, plan.nSlots);
    var dist = plan.extra
      ? (plan.base + 1) + "경기 × " + plan.extra + "개" + (plan.nSlots - plan.extra ? " + " + plan.base + "경기 × " + (plan.nSlots - plan.extra) + "개" : "")
      : plan.base + "경기 × " + plan.nSlots + "개";
    var items = [
      ["참가 인원", n + "명"],
      ["예상 총 경기 수", plan.total + "경기 (" + n + "명 × " + s.games + "경기 ÷ 4" + (plan.r ? ", 나머지 " + plan.r : "") + ")"],
      ["시간대 수", plan.nSlots + "개 (" + dist + ")"],
      ["시간", s.start + " 시작 → " + end + " 종료 예정 (" + s.minutes + "분 × " + plan.nSlots + ")"],
      ["1경기 적게 배정되는 사람", plan.r ? plan.r + "명 (" + (s.games - 1) + "경기). 누구인지는 대진 번호로 정해집니다" : "없음 (모두 " + s.games + "경기)"]
    ];
    var t = el("table");
    items.forEach(function (it) { t.appendChild(el("tr", null, [el("th", { text: it[0] }), el("td", { class: "left", text: it[1] })])); });
    box.appendChild(t);

    var warns = Scheduler.checkFeasibility(players, s.courts, s.games);
    if (warns.length) {
      warnBox.appendChild(el("b", { text: "이 설정으로는 대진을 만들기 어려워 보입니다." }));
      var ul = el("ul");
      warns.forEach(function (w) { ul.appendChild(el("li", { text: w.reason + " → " + w.fix })); });
      warnBox.appendChild(ul);
      warnBox.appendChild(el("p", { class: "hint", text: "그래도 [대진 만들기]를 눌러 시도해 볼 수 있습니다. 앱이 설정값을 바꾸지는 않습니다." }));
      warnBox.hidden = false;
    }
  }

  function newSeed() {
    var a = new Uint32Array(1);
    window.crypto.getRandomValues(a);
    return String(100000 + (a[0] % 900000));
  }

  function runGenerate(forceNewSeed) {
    var rs = readSettings();
    if (rs.errors.length) { refreshSettings(); return; }
    var s = rs.s;
    if (forceNewSeed || !s.seed) s.seed = newSeed();
    $("set-seed").value = s.seed;
    state.settings = s;

    var roster = Scheduler.sortRoster(validPlayers());   // 7절: 입력 순서와 관계없이 같은 대진
    var search = Scheduler.createSearch(roster, s.courts, s.games, parseInt(s.seed, 10));
    var run = state.running = { cancelled: false };
    $("run-fail").hidden = true;
    $("run-status").hidden = false;
    $("settings-run").disabled = true;
    $("run-text").textContent = "대진을 찾는 중입니다… (대진 번호 " + s.seed + ")";
    $("run-progress").value = 0;

    function tick() {
      if (run.cancelled) return finish(null);
      var st = search.step(STEP_BUDGET_MS);
      var pct = Math.max(st.found / Scheduler.SOLUTIONS_TO_COMPARE, st.tries / st.maxTries) * 100;
      $("run-progress").value = Math.min(100, pct);
      $("run-text").textContent = "대진을 찾는 중입니다… 조건에 맞는 대진 " + st.found + "/" + Scheduler.SOLUTIONS_TO_COMPARE +
        "개 · 시도 " + st.tries + "회 (대진 번호 " + s.seed + ")";
      if (st.done) finish(search.result());
      else setTimeout(tick, 0);
    }

    function finish(res) {
      state.running = null;
      refreshSteps();
      $("run-status").hidden = true;
      refreshSettings();
      if (!res) return;
      if (!res.ok) return showFailure(res, roster, s);
      buildResult(res, roster, s);
      show("result");
    }

    if (currentView !== "settings") show("settings");   // 진행 상황은 ② 화면에 보인다
    else refreshSteps();
    setTimeout(tick, 0);
  }

  // 안내 내용은 advice.js가 고른다 (5.1: 생성 코드와 분리)
  function showFailure(res, roster, s) {
    var adv = Advice.forFailure(roster, s, res);
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
  function buildResult(res, roster, s) {
    var score = Scheduler.GRADE_SCORE;
    var rows = res.matches.map(function (m, i) {
      var t1 = m.t1.map(function (p) { return roster[p].name; });
      var t2 = m.t2.map(function (p) { return roster[p].name; });
      var s1 = m.t1.reduce(function (a, p) { return a + score[roster[p].grade]; }, 0);
      var s2 = m.t2.reduce(function (a, p) { return a + score[roster[p].grade]; }, 0);
      return { no: i + 1, slot: m.slot, time: Scheduler.slotTime(s.start, s.minutes, m.slot), court: m.court,
        t1: t1, t2: t2, type: m.type, s1: s1, s2: s2 };
    });
    var games = {};
    roster.forEach(function (p) { games[p.name] = 0; });
    rows.forEach(function (r) { r.t1.concat(r.t2).forEach(function (p) { games[p] += 1; }); });
    state.result = {
      settings: s,
      seed: s.seed,
      version: res.version,
      roster: roster,
      rows: rows,
      games: games,
      fewer: res.fewer.map(function (i) { return roster[i].name; }),
      plan: res.plan,
      repeatOpp: res.repeatOpp,
      found: res.found,
      tries: res.tries,
      check: Checker.check(roster, rows),
      snapshot: snapshot(roster, s)          // 나중에 명단·설정이 바뀌었는지 비교 (W4)
    };
    renderResult();
  }

  function renderResult() {
    var R = state.result;
    var s = R.settings;
    var meta = $("result-meta");
    clear(meta);
    [["날짜", dateLabel(s.date)], ["대진 번호", R.seed], ["앱 버전", R.version],
     ["코트", s.courts + "면"], ["시간", s.start + " ~ " + Scheduler.slotTime(s.start, s.minutes, R.plan.nSlots)],
     ["인원", R.roster.length + "명 · " + R.rows.length + "경기"]].forEach(function (x) {
      meta.appendChild(el("span", null, [x[0] + " ", el("b", { text: String(x[1]) })]));
    });

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

    var fewer = $("result-fewer");
    clear(fewer);
    if (R.fewer.length) {
      fewer.appendChild(el("p", { text: "1경기 적게 배정된 사람 (" + R.fewer.length + "명, " + (s.games - 1) + "경기): " + R.fewer.join(", ") }));
      fewer.appendChild(el("p", { class: "hint", text: "인원 × 1인당 경기 수가 4로 나누어떨어지지 않아서입니다. 대진 번호로 정해지며, 급수·성별·이름과는 관계없습니다." }));
    }
    fewer.hidden = !R.fewer.length;

    renderGrid();
    renderMineOptions();
    setResultTab("grid");
    $("result-error").textContent = "";
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
    for (var slot = 0; slot < R.plan.nSlots; slot++) {
      var tr = el("tr", null, [el("th", { text: Scheduler.slotTime(s.start, s.minutes, slot) + "~" + Scheduler.slotTime(s.start, s.minutes, slot + 1) })]);
      for (c = 1; c <= s.courts; c++) {
        var m = bySlot[slot + ":" + c];
        if (m) {
          tr.appendChild(el("td", { class: "match t-" + m.type }, [
            el("div", { class: "kind", text: m.type }),
            el("div", { text: m.t1.join(" · ") }),
            el("div", { class: "vs", text: "vs" }),
            el("div", { text: m.t2.join(" · ") })
          ]));
        } else {
          tr.appendChild(el("td", { class: "empty", text: "(빈 코트)" }));
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
    var box = $("mine-list");
    clear(box);
    if (!name) return;
    var mine = R.rows.filter(function (r) { return r.t1.indexOf(name) >= 0 || r.t2.indexOf(name) >= 0; });
    box.appendChild(el("p", null, [el("b", { text: name }), " 님은 " + mine.length + "경기입니다." +
      (R.fewer.indexOf(name) >= 0 ? " (1경기 적게 배정됨)" : "")]));
    var t = el("table");
    t.appendChild(el("tr", null, ["시간", "코트", "파트너", "상대", "종류"].map(function (h) { return el("th", { text: h }); })));
    mine.forEach(function (r) {
      var myTeam = r.t1.indexOf(name) >= 0 ? r.t1 : r.t2;
      var other = myTeam === r.t1 ? r.t2 : r.t1;
      var partner = myTeam.filter(function (p) { return p !== name; })[0];
      t.appendChild(el("tr", null, [
        el("td", { text: r.time }), el("td", { text: String(r.court) }),
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
    ok: "FFE6F2DF", ng: "FFF8D7DA"
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

    // 1) 참가자 명단 — 첫 번째 시트, 1행 머리글 이름/성별/급수
    var ws = wb.addWorksheet("참가자 명단", { views: [{ state: "frozen", ySplit: 1 }] });
    header(ws, ["이름", "성별", "급수", "급수 점수", "배정 경기 수"]);
    R.roster.forEach(function (p, i) {
      var r = i + 2;
      put(ws, r, 1, p.name, { text: true });
      put(ws, r, 2, p.gender);
      put(ws, r, 3, p.grade);
      put(ws, r, 4, Scheduler.GRADE_SCORE[p.grade]);
      put(ws, r, 5, R.games[p.name]);
    });
    widths(ws, [14, 8, 8, 11, 13]);

    // 2) 대진표 생성 기준
    ws = wb.addWorksheet("대진표 생성 기준");
    header(ws, ["구분", "항목", "값", "비고"]);
    var plan = R.plan;
    var men = R.roster.filter(function (p) { return p.gender === "남"; }).length;
    var typeCnt = { "남복": 0, "여복": 0, "혼복": 0 };
    R.rows.forEach(function (r) { typeCnt[r.type] += 1; });
    var perSlot = [];
    for (var t = 0; t < plan.nSlots; t++) perSlot.push(R.rows.filter(function (r) { return r.slot === t; }).length);
    var info = [
      ["기록", "날짜", s.date, ""],
      ["기록", "대진 번호", R.seed, "같은 명단·설정·번호·앱 버전이면 같은 대진"],
      ["기록", "앱 버전", R.version, "scheduler.js의 SCHEDULER_VERSION"],
      ["설정", "시작 시각", s.start, ""],
      ["설정", "경기 시간(분)", s.minutes, "경기 사이 휴식 없음"],
      ["설정", "코트 수", s.courts, "권장 " + Scheduler.recommendedCourts(R.roster.length) + "면 (인원 ÷ 8, 내림, 최소 1면)"],
      ["설정", "1인당 경기 수", s.games, ""],
      ["계산", "참가 인원", R.roster.length, "남 " + men + " / 여 " + (R.roster.length - men)],
      ["계산", "총 경기 수", R.rows.length, R.roster.length + "명 × " + s.games + "경기 ÷ 4" + (plan.r ? " (나머지 " + plan.r + ")" : "")],
      ["계산", "1경기 적게 배정된 사람", R.fewer.length ? R.fewer.join(", ") : "없음",
        R.fewer.length ? R.fewer.length + "명, " + (s.games - 1) + "경기. 대진 번호로 정함 (6.5)" : "모두 " + s.games + "경기"],
      ["계산", "시간대 수", plan.nSlots, "총 경기 수 ÷ 코트 수 (올림)"],
      ["계산", "시간대별 경기 수", perSlot.join(" / "), "고르게 배분"],
      ["계산", "종료 시각", Scheduler.slotTime(s.start, s.minutes, plan.nSlots), s.start + " + " + plan.nSlots + " × " + s.minutes + "분"],
      ["계산", "경기 종류별 수", "남복 " + typeCnt["남복"] + " / 여복 " + typeCnt["여복"] + " / 혼복 " + typeCnt["혼복"], "비율은 정하지 않음"],
      ["계산", "같은 상대와 2회 이상 만난 쌍", R.repeatOpp, "참고 지표(규칙 아님). 찾은 대진 " + R.found + "개 중 최소 (시도 " + R.tries + "회)"],
      ["규칙", "급수 점수", "A=4, B=3, C=2, D=1, 초심=0", ""],
      ["규칙", "방식", "로테이션 복식", "매 경기 파트너·상대 교체"],
      ["규칙", "경기 종류", "남복 vs 남복, 여복 vs 여복, 혼복 vs 혼복", "혼복 팀 = 남 1 + 여 1"],
      ["규칙", "급수 균형", "두 팀 급수 합 차이 ≤ 1", ""],
      ["규칙", "연속 경기", "금지", "경기 후 최소 한 시간대 휴식"],
      ["규칙", "파트너", "같은 파트너 2회 이상 금지", ""],
      ["규칙", "완화", "없음", "규칙을 모두 지키는 대진만 만든다"]
    ];
    info.forEach(function (row, i) {
      put(ws, i + 2, 1, row[0]);
      put(ws, i + 2, 2, row[1], { left: true });
      put(ws, i + 2, 3, row[2], { text: typeof row[2] === "string" });
      put(ws, i + 2, 4, row[3], { left: true });
    });
    widths(ws, [8, 28, 36, 56]);

    // 3) 대진표 — verify_schedule.py가 읽는 형식. 표 아래에 다른 내용 없음
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

    // 4) 시간×코트 격자
    ws = wb.addWorksheet("시간×코트 격자");
    header(ws, ["시간"].concat(Array.from({ length: s.courts }, function (_, i) { return "코트 " + (i + 1); })));
    var grid = {};
    R.rows.forEach(function (m) { grid[m.slot + ":" + m.court] = m; });
    for (t = 0; t < plan.nSlots; t++) {
      put(ws, t + 2, 1, Scheduler.slotTime(s.start, s.minutes, t) + "~" + Scheduler.slotTime(s.start, s.minutes, t + 1), { text: true });
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
      put(ws, r, 5, it.count === 0 ? "통과" : "실패", { bold: true, fill: it.count === 0 ? XL.ok : XL.ng });
      put(ws, r, 6, it.detail, { left: true, wrap: true });
      r++;
    });
    put(ws, r + 1, 2, "필수 항목(ⓐ~ⓕ) 위반 합계", { bold: true, left: true });
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

  // ── 이미지 공유 (8절, W4) ──────────────────────────────
  // 휴대폰이 파일 공유를 지원하면 공유 창, 아니면 PNG 내려받기
  function shareImage() {
    var R = state.result;
    $("result-error").textContent = "";
    if (!confirmIfStale("공유")) return;
    var name = ScheduleImage.fileName(R);
    ScheduleImage.toPngBlob(R).then(function (out) {
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

  // ── 카톡 안 브라우저 (4.1, W4) ─────────────────────────
  // 브라우저 정보는 이 기기 안에서 읽기만 한다
  function setupKakaoNotice() {
    if (!/KAKAOTALK/i.test(navigator.userAgent || "")) return;
    $("kakao-url").value = String(location.href).split(/[?#]/)[0];
    $("kakao-notice").hidden = false;
  }

  function copyUrl() {
    var input = $("kakao-url"), msg = $("kakao-copy-msg");
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
    $("kakao-copy").addEventListener("click", copyUrl);

    document.querySelectorAll(".steps [data-step]").forEach(function (b) {
      b.addEventListener("click", function () { goStep(b.getAttribute("data-step")); });
    });

    $("home-new").addEventListener("click", function () {
      state.replaySeed = "";
      startRoster([]);
    });
    $("home-last").addEventListener("click", function () {
      var last = loadLast();
      state.replaySeed = "";
      if (last.data) startRoster(last.data.roster.map(normalize));
    });
    $("home-replay").addEventListener("click", function () {
      var v = $("home-seed").value.trim();
      if (!/^\d{6}$/.test(v)) { $("home-seed-error").textContent = "대진 번호는 6자리 숫자입니다."; return; }
      $("home-seed-error").textContent = "";
      state.replaySeed = v;
      startRoster([]);
    });

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
      if (cols.name === cols.gender || cols.name === cols.grade || cols.gender === cols.grade) {
        $("excel-error").textContent = "서로 다른 열을 골라 주세요."; return;
      }
      $("excel-error").textContent = "";
      applySheet(cols);
    });

    $("roster-add").addEventListener("click", function () {
      state.roster.push({ name: "", gender: "", grade: "" });
      renderRoster();
      var inputs = $("roster-body").querySelectorAll("input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    $("roster-clear").addEventListener("click", function () {
      if (state.roster.length && !window.confirm("표의 명단을 모두 지울까요?")) return;
      state.roster = [];
      renderRoster();
    });
    $("roster-back").addEventListener("click", function () { renderHome(); show("home"); });
    $("roster-next").addEventListener("click", goSettings);

    ["set-date", "set-start", "set-minutes", "set-courts", "set-games", "set-seed"].forEach(function (id) {
      $(id).addEventListener("input", refreshSettings);
    });
    $("settings-back").addEventListener("click", function () {
      if (state.running) state.running.cancelled = true;
      renderRoster(); show("roster");
    });
    $("settings-run").addEventListener("click", function () { runGenerate(false); });
    $("run-cancel").addEventListener("click", function () { if (state.running) state.running.cancelled = true; });

    document.querySelectorAll("[data-rtab]").forEach(function (b) {
      b.addEventListener("click", function () { setResultTab(b.getAttribute("data-rtab")); });
    });
    $("mine-name").addEventListener("change", function () { renderMine($("mine-name").value); });
    $("result-excel").addEventListener("click", saveExcel);
    $("result-image").addEventListener("click", shareImage);
    $("stale-rerun").addEventListener("click", function () {
      var why = stepLock("settings");
      if (why) { $("result-error").textContent = why; return; }   // 명단이 덜 고쳐졌으면 다시 만들 수 없다
      if (readSettings().errors.length) { goSettings(); return; }   // 설정 오류는 ② 화면에서 보인다
      runGenerate(false);
    });
    $("result-again").addEventListener("click", function () { runGenerate(true); });
    $("result-settings").addEventListener("click", function () { refreshSettings(); show("settings"); });

    show("home");
  }

  init();
})();
