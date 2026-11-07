/*
  Homepage ("overnight") engine: the hero night-to-morning animation, the
  scroll-driven sky, and the section reveals.

  Lifecycle mirrors the old landing reveal: VitePress keeps the Layout
  mounted across client-side navigation, so `refresh()` runs after every
  route change and either starts against the `.ov` tree that exists now or
  tears everything down when the current page is not the homepage.

  No-JS boundary: the markup renders in its finished state (card visible,
  every section shown). Everything hidden or moved here is an inline style
  this module sets while it runs; the first-paint hold is html.ov-boot, which
  start() removes (see overnight.css).
*/

import { NIGHT_MESSAGES, NIGHT_STEPS } from "./overnight-data";

export interface OvernightController {
  /** Start against the current DOM, or stop if the homepage isn't mounted. */
  refresh(): void;
  /** Stop the loop and drop listeners and page-level classes. */
  dispose(): void;
}

export function createOvernightController(): OvernightController {
  let stop: (() => void) | undefined;
  const dispose = () => {
    stop?.();
    stop = undefined;
  };
  const refresh = () => {
    dispose();
    const root = document.querySelector<HTMLElement>(".ov");
    if (root?.querySelector("#ov-hero")) stop = start(root);
  };
  return { refresh, dispose };
}

// ---------------------------------------------------------------- timeline

const START = 20 * 60 + 20; // minute 0 of the timeline is 20:20 local
const SPAN = 625; // 20:20 → 06:45
const CARD_MIN = 672; // the morning card arrives at 07:32
// hero seconds: night plays TA→TB, everything converges from TV, clock lands at TC
const TA = 0.6;
const TB = 4.8;
const TV = 4.95;
const TC = 5.6;
const HERO_END = TC + 1.4;

