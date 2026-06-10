/* app.js — Yasuda Status renderer.
 * status.json を GET して、 plugin manifest 由来の tab を動的生成し、 card を描画する。
 * 100% read-only: GET status.json のみ。 POST/書込み系は一切しない。 */
"use strict";

var POLL_MS = 60000;
var FAILURE_THRESHOLD = 3;  // この回数 連続で失敗して初めて "オフライン" を表示 (一時 glitch を無視)
var STALE_MIN = 10;         // generated_at がこの分数より古ければ header に stale 警告
var consecutiveFailures = 0;
var state = { data: null, active: null };

function $(s, r) { return (r || document).querySelector(s); }
function ce(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function toneCls(t) { return t === "pos" ? "pos" : t === "neg" ? "neg" : ""; }
function ago(iso) {
  if (!iso) return "—"; var t = new Date(iso).getTime(); if (isNaN(t)) return iso;
  var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 90) return s + "秒前"; if (s < 5400) return Math.round(s / 60) + "分前"; return Math.round(s / 3600) + "時間前";
}

/* ---------------- card renderers ---------------- */
var R = {
  kpis: function (c) {
    var cells = c.items.map(function (k) {
      return '<div class="kpi"><div class="k">' + esc(k.label) + '</div>' +
        '<div class="v ' + toneCls(k.tone) + '">' + esc(k.value) + '</div>' +
        (k.sub ? '<div class="s ' + toneCls(k.tone) + '">' + esc(k.sub) + '</div>' : '') + '</div>';
    }).join("");
    return '<div class="kpis">' + cells + '</div>';
  },

  table: function (c) {
    if (!c.rows || !c.rows.length) return '<div class="note">' + esc(c.empty || "なし") + '</div>';
    var al = c.aligns || [];
    var head = '<tr>' + c.columns.map(function (h, i) {
      return '<th class="' + (al[i] === "l" ? "l" : "r") + '">' + esc(h) + '</th>'; }).join("") + '</tr>';
    var body = c.rows.map(function (row) {
      return '<tr>' + row.map(function (cell, i) {
        var cls = al[i] === "l" ? "l" : "r", v, sub = "", tone = "";
        if (cell && typeof cell === "object") { v = cell.v; sub = cell.sub; tone = cell.tone; }
        else v = cell;
        return '<td class="' + cls + ' ' + toneCls(tone) + '"><span class="cell-main">' + esc(v) + '</span>' +
          (sub ? '<span class="cell-sub">' + esc(sub) + '</span>' : '') + '</td>';
      }).join("") + '</tr>';
    }).join("");
    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  },

  bars: function (c) {
    if (!c.items || !c.items.length) return '<div class="note">' + esc(c.empty || "なし") + '</div>';
    return c.items.map(function (b) {
      var col = b.color || "var(--cyan)";
      var w = Math.max(0, Math.min(100, b.pct || 0));
      return '<div class="bar-row"><div class="bar-head"><span class="bl">' + esc(b.label) + '</span>' +
        '<span class="br">' + esc(b.value != null ? b.value : (w.toFixed(1) + "%")) + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="background:' + col + ';--w:' + w + '%"></div></div>' +
        (b.sub ? '<div class="bar-sub">' + esc(b.sub) + '</div>' : '') + '</div>';
    }).join("");
  },

  donut: function (c) {
    var segs = (c.segments || []).filter(function (s) { return (s.value || 0) > 0; });
    var total = segs.reduce(function (a, s) { return a + (s.value || 0); }, 0) || 1;
    var R0 = 52, C = 2 * Math.PI * R0, off = 0;
    var rings = segs.map(function (s) {
      var frac = s.value / total, len = frac * C;
      var seg = '<circle r="' + R0 + '" cx="64" cy="64" fill="none" stroke="' + (s.color || "#888") +
        '" stroke-width="18" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) +
        '" transform="rotate(-90 64 64)"/>';
      off += len; return seg;
    }).join("");
    var legend = segs.map(function (s) {
      return '<div class="leg"><span class="sw" style="background:' + (s.color || "#888") + '"></span>' +
        '<span class="ln">' + esc(s.label) + '</span><span class="lv">' +
        Math.round(s.value / total * 100) + '%</span></div>';
    }).join("");
    return '<div class="donut-wrap"><svg class="donut" width="128" height="128" viewBox="0 0 128 128">' + rings +
      (c.center ? '<text x="64" y="68" text-anchor="middle" fill="#cbd5e1" font-size="12" font-weight="700">' + esc(c.center) + '</text>' : '') +
      '</svg><div class="donut-legend">' + legend + '</div></div>';
  },

  signal: function (c) {
    var b = c.state === "FIRED" ? "fired" : c.state === "NO SIGNAL" ? "nosig" : "unk";
    var prog = c.progress != null ? '<div class="prog"><i style="--w:' + Math.round(c.progress * 100) + '%"></i></div>' : '';
    return '<div class="sig"><div class="ico">' + esc(c.icon) + '</div><div class="body">' +
      '<div class="nm">' + esc(c.name) + '</div><div class="dt">' + esc(c.detail) + '</div>' + prog + '</div>' +
      '<span class="badge ' + b + '">' + esc(c.state) + '</span></div>';
  },

  bot: function (c) {
    var b = c.bot;
    var statusPill = { live: "LIVE", paper: "PAPER", monitor: "MONITOR", disabled: "DISABLED", hold: "HOLD" }[b.status] || b.status;
    var dotEmoji = { live: "🟢", paper: "🔵", monitor: "🟣", disabled: "⚪", hold: "🟡" }[b.status] || "•";
    var pos = (b.positions && b.positions.length) ? b.positions[0] : null;
    var posLine = pos
      ? esc(pos.symbol) + " " + (pos.qty) + "株 @$" + (pos.cost != null ? pos.cost : "—") +
        " ($" + (pos.value != null ? Number(pos.value).toLocaleString() : "—") +
        (b.pct_netliq != null ? ", " + b.pct_netliq + "%" : "") + ")"
      : "ポジションなし";
    var pnlTone = (b.pnl || 0) >= 0 ? "pos" : "neg";
    var pnlLine = pos ? '<span class="' + pnlTone + '">$' + (b.pnl >= 0 ? "+" : "") + b.pnl +
      (pos.pnl_pct != null ? " (" + (pos.pnl_pct >= 0 ? "+" : "") + pos.pnl_pct + "%) " + (pos.pnl_pct >= 0 ? "▲" : "▼") : "") + '</span>' : "—";
    var sigState = b.today_signal.fired === true ? "FIRED" : b.today_signal.fired === false ? "NO SIGNAL" : "—";
    var sigBadge = '<span class="badge ' + (b.today_signal.fired === true ? "fired" : "nosig") + '">' + sigState + '</span>';

    var pills = '<span class="pill ' + b.status + '">' + dotEmoji + " " + statusPill + '</span>';
    if (b.exec_policy) pills += '<span class="pill muted">' + esc(b.exec_policy) + '</span>';
    if (b.pillar) pills += '<span class="pill muted">' + esc(b.pillar) + '</span>';
    if (b.build_in_progress) pills += '<span class="pill muted">BUILD中</span>';

    var st = b.stats || {};
    var chips = "";
    if (st.monthly_trades != null) chips += '<span class="chip">月 <b>' + st.monthly_trades + '</b></span>';
    if (st.annual_est) chips += '<span class="chip">年利 <b>' + esc(st.annual_est) + '</b></span>';
    if (st.corr_spy != null) chips += '<span class="chip">corr <b>' + st.corr_spy + '</b></span>';
    if (st.r6) chips += '<span class="chip">R6 <b>' + esc(st.r6) + '</b></span>';
    if (st.placebo) chips += '<span class="chip">' + esc(st.placebo) + '</span>';

    return '<div class="bot-head"><div class="bot-ico" style="border-color:' + b.color + '66">' + esc(b.icon) + '</div>' +
      '<div style="flex:1"><div class="bot-nm">' + esc(b.name) + '</div><div class="bot-sub">' + esc(b.subtitle) + '</div></div></div>' +
      '<div class="bot-pills">' + pills + '</div>' +
      '<div class="bot-grid">' +
        '<div class="bf"><div class="bk">Position</div><div class="bv">' + posLine + '</div></div>' +
        '<div class="bf"><div class="bk">P&L</div><div class="bv">' + pnlLine + '</div></div>' +
        '<div class="bf"><div class="bk">Today Signal</div><div class="bv">' + sigBadge + '</div></div>' +
        '<div class="bf"><div class="bk">Mode</div><div class="bv">' + esc(b.mode || "—") +
          (b.allow_live_orders ? " · live-ok" : "") + '</div></div>' +
      '</div>' +
      (chips ? '<div class="bot-stats">' + chips + '</div>' : '') +
      (b.role ? '<div class="bar-sub" style="margin-top:9px">' + esc(b.role) + '</div>' : '');
  },

  list: function (c) {
    if (!c.items || !c.items.length) return '<div class="note">' + esc(c.empty || "なし") + '</div>';
    return '<div class="lst">' + c.items.map(function (i) {
      return '<div class="li">' + (i.icon ? '<div class="ico">' + esc(i.icon) + '</div>' : '') +
        '<div class="lmid"><div class="lt ' + toneCls(i.tone) + '">' + esc(i.title) + '</div>' +
        (i.sub ? '<div class="ls">' + esc(i.sub) + '</div>' : '') + '</div>' +
        (i.right != null ? '<div class="lr ' + toneCls(i.tone) + '">' + esc(i.right) + '</div>' : '') + '</div>';
    }).join("") + '</div>';
  },

  timeline: function (c) {
    if (!c.items || !c.items.length) return '<div class="note">' + esc(c.empty || "予定なし") + '</div>';
    return '<div class="tl">' + c.items.map(function (i) {
      return '<div class="tli ' + esc(i.tone || "") + '"><div class="tw">' + esc(i.when) + '</div>' +
        '<div class="tt">' + esc(i.title) + '</div>' + (i.sub ? '<div class="ts">' + esc(i.sub) + '</div>' : '') + '</div>';
    }).join("") + '</div>';
  },

  alert: function (c) {
    var icon = c.level === "critical" ? "🚨" : c.level === "warning" ? "⚠️" : "ℹ️";
    return '<div class="alert ' + esc(c.level) + '"><span class="ai">' + icon + '</span><span>' + esc(c.text) + '</span></div>';
  },

  note: function (c) { return '<div class="note">' + esc(c.text) + '</div>'; },

  spark: function (c) {
    var pts = c.points || [];
    var svg = "";
    if (pts.length > 1) {
      var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts), rng = (max - min) || 1;
      var W = 300, H = 56, P = 4;
      var path = pts.map(function (v, i) {
        var x = P + i / (pts.length - 1) * (W - 2 * P);
        var y = H - P - (v - min) / rng * (H - 2 * P);
        return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }).join(" ");
      var stroke = c.tone === "neg" ? "#f87171" : c.tone === "pos" ? "#34d399" : "#06b6d4";
      var lastX = W - P, lastY = H - P - (pts[pts.length - 1] - min) / rng * (H - 2 * P);
      svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
        '<defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + stroke + '" stop-opacity=".3"/><stop offset="1" stop-color="' + stroke + '" stop-opacity="0"/></linearGradient></defs>' +
        '<path d="' + path + ' L' + lastX + ' ' + H + ' L' + P + ' ' + H + ' Z" fill="url(#sg)"/>' +
        '<path d="' + path + '" fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="3" fill="' + stroke + '"/></svg>';
    }
    return (c.label ? '<div class="spark-label">' + (typeof c.label === "string" ? c.label.replace(/(\$[-\d,\.]+)/, "<b>$1</b>") : "") + '</div>' : '') +
      '<div class="spark">' + svg + '</div>';
  },

  html: function (c) { return c.html || ""; }
};

