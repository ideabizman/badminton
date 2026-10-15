/*
 * image.js — 전체 대진표(시간 × 코트 격자) 한 장을 PNG로 그린다 (CLAUDE.md 8절 이미지 공유).
 * 외부 라이브러리 없이 캔버스에 직접 그린다. 크기는 기기 화면 배율과 관계없이 고정 픽셀이다.
 */
(function (global) {
  "use strict";

  var L = {
    pad: 24, timeW: 170, cellW: 300, headerH: 150, headRowH: 56, rowH: 150, legendH: 70,
    nameFont: 28, nameFontMin: 22
  };
  var FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
  var COLOR = {
    bg: "#ffffff", text: "#1f2328", muted: "#5f6b7a", line: "#a6a6a6", head: "#dde4ee",
    empty: "#f2f2f2", emptyText: "#808080",
    type: { "남복": "#dce9f7", "여복": "#fbe3ea", "혼복": "#e6f2df" }   // 화면 style.css·Excel과 같은 색
  };

  function size(courts, nSlots) {
    return {
      width: L.pad * 2 + L.timeW + L.cellW * courts,
      height: L.pad + L.headerH + L.headRowH + L.rowH * nSlots + L.legendH + L.pad
    };
  }

  function pad2(v) { return (v < 10 ? "0" : "") + v; }

  function dateLabel(s) {
    var d = new Date(s + "T00:00:00");
    if (isNaN(d)) return s;
    return s + " (" + "일월화수목금토".charAt(d.getDay()) + ")";
  }

  function fileName(R) {
    return "대진표_" + R.settings.date.replace(/-/g, "") + "_" + R.seed + ".png";
  }

  function font(px, bold) { return (bold ? "bold " : "") + px + "px " + FONT; }

  // 글자가 maxW보다 넓으면 글자 크기를 minPx까지 줄인다. 그래도 넓으면 칸 안에서 자른다
  function fitText(ctx, text, x, y, maxW, px, minPx, bold, stats) {
    var cur = px;
    ctx.font = font(cur, bold);
    while (ctx.measureText(text).width > maxW && cur > minPx) { cur -= 1; ctx.font = font(cur, bold); }
    if (stats) {
      if (cur < px) stats.shrunk += 1;
      stats.minFont = Math.min(stats.minFont, cur);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - maxW / 2, y - cur, maxW, cur * 2);
    ctx.clip();
    ctx.fillText(text, x, y);
    ctx.restore();
    if (stats && ctx.measureText(text).width > maxW) stats.clipped += 1;
  }

  // R: app.js의 결과 객체 (settings, seed, version, roster, rows, plan, fewer)
  function draw(R, canvas) {
    var s = R.settings;
    var courts = s.courts, nSlots = R.plan.nSlots;
    var sz = size(courts, nSlots);
    canvas = canvas || document.createElement("canvas");
    canvas.width = sz.width;
    canvas.height = sz.height;
    var ctx = canvas.getContext("2d");
    var stats = { shrunk: 0, clipped: 0, minFont: L.nameFont };
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, sz.width, sz.height);

    // 머리글 3줄: 제목 / 날짜·대진 번호·앱 버전 / 인원·코트·경기 수·1경기 적게
    var center = sz.width / 2, inner = sz.width - L.pad * 2;
    var line2 = dateLabel(s.date) + " · 대진 번호 " + R.seed + " · 앱 버전 " + R.version;
    var line3 = R.roster.length + "명 · " + courts + "면 · " + R.rows.length + "경기" +
      (R.fewer.length ? " · 1경기 적게: " + R.fewer.join(", ") : "");
    ctx.fillStyle = COLOR.text;
    fitText(ctx, "배드민턴 대진표", center, L.pad + 26, inner, 36, 24, true, null);
    fitText(ctx, line2, center, L.pad + 76, inner, 26, 18, true, null);
    ctx.fillStyle = COLOR.muted;
    fitText(ctx, line3, center, L.pad + 120, inner, 24, 16, false, null);

    var top = L.pad + L.headerH;
    var x0 = L.pad, xGrid = L.pad + L.timeW;

    // 열 제목
    ctx.fillStyle = COLOR.head;
    ctx.fillRect(x0, top, L.timeW + L.cellW * courts, L.headRowH);
    ctx.fillStyle = COLOR.text;
    ctx.font = font(24, true);
    ctx.fillText("시간", x0 + L.timeW / 2, top + L.headRowH / 2);
    for (var c = 1; c <= courts; c++) ctx.fillText("코트 " + c, xGrid + L.cellW * (c - 1) + L.cellW / 2, top + L.headRowH / 2);

    var bySlot = {};
    R.rows.forEach(function (r) { bySlot[r.slot + ":" + r.court] = r; });
    var y = top + L.headRowH;
    for (var slot = 0; slot < nSlots; slot++) {
      ctx.fillStyle = COLOR.head;
      ctx.fillRect(x0, y, L.timeW, L.rowH);
      ctx.fillStyle = COLOR.text;
      ctx.font = font(24, true);
      ctx.fillText(Scheduler.slotTime(s.start, s.minutes, slot), x0 + L.timeW / 2, y + L.rowH / 2 - 16);
      ctx.font = font(22, false);
      ctx.fillText("~" + Scheduler.slotTime(s.start, s.minutes, slot + 1), x0 + L.timeW / 2, y + L.rowH / 2 + 16);
      for (c = 1; c <= courts; c++) {
        var cx = xGrid + L.cellW * (c - 1);
        var mid = cx + L.cellW / 2;
        var m = bySlot[slot + ":" + c];
        if (m) {
          ctx.fillStyle = COLOR.type[m.type];
          ctx.fillRect(cx, y, L.cellW, L.rowH);
          ctx.fillStyle = COLOR.muted;
          ctx.font = font(22, false);
          ctx.fillText(m.type, mid, y + 24);
          ctx.fillText("vs", mid, y + 88);
          ctx.fillStyle = COLOR.text;
          fitText(ctx, m.t1.join(" · "), mid, y + 57, L.cellW - 16, L.nameFont, L.nameFontMin, true, stats);
          fitText(ctx, m.t2.join(" · "), mid, y + 120, L.cellW - 16, L.nameFont, L.nameFontMin, true, stats);
        } else {
          ctx.fillStyle = COLOR.empty;
          ctx.fillRect(cx, y, L.cellW, L.rowH);
          ctx.fillStyle = COLOR.emptyText;
          ctx.font = font(24, false);
          ctx.fillText("(빈 코트)", mid, y + L.rowH / 2);
        }
      }
      y += L.rowH;
    }

    // 칸 선
    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 1;
    var gridBottom = top + L.headRowH + L.rowH * nSlots;
    var gridRight = xGrid + L.cellW * courts;
    ctx.beginPath();
    for (var yy = top; yy <= gridBottom; yy += (yy === top ? L.headRowH : L.rowH)) { ctx.moveTo(x0, yy + 0.5); ctx.lineTo(gridRight, yy + 0.5); }
    ctx.moveTo(x0 + 0.5, top); ctx.lineTo(x0 + 0.5, gridBottom);
    for (c = 0; c <= courts; c++) { var xx = xGrid + L.cellW * c; ctx.moveTo(xx + 0.5, top); ctx.lineTo(xx + 0.5, gridBottom); }
    ctx.stroke();

    // 경기 종류 색 설명
    var ly = gridBottom + L.legendH / 2;
    var lx = x0;
    ctx.textAlign = "left";
    ctx.font = font(22, false);
    ["남복", "여복", "혼복"].forEach(function (k) {
      ctx.fillStyle = COLOR.type[k];
      ctx.fillRect(lx, ly - 16, 80, 32);
      ctx.strokeRect(lx + 0.5, ly - 15.5, 79, 31);
      ctx.fillStyle = COLOR.text;
      ctx.textAlign = "center";
      ctx.fillText(k, lx + 40, ly);
      lx += 96;
    });
    ctx.textAlign = "left";
    ctx.fillStyle = COLOR.muted;
    ctx.fillText(R.rows.length + "경기 · " + s.minutes + "분씩 · " + s.start + " ~ " + Scheduler.slotTime(s.start, s.minutes, nSlots), lx + 12, ly);

    return { canvas: canvas, width: sz.width, height: sz.height, stats: stats };
  }

  function toPngBlob(R) {
    var d = draw(R);
    return new Promise(function (resolve, reject) {
      d.canvas.toBlob(function (blob) {
        if (blob) resolve({ blob: blob, width: d.width, height: d.height, stats: d.stats });
        else reject(new Error("이미지를 만들지 못했습니다."));
      }, "image/png");
    });
  }

  global.ScheduleImage = { LAYOUT: L, COLOR: COLOR, size: size, draw: draw, toPngBlob: toPngBlob, fileName: fileName };
})(this);
