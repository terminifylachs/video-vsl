/* ──────────────────────────────────────────────────────────────
   Terminify VSL — eigenes Funnel-Tracking → hq.terminify.ai
   Events: pageview · vsl_play · vsl_progress (25/50/75/100) · cta_click
   (booking kommt server-to-server via GHL-Workflow-Webhook → /api/track)
   ────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var ENDPOINT = window.TF_TRACK_ENDPOINT || "https://hq.terminify.ai/api/track";

  // ── Session-ID (anonym, persistent) ──
  function sid() {
    try {
      var k = "tf_sid";
      var v = localStorage.getItem(k);
      if (!v) {
        v =
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2, 10);
        localStorage.setItem(k, v);
      }
      return v;
    } catch (e) {
      return "nostore-" + Math.random().toString(36).slice(2, 10);
    }
  }
  var SESSION = sid();

  // ── UTM-Parameter (First-Touch, persistent) ──
  function utms() {
    var keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
    var out = {};
    try {
      var stored = JSON.parse(localStorage.getItem("tf_utm") || "{}");
      var qs = new URLSearchParams(location.search);
      var sawNew = false;
      keys.forEach(function (k) {
        if (qs.get(k)) {
          out[k] = qs.get(k);
          sawNew = true;
        }
      });
      if (sawNew) {
        // fbclid als Quelle, falls keine UTM gesetzt
        localStorage.setItem("tf_utm", JSON.stringify(out));
        return out;
      }
      // kein neues UTM in URL → gespeicherte First-Touch nutzen
      if (!stored.utm_source && new URLSearchParams(location.search).get("fbclid")) {
        stored.utm_source = "facebook";
        localStorage.setItem("tf_utm", JSON.stringify(stored));
      }
      return stored;
    } catch (e) {
      return out;
    }
  }
  var UTM = utms();

  // ── Pfad: auf vsl.terminify.ai wie bisher, auf anderen Domains mit Host davor
  //    (z. B. "video.terminify.ai/"), damit sich die Seiten im HQ trennen lassen ──
  var PATH =
    location.hostname === "vsl.terminify.ai"
      ? location.pathname
      : location.hostname + location.pathname;

  // ── Senden (sendBeacon, fallback fetch keepalive) ──
  function send(type, extra) {
    var payload = {
      event_type: type,
      session_id: SESSION,
      path: PATH,
      referrer: document.referrer || null,
      utm_source: UTM.utm_source || null,
      utm_medium: UTM.utm_medium || null,
      utm_campaign: UTM.utm_campaign || null,
      utm_term: UTM.utm_term || null,
      utm_content: UTM.utm_content || null,
    };
    if (extra) for (var k in extra) payload[k] = extra[k];
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
        return;
      }
    } catch (e) {}
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: body,
        keepalive: true,
        mode: "cors",
      });
    } catch (e) {}
  }

  // ── 1) Pageview ──
  send("pageview");

  // ── 2) Wistia: Play + Watch-Meilensteine (nur Hero-VSL, nicht Testimonials) ──
  // Hero = erster <wistia-player> auf der Seite. So bleibt das Tracking
  // korrekt, auch wenn das Video später ausgetauscht wird (ID nicht fest).
  var played = false;
  var milestones = {};
  function mark(p) {
    [25, 50, 75, 100].forEach(function (m) {
      if (p >= m && !milestones[m]) {
        milestones[m] = true;
        send("vsl_progress", { vsl_progress: m });
      }
    });
  }
  function onPlay() {
    if (!played) {
      played = true;
      send("vsl_play");
    }
  }

  // (a) Neuer Web-Component-Player (<wistia-player> + player.js)
  function bindEl(el) {
    if (!el || el.__tfBound) return;
    el.__tfBound = true;
    el.addEventListener("play", onPlay);
    el.addEventListener("percentwatchedchanged", function (e) {
      var d = e.detail || {};
      var p = d.percent != null ? d.percent : Array.isArray(d) ? d[0] : null;
      if (p != null) mark(Math.floor(p * 100));
    });
    el.addEventListener("ended", function () { mark(100); });
    el.addEventListener("end", function () { mark(100); });
  }
  var heroEl = document.querySelector("wistia-player");
  if (heroEl) bindEl(heroEl);
  // Falls der Player erst später ins DOM kommt: kurz beobachten.
  if (!heroEl && window.MutationObserver) {
    var mo = new MutationObserver(function () {
      var el = document.querySelector("wistia-player");
      if (el) {
        bindEl(el);
        mo.disconnect();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, 15000);
  }

  // (b) Klassische JS-API als Fallback (gleiche Hero-ID, dedupliziert via Flags)
  var heroId = (heroEl && heroEl.getAttribute("media-id")) || window.TF_WISTIA_ID;
  if (heroId) {
    window._wq = window._wq || [];
    window._wq.push({
      id: heroId,
      onReady: function (video) {
        video.bind("play", onPlay);
        video.bind("percentwatched", function (percent) {
          mark(Math.floor(percent * 100));
        });
        video.bind("end", function () { mark(100); });
      },
    });
  }

  // ── 3) CTA-Klicks (Buchungs-Links) ──
  // Erfasst sowohl direkte GHL-Links als auch die interne /termin-buchen-Seite.
  // Hängt session_id + UTMs an die URL, damit der GHL-Webhook die Buchung
  // später unserer Session zuordnen kann (best effort; intern persistiert
  // tf_sid ohnehin über localStorage, da gleiche Origin).
  function wireCtas() {
    var links = document.querySelectorAll(
      'a[href*="leadconnectorhq.com"], a[href*="/termin-buchen"]'
    );
    links.forEach(function (el) {
      try {
        var u = new URL(el.href, location.href);
        u.searchParams.set("tf_sid", SESSION);
        Object.keys(UTM).forEach(function (k) {
          if (UTM[k]) u.searchParams.set(k, UTM[k]);
        });
        el.href = u.toString();
      } catch (e) {}
      el.addEventListener("click", function () {
        send("cta_click", { meta: { label: (el.textContent || "").trim().slice(0, 80) } });
      });
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireCtas);
  } else {
    wireCtas();
  }
})();