function renderCard(c) {
  var el = ce("div", "card" + (c.accent ? " accent" : ""));
  if (c.title) el.appendChild(ce("div", "card-title", esc(c.title)));
  var fn = R[c.type] || R.note;
  el.insertAdjacentHTML("beforeend", fn(c));
  return el;
}

/* ---------------- tabs ---------------- */
function buildTabs(data) {
  var bar = $("#tabs"), ind = $("#tab-ind");
  // clear except indicator
  Array.prototype.slice.call(bar.querySelectorAll(".tab")).forEach(function (t) { t.remove(); });
  data.tabs.forEach(function (t) {
    var el = ce("button", "tab", '<span class="ti">' + esc(t.icon) + '</span>' + esc(t.name));
    el.dataset.id = t.id;
    el.onclick = function () { selectTab(t.id); };
    bar.appendChild(el);
  });
  if (!state.active || !data.tabs.some(function (t) { return t.id === state.active; }))
    state.active = data.tabs[0] && data.tabs[0].id;
}

function moveIndicator() {
  var bar = $("#tabs"), ind = $("#tab-ind");
  var act = bar.querySelector('.tab[data-id="' + state.active + '"]');
  if (!act) { ind.style.width = "0"; return; }
  ind.style.width = act.offsetWidth + "px";
  ind.style.transform = "translateX(" + act.offsetLeft + "px)";
}