const COLORS = ["#ff8a4c", "#6cc4ff", "#c79bff", "#5fd39a", "#f2b866", "#ff6f91", "#7ee0d6", "#b7c3ff", "#ffe08a"];
const RING = [9, 7, 5, 3, 1, 2, 4, 6, 8]; // person → orbit ring, inner to outer
const SECTIONS = ["ratio", "anyone", "work", "control", "morning"];
const SKY_AT = [0, 0.22, 0.3, 0.5, 0.7, 0.9, 1]; // sky progress at page top, each section, page end
const SKY: Array<[number, string, string]> = [
  [0, "#04050b", "#0a0e1e"],
  [0.3, "#070b1d", "#16204a"],
  [0.55, "#121638", "#3d2b55"],
  [0.75, "#2a1a3c", "#a5452a"],
  [0.9, "#d98a5c", "#f3cfa6"],
  [1, "#f6e3cc", "#f6ead9"],
];
const ENGINEER_MESSAGE =
  "Can you set up Anima for us? It puts our AI agents in Slack so anyone on the team can ask them directly. " +
  "Needs: a Mac or Linux machine you control, Node 22.13+, and Claude Code or Codex signed in. " +
  "Install: curl -fsSL https://anima.meetquinn.ai/install.sh | sh " +
  "Guide: https://anima.meetquinn.ai/guide/quickstart";

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const ease = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const eio = (x: number) => {
  x = clamp(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const tOf = (m: number) => TA + (m / SPAN) * (TB - TA);
const clockAt = (t: number) =>
  t <= TA ? 0 : t <= TB ? ((t - TA) / (TB - TA)) * SPAN : lerp(SPAN, CARD_MIN, clamp((t - TB) / (TC - TB)));

function fmt(mm: number): string {
  const m = (((Math.round(mm + START) % 1440) + 1440) % 1440);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
function mix(a: string, b: string, k: number): string {
  const A = hex(a);
  const B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i] ?? v, k))).join(",")})`;
}
function skyAt(p: number): [string, string] {
  for (let i = 1; i < SKY.length; i++) {
    const [p1, a1, b1] = SKY[i]!;
    const [p0, a0, b0] = SKY[i - 1]!;
    if (p <= p1) {
      const k = (p - p0) / (p1 - p0);
      return [mix(a0, a1, k), mix(b0, b1, k)];
    }
  }
  const last = SKY[SKY.length - 1]!;
  return [last[1], last[2]];
}
function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

interface Dot { m: number; p: number; j: number; k: number; dup: number; r: number; a: number; x: number; y: number }
interface Spark { m: number; u: number; v: number; w: number; r: number; a: number; x: number; y: number }

function buildNight(): { dots: Dot[]; sparks: Spark[] } {
  const rnd = seeded(11);
  const dots: Dot[] = NIGHT_MESSAGES.map(([hm, p]) => {
    const [h = 0, mi = 0] = hm.split(":").map(Number);
    let m = h * 60 + mi - START;
    if (m < 0) m += 1440;
    return { m, p, j: rnd() - 0.5, k: rnd() * 6.28, dup: 0, r: 0, a: 0, x: 0, y: 0 };
  });
  dots.forEach((d, i) => {
    d.dup = dots.slice(0, i).filter((x) => x.p === d.p && x.m === d.m).length;
  });
  const sparks: Spark[] = [];
  for (const [m, n] of NIGHT_STEPS) {
    for (let k = 0; k < n; k++) sparks.push({ m: m + rnd(), u: rnd(), v: rnd(), w: rnd(), r: 0, a: 0, x: 0, y: 0 });
  }
  return { dots, sparks };
}

// ------------------------------------------------------------------ engine

function start(root: HTMLElement): () => void {
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const qa = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const html = document.documentElement;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const hero = q("#ov-hero");
  const field = q("#ov-field");
  const card = q("#ov-card");
  const cap = q("#ov-cap");
  const fct = q("#ov-fct");
  const fcc = q("#ov-fcc");
  const fclock = q("#ov-fclock");
  const sunrise = q("#ov-sunrise");
  const sky = q("#ov-sky");
  const sun = q("#ov-sun");
  const cv = q<HTMLCanvasElement>("#ov-cv");
  const ctx = cv.getContext("2d")!;
  const orbit = q("#ov-orbit");
  const orbsvg = q<SVGSVGElement>("#ov-orbsvg");
  const thread = q("#ov-thread");
  const threadMsgs = qa(".tmsg");
  const scr = q("#ov-phone .scr");
  const ship = q("#ov-ship");
  const cursor = q<SVGSVGElement>("#ov-cursor");
  const lb = q("#ov-lb");
  const video = q<HTMLVideoElement>("#ov-lb video");
  const reveals = qa(".rv").map((el) => ({ el, d: Number(el.dataset.d ?? 0), sec: el.closest("section")! }));

  // twinkling background stars
  const starBox = q("#ov-stars");
  starBox.replaceChildren();
  const srnd = seeded(7);
  const stars = Array.from({ length: 140 }, () => {
    const e = document.createElement("i");
    e.style.left = `${srnd() * 100}%`;
    e.style.top = `${srnd() * 100}%`;
    const size = srnd() < 0.85 ? 1.3 : 2.2;
    e.style.width = e.style.height = `${size}px`;
    starBox.append(e);
    return { e, ph: srnd() * 6.28, b: 0.2 + srnd() * 0.6 };
  });

  // section 1 orbit: the nine people, in the hero's colours, around Felix
  qa(".pn").forEach((n) => n.remove());
  let svg = `<circle cx="310" cy="310" r="250" fill="none" stroke="rgba(243,237,228,.07)"/><circle cx="310" cy="310" r="150" fill="none" stroke="rgba(255,138,76,.12)"/>`;
  COLORS.forEach((c, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 9;
    const x = 310 + 250 * Math.cos(a);
    const y = 310 + 250 * Math.sin(a);
    svg += `<line x1="${x}" y1="${y}" x2="310" y2="310" stroke="${c}" stroke-opacity=".18" stroke-dasharray="3 6"/>`;
    svg += `<circle r="4" fill="${c}" cx="${x}" cy="${y}" opacity="0" data-x="${x}" data-y="${y}"/>`;
    const n = document.createElement("i");
    n.className = "pn";
    n.style.left = `${x}px`;
    n.style.top = `${y}px`;
    n.style.background = c;
    n.style.boxShadow = `0 0 0 6px ${c}22,0 0 24px ${c}`;
    orbit.append(n);
  });
  orbsvg.innerHTML = svg;
  const pulses = [...orbsvg.querySelectorAll<SVGCircleElement>("circle[data-x]")];

  const { dots, sparks } = buildNight();

  // geometry, recomputed on resize (all page offsets are scroll-independent)
  const G = { W: 0, H: 0, cx: 0, by: 0, rMax: 0, rMin: 0, a0: 0, a1: 0, cardX: 0, cardY: 0 };
  let secTop: number[] = [];
  let maxY = 1;
  let threadBox = { top: 0, bottom: 0 };
  let phoneBox = { top: 0, bottom: 0 };
  let shipAt = { x: 0, y: 0, w: 0, h: 0 };

  const absTop = (el: Element) => el.getBoundingClientRect().top + window.scrollY;
  function layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = hero.offsetWidth;
    const H = hero.offsetHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const hr = hero.getBoundingClientRect();
    const fr = field.getBoundingClientRect();
    const fx = fr.left - hr.left;
    const fy = fr.top - hr.top;
    const mob = W < 820;
    const cx = fx + fr.width / 2;
    const by = fy + fr.height * 0.8;
    const rMax = Math.min(fr.width * (mob ? 0.54 : 0.53), fr.height * 0.62);
    const cardTop = by - fy - 150;
    card.style.top = `${cardTop}px`;
    Object.assign(G, {
      W, H, cx, by, rMax,
      rMin: rMax * 0.4,
      a0: Math.PI * (mob ? 1.06 : 1.07),
      a1: Math.PI * (mob ? 1.94 : 1.93),
      cardX: cx,
      cardY: fy + cardTop + card.offsetHeight * 0.45,
    });
    for (const d of dots) {
      d.r = lerp(G.rMin, G.rMax, RING.indexOf(d.p) / 8) + d.j * 6 + d.dup * 5;
      d.a = lerp(G.a0, G.a1, d.m / SPAN) + d.dup * 0.004;
      d.x = cx + d.r * Math.cos(d.a);
      d.y = by + d.r * Math.sin(d.a);
    }
    for (const s of sparks) {
      s.r = lerp(G.rMin * 0.72, G.rMax * 1.04, Math.sqrt(s.u));
      s.a = lerp(G.a0, G.a1, s.m / SPAN) + (s.v - 0.5) * 0.035;
      s.x = cx + s.r * Math.cos(s.a);
      s.y = by + s.r * Math.sin(s.a);
    }
    sunrise.style.left = `${cx - 450}px`;
    sunrise.style.top = `${by - 450}px`;

    maxY = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    secTop = SECTIONS.map((id) => Math.min(absTop(q(`#${id}`)), maxY));
    for (const r of reveals) r.el.style.transform = "";
    const tb = thread.getBoundingClientRect();
    threadBox = { top: tb.top + window.scrollY, bottom: tb.bottom + window.scrollY };
    const pr = scr.getBoundingClientRect();
    const br = ship.getBoundingClientRect();
    phoneBox = { top: pr.top + window.scrollY, bottom: pr.bottom + window.scrollY };
    shipAt = { x: br.left - pr.left, y: br.top - pr.top, w: pr.width, h: pr.height };
  }

  function drawHero(t: number) {
    const { W, H, cx, by, rMin, rMax, a0, a1 } = G;
    ctx.clearRect(0, 0, W, H);
    const fadeTr = 1 - clamp((t - TV) / 0.6);
    const at = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), by + r * Math.sin(a)];

    // orbit guides and hour ticks
    ctx.lineWidth = 1;
    for (let k = 0; k < 9; k++) {
      ctx.strokeStyle = `rgba(243,237,228,${0.045 * fadeTr + 0.02})`;
      ctx.beginPath();
      ctx.arc(cx, by, lerp(rMin, rMax, k / 8), a0, a1);
      ctx.stroke();
    }
    ctx.font = '11px "Geist Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [m, label] of [[40, "9 PM"], [220, "12 AM"], [400, "3 AM"], [580, "6 AM"]] as const) {
      const a = lerp(a0, a1, m / SPAN);
      ctx.fillStyle = `rgba(243,237,228,${0.42 * fadeTr + 0.12})`;
      ctx.fillText(label, ...at(rMax + 26, a));
      ctx.strokeStyle = `rgba(243,237,228,${0.25 * fadeTr})`;
      ctx.beginPath();
      ctx.moveTo(...at(rMax + 8, a));
      ctx.lineTo(...at(rMax + 14, a));
      ctx.stroke();
    }

    // sweep hand
    if (t > TA && fadeTr > 0) {
      const a = lerp(a0, a1, Math.min(SPAN, clockAt(t)) / SPAN);
      const [ex, ey] = at(rMax + 10, a);
      const g = ctx.createLinearGradient(cx, by, ex, ey);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, `rgba(255,230,200,${0.35 * fadeTr})`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(...at(rMin * 0.6, a));
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    // one trail per person
    if (fadeTr > 0) {
      const last = new Map<number, Dot>();
      for (const d of dots) {
        const tb = tOf(d.m);
        if (t < tb) continue;
        const pv = last.get(d.p);
        last.set(d.p, d);
        if (!pv) continue;
        ctx.strokeStyle = COLORS[d.p - 1]!;
        ctx.globalAlpha = 0.32 * fadeTr;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, by, (pv.r + d.r) / 2, pv.a, lerp(pv.a, d.a, ease((t - tb) / 0.35)));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // sparks: one per step Felix took
    ctx.fillStyle = "#ffe6c2";
    for (const s of sparks) {
      const tb = tOf(s.m);
      if (t < tb) continue;
      const age = t - tb;
      const kc = eio((t - (TV + 0.1 + s.w * 0.75)) / 0.8);
      let x = s.x;
      let y = s.y;
      let al: number;
      let sz: number;
      if (age < 0.5) {
        const k = age / 0.5;
        al = 1 - k * 0.75;
        sz = 1.9 - k * 0.8;
        x += k * 7 * Math.cos(s.a);
        y += k * 7 * Math.sin(s.a);
      } else {
        al = 0.25;
        sz = 1.1;
        x += 7 * Math.cos(s.a);
        y += 7 * Math.sin(s.a);
      }
      if (kc > 0) {
        ctx.globalAlpha = 0.06 * kc;
        ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
        x = lerp(x, G.cardX, kc);
        y = lerp(y, G.cardY, kc * kc);
        al *= (1 - kc) * 1.4;
      }
      if (al <= 0.01) continue;
      ctx.globalAlpha = Math.min(1, al);
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    // stars: one per message, flying into the card at the end
    dots.forEach((d, i) => {
      const tb = tOf(d.m);
      if (t < tb) return;
      const age = t - tb;
      const c = COLORS[d.p - 1]!;
      const kc = eio((t - (TV + (i / dots.length) * 0.55)) / 0.85);
      let x = d.x;
      let y = d.y;
      let al = 0.78 + 0.22 * Math.sin(t * 2.2 + d.k);
      let rad = 2.7;
      if (kc > 0) {
        ctx.globalAlpha = 0.22 * kc;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(d.x, d.y, 1.7, 0, 6.283);
        ctx.fill();
        const mx = (d.x + G.cardX) / 2 + (d.y - G.cardY) * 0.25;
        const my = Math.min(d.y, G.cardY) - 60;
        x = (1 - kc) * (1 - kc) * d.x + 2 * (1 - kc) * kc * mx + kc * kc * G.cardX;
        y = (1 - kc) * (1 - kc) * d.y + 2 * (1 - kc) * kc * my + kc * kc * G.cardY;
        al *= 1 - clamp((kc - 0.82) / 0.18);
        rad = 2.7 + kc * 1.2;
      }
      if (al <= 0) return;
      ctx.globalAlpha = al;
      ctx.shadowColor = c;
      ctx.shadowBlur = 12;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, 6.283);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = al * 0.9;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x, y, rad * 0.42, 0, 6.283);
      ctx.fill();
      if (age < 0.8 && kc <= 0) {
        const k = age / 0.8;
        ctx.globalAlpha = (1 - k) * 0.55;
        ctx.strokeStyle = c;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, 3 + 11 * ease(k), 0, 6.283);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  const pop = (el: HTMLElement | SVGElement, k: number, dy = 12, s = 1) => {
    el.style.opacity = String(k);
    el.style.transform = `translateY(${(1 - k) * dy}px) scale(${lerp(s, 1, k)})`;
  };
  const seenAt: Record<string, number | null> = { thread: null, phone: null };
  function seen(key: string, box: { top: number; bottom: number }, t: number, y: number, vh: number, th = 0.75) {
    const top = box.top - y;
    if (top < vh * th && box.bottom - y > 0) seenAt[key] ??= t;
    else if (top > vh) seenAt[key] = null;
    const s = seenAt[key];
    return s == null ? -1 : t - s;
  }

  const T0 = performance.now();
  let heroT0 = still ? -1e4 : 0;
  let heroDone = still;
  let raf = 0;

  function render() {
    const t = (performance.now() - T0) / 1000;
    const y = window.scrollY;
    const vh = window.innerHeight;
    // first scroll during the intro: jump straight to the card
    if (!heroDone && y > 40 && t - heroT0 < HERO_END) heroT0 = t - HERO_END;
    const th = t - heroT0;
    if (th >= HERO_END) heroDone = true;

    // sky: the hero's dawn sets a floor, scrolling finishes the sunrise
    const A = [0, ...secTop, maxY];
    let ps = 0;
    for (let i = 1; i < A.length; i++) {
      if (y >= A[i - 1]!) ps = lerp(SKY_AT[i - 1]!, SKY_AT[i]!, clamp((y - A[i - 1]!) / Math.max(1, A[i]! - A[i - 1]!)));
    }
    const cm = clockAt(th);
    const dawn = clamp((cm - 430) / (CARD_MIN - 430));
    const p = Math.max(ps, 0.36 * dawn);
    const [top, bot] = skyAt(p);
    sky.style.background = `linear-gradient(180deg,${top},${bot})`;
    const sp = clamp((p - 0.5) / 0.5);
    sun.style.top = `${lerp(vh + 200, vh - 700, ease(sp))}px`;
    sun.style.opacity = String(clamp(sp * 1.6));
    const fade = clamp(1 - p * 1.8);
    for (const s of stars) s.e.style.opacity = String(s.b * (still ? 0.8 : 0.65 + 0.35 * Math.sin(t * 1.3 + s.ph)) * fade);
    html.classList.toggle("ov-morning", y >= (secTop[4] ?? Infinity) - 60);

    // hero
    sunrise.style.opacity = String(dawn * 0.95);
    sunrise.style.transform = `translateY(${(1 - dawn) * 120}px)`;
    if (y < G.H) drawHero(th);
    fct.textContent = fmt(cm);
    let nm = 0;
    for (const d of dots) if (tOf(d.m) <= th) nm++;
    let ns = 0;
    for (const s of sparks) if (tOf(s.m) <= th) ns++;
    fcc.innerHTML = `<b>${nm}</b> ${nm === 1 ? "message" : "messages"} to Felix · <b>${ns.toLocaleString("en-US")}</b> ${ns === 1 ? "step" : "steps"} of work`;
    fclock.style.opacity = String(th < TA - 0.4 ? ease((th - 0.3) / 0.5) : 1);
    const kc = ease((th - TV - 0.55) / 0.6);
    pop(card, kc, 24, 0.94);
    card.style.filter = kc < 1 ? `blur(${(1 - kc) * 8}px)` : "";
    cap.style.opacity = String(ease((th - TC - 0.6) / 0.6));

    // reveals
    for (const r of reveals) {
      let k = 1;
      if (!still) {
        if (r.sec === hero) k = ease((t - 0.05 - r.d * 0.14) / 0.9);
        else {
          k = ease((y - (secTopOf(r.sec) - vh * 0.8 + r.d * 44)) / (vh * 0.32));
        }
      }
      r.el.style.opacity = String(k);
      r.el.style.transform = k < 1 ? `translateY(${(1 - k) * 28}px)` : "";
    }

    // orbit pulses: people → Felix
    pulses.forEach((c, i) => {
      if (still) return;
      const k = (t * 0.38 + i * 0.29) % 1;
      c.setAttribute("cx", String(lerp(Number(c.dataset.x), 310, k)));
      c.setAttribute("cy", String(lerp(Number(c.dataset.y), 310, k)));
      c.setAttribute("opacity", String(Math.sin(Math.PI * k)));
    });

    // thread messages appear once the thread is in view
    const s1 = still ? 99 : seen("thread", threadBox, t, y, vh);
    threadMsgs.forEach((e, i) => pop(e, s1 < 0 ? 0 : ease((s1 - 0.2 - i * 0.42) / 0.4), 10));

    // morning: a tap on Yes
    const s2 = still ? 99 : seen("phone", phoneBox, t, y, vh, 0.7);
    const ck = ease((s2 - 0.5) / 0.8);
    cursor.style.left = `${lerp(shipAt.w + 10, shipAt.x + ship.offsetWidth * 0.55, ck)}px`;
    cursor.style.top = `${lerp(shipAt.h + 10, shipAt.y + ship.offsetHeight * 0.6, ck)}px`;
    cursor.style.opacity = String(s2 < 0.4 ? 0 : s2 > 2.6 ? clamp(1 - (s2 - 2.6) / 0.4) : 1);
    ship.classList.toggle("picked", s2 >= 1.4);
    ship.style.transform = s2 >= 1.4 && s2 < 1.55 ? "scale(.93)" : "";
  }
  const secTops = new Map<Element, number>();
  const secTopOf = (sec: Element) => secTops.get(sec) ?? 0;
  const relayout = () => {
    layout();
    secTops.clear();
    for (const r of reveals) if (!secTops.has(r.sec)) secTops.set(r.sec, absTop(r.sec));
  };

  const loop = () => {
    render();
    raf = requestAnimationFrame(loop);
  };

  // interactions
  const closeLightbox = () => {
    if (lb.hidden) return;
    lb.hidden = true;
    video.pause();
    q("#ov-how").focus();
  };
  const onClick = async (e: MouseEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    if (el.closest("#ov-install")) {
      e.preventDefault();
      window.scrollTo({ top: absTop(q("#setup")) - 90, behavior: still ? "auto" : "smooth" });
    } else if (el.closest("#ov-how")) {
      lb.hidden = false;
      q("#ov-lb .x").focus();
      void video.play();
    } else if (el.closest("#ov-lb") && !el.closest("video")) {
      closeLightbox();
    } else if (el.closest("#ov-replay")) {
      heroT0 = (performance.now() - T0) / 1000;
    } else if (el.closest("#ov-send")) {
      const label = q("#ov-send span");
      try {
        await navigator.clipboard.writeText(ENGINEER_MESSAGE);
        label.textContent = "Copied. Paste it to your engineer.";
      } catch {
        label.textContent = "Copy failed";
      }
      window.setTimeout(() => (label.textContent = "Send to your engineer"), 2600);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeLightbox();
  };

  root.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(relayout);
  ro.observe(root);
  window.addEventListener("resize", relayout);
  relayout();
  void document.fonts.ready.then(relayout);
  loop();
  html.classList.add("ov-live");
  html.classList.remove("ov-boot");

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener("resize", relayout);
    root.removeEventListener("click", onClick);
    document.removeEventListener("keydown", onKey);
    html.classList.remove("ov-morning", "ov-live");
  };
}