function selectTab(id) {
  state.active = id;
  var bar = $("#tabs");
  Array.prototype.slice.call(bar.querySelectorAll(".tab")).forEach(function (t) {
    t.classList.toggle("active", t.dataset.id === id);
  });
  var act = bar.querySelector('.tab[data-id="' + id + '"]');
  if (act) act.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  moveIndicator();
  renderActive();
}

function renderActive() {
  var data = state.data; if (!data) return;
  var tab = data.tabs.filter(function (t) { return t.id === state.active; })[0] || data.tabs[0];
  var main = $("#main"); main.innerHTML = "";
  var head = ce("div", "tab-title", '<b>' + esc(tab.title || tab.name) + '</b>' + (tab.subtitle ? esc(tab.subtitle) : ""));
  main.appendChild(head);
  tab.cards.forEach(function (c, i) {
    var el = renderCard(c);
    el.style.animationDelay = Math.min(i * 45, 320) + "ms";
    main.appendChild(el);
  });
  // animate bar/prog widths after insert
  requestAnimationFrame(function () {
    Array.prototype.slice.call(main.querySelectorAll(".bar-fill,.sig .prog>i,.bf .prog>i")).forEach(function (e) {
      if (e.style.getPropertyValue("--w")) e.style.width = e.style.getPropertyValue("--w");
    });
  });
}

/* ---------------- load ---------------- */
function render(data) {
  state.data = data;
  $("#dot").className = "dot " + (data.bridge_status === "ok" ? "ok" : data.bridge_status === "down" ? "down" : "unk");
  var base = (data.bridge_status === "ok" ? "TWS 接続" : "Bridge 切断");
  // data freshness: generated_at が古い (>10分) なら stale 警告を出す (offline とは別表示)
  var ageMin = Math.floor((Date.now() - new Date(data.generated_at).getTime()) / 60000);
  if (isFinite(ageMin) && ageMin > STALE_MIN) {
    $("#upd").innerHTML = base + "<br><span style='color:#f0b429'>⚠ " + ago(data.generated_at) + "</span>";
  } else {
    $("#upd").innerHTML = base + "<br>" + ago(data.generated_at);
  }
  document.title = (data.ui && data.ui.title) || "Yasuda Status";
  buildTabs(data);
  selectTab(state.active);
}

/* status.json を 1 回 GET。 !ok / parse 失敗は reject。
 * ★ iOS Safari は fetch(url,{cache:"no-store"}) で "Load failed" を投げる既知バグがあるため
 *   cache option を付けない。 鮮度は ?t=Date.now() (毎回ユニーク URL) + server の no-store ヘッダ
 *   + sw.js の stale-while-revalidate で担保しており、 client 側 no-store は不要。 */
function fetchStatus() {
  return fetch("status.json?t=" + Date.now())
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}

/* 失敗時に 2 秒後 1 回だけ自動 retry (一時的な network glitch を吸収、 user 体感なし)。 */
function fetchStatusWithRetry() {
  return fetchStatus().catch(function (err) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () { fetchStatus().then(resolve, function () { reject(err); }); }, 2000);
    });
  });
}

function load() {
  var btn = $("#refresh"); btn.classList.add("spin");
  fetchStatusWithRetry()
    .then(function (d) {
      render(d);
      consecutiveFailures = 0;
      $("#offline").classList.remove("show");
    })
    .catch(function (err) {
      // 単発失敗では offline を出さない。 FAILURE_THRESHOLD 連続で初めて offline 表示。
      consecutiveFailures++;
      console.warn("status fetch failed:", err, "consecutive:", consecutiveFailures);
      if (consecutiveFailures >= FAILURE_THRESHOLD) $("#offline").classList.add("show");
    })
    .then(function () { setTimeout(function () { btn.classList.remove("spin"); }, 350); });
}

$("#refresh").addEventListener("click", load);
document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
window.addEventListener("resize", moveIndicator);
load();
setInterval(load, POLL_MS);

/* pull-to-refresh (物理感のある引っ張り) */
(function () {
  var startY = 0, pulling = false;
  window.addEventListener("touchstart", function (e) {
    if (window.scrollY <= 0) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });
  window.addEventListener("touchmove", function (e) {
    if (!pulling) return;
    var dy = e.touches[0].clientY - startY;
    if (dy > 70) { pulling = false; $("#refresh").classList.add("spin"); load(); }
  }, { passive: true });
  window.addEventListener("touchend", function () { pulling = false; });
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
