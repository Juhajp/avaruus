/* ---------------- 3D-ohjaamot: avaruusalus ja laskeutumisalus ----------------
   Millennium Falcon -henkinen ohjaamo kameran lapsena: kahdeksankulmainen
   putkirunko, joka kapenee keulaa kohti rivoituksineen, fasetoitu lasikupu
   (8 reunapaneelia + keskioktagoni) säteittäisine tukipuineen, leveä
   näyttörivistöllinen kojelauta, kattokonsoli, putket, istuimet ja
   vilkkuvat merkkivalot. Pinnat ovat canvas-bittikarttoja (paneelisaumat,
   niitit, nappulat) — MeshStandardMaterial reagoi valoon: avaruudessa
   aurinko valaisee pistevalona origosta (kääntyily näkyy seinissä),
   pinnalla scenen aurinko+hemisfääri hoitavat saman. Ohjaamo on kiinni
   kamerassa = aluksen rungossa (lento kääntää alusta). */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { scene, camera, AU, C, C_KMS } from './core.js';
import { loadPH, surfDebug } from './surface.js';
import { bodies } from './bodies.js';
import { S } from './state.js';

/* Poly Haven -metallipinta materiaaliin taustalataukena (canvas jää varalle):
   diffuusi + normaalikartta kloonataan omalla toistolla ja sävytinttillä */
function applyPH(mat, slug, tint, repeat = [1, 1]){
  loadPH(slug, 'diff', true).then(t => {
    if (!t) return;
    const c = t.clone(); c.needsUpdate = true;
    c.repeat.set(repeat[0], repeat[1]);
    mat.map = c;
    mat.color.setRGB(tint[0], tint[1], tint[2]);   // >1 sallittu — vaalentaa tummaa levyä
    mat.needsUpdate = true;
  });
  loadPH(slug, 'nor_gl', false).then(t => {
    if (!t) return;
    const c = t.clone(); c.needsUpdate = true;
    c.repeat.set(repeat[0], repeat[1]);
    mat.normalMap = c;
    mat.needsUpdate = true;
  });
}

/* ---- canvas-tekstuurit ---- */
function tex(cv, srgb = true){
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function rng(seed){
  let s = seed;
  return () => { s = (s * 16807 + 11) % 2147483647; return (s & 0xffff) / 0x10000; };
}

// kulunut metallipaneeli: saumat, niitit, grimet
function makePanelTex(){
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d');
  const r = rng(7);
  c.fillStyle = '#85888d';
  c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1100; i++) {   // sävykohina + ruskeaa grimeä
    const g = 110 + r() * 50 | 0;
    const warm = r() < 0.3;
    c.fillStyle = warm ? `rgba(${g + 14},${g + 2},${g - 10},0.10)` : `rgba(${g},${g + 2},${g + 5},0.09)`;
    c.fillRect(r() * 512, r() * 512, 3 + r() * 26, 2 + r() * 16);
  }
  c.strokeStyle = 'rgba(35,38,43,0.6)';
  c.lineWidth = 3;
  for (const x of [2, 128, 256, 384, 510]) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 512); c.stroke(); }
  c.lineWidth = 2;
  for (const y of [2, 170, 340, 510]) { c.beginPath(); c.moveTo(0, y); c.lineTo(512, y); c.stroke(); }
  for (const x of [10, 120, 138, 248, 264, 376, 392, 502]) {   // niitit saumojen varsille
    for (let y = 14; y < 512; y += 42) {
      c.fillStyle = 'rgba(42,45,50,0.75)';
      c.beginPath(); c.arc(x, y, 2.6, 0, 7); c.fill();
      c.fillStyle = 'rgba(220,224,230,0.45)';
      c.beginPath(); c.arc(x - 0.8, y - 0.8, 1.0, 0, 7); c.fill();
    }
  }
  for (let i = 0; i < 30; i++) {   // kulumajuovia
    c.strokeStyle = `rgba(55,58,64,${0.06 + r() * 0.12})`;
    c.lineWidth = 1 + r() * 2;
    c.beginPath();
    const x = r() * 512, y = r() * 512;
    c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 110, y + (r() - 0.5) * 36);
    c.stroke();
  }
  return tex(cv);
}

/* kojelauta: strukturoitu paneelisto — upotetut paneelit kulmaruuveineen,
   riveihin ryhmitellyt nappulat, kytkinpankit, mittarit ja tekstitarrat.
   Palauttaa värikartan, emissiokartan (valaistut osat) ja korkeuskartan
   (bumpMap → nappulat ja paneelireunat kohoavat valossa) */
function makeConsoleTex(accent){
  const W = 1024, H = 512;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const base = mk(), emit = mk(), bump = mk();
  const b = base.getContext('2d'), e = emit.getContext('2d'), h = bump.getContext('2d');
  const r = rng(13);
  // pohja: tumma harjattu metalli + kevyt pystyraidoitus
  b.fillStyle = '#1e2126'; b.fillRect(0, 0, W, H);
  for (let i = 0; i < 700; i++) {
    const g = 26 + r() * 22 | 0;
    b.fillStyle = `rgba(${g},${g + 2},${g + 5},0.35)`;
    b.fillRect(r() * W, r() * H, 1.5, 4 + r() * 26);
  }
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  h.fillStyle = '#808080'; h.fillRect(0, 0, W, H);

  const screw = (x, y) => {
    b.fillStyle = '#0c0d10'; b.beginPath(); b.arc(x, y, 5, 0, 7); b.fill();
    b.strokeStyle = '#565c66'; b.lineWidth = 1.4;
    b.beginPath(); b.arc(x, y, 4, 0, 7); b.stroke();
    b.beginPath(); b.moveTo(x - 3, y - 1.6); b.lineTo(x + 3, y + 1.6); b.stroke();
    h.fillStyle = '#4a4a4a'; h.beginPath(); h.arc(x, y, 4.5, 0, 7); h.fill();
  };
  const panel = (x, y, w, hh) => {
    // upotettu paneeli: tumma tausta, AO-reuna, valoreuna alhaalla, ruuvit
    b.fillStyle = 'rgba(0,0,0,0.42)'; b.fillRect(x - 3, y - 3, w + 6, hh + 6);
    b.fillStyle = '#22252b'; b.fillRect(x, y, w, hh);
    b.strokeStyle = 'rgba(0,0,0,0.7)'; b.lineWidth = 2.5; b.strokeRect(x + 1, y + 1, w - 2, hh - 2);
    b.strokeStyle = 'rgba(190,200,210,0.18)'; b.lineWidth = 1; b.strokeRect(x - 2, y - 2, w + 4, hh + 4);
    h.fillStyle = '#6e6e6e'; h.fillRect(x, y, w, hh);
    screw(x + 9, y + 9); screw(x + w - 9, y + 9);
    screw(x + 9, y + hh - 9); screw(x + w - 9, y + hh - 9);
  };
  const cols = ['#ff5340', '#ffb340', '#46d06a', '#3fb8ff', '#aab4be'];
  const button = (x, y, w, hh, col, lit) => {
    b.fillStyle = '#0b0c0e'; b.fillRect(x - 2, y - 2, w + 4, hh + 4);
    const grad = b.createLinearGradient(x, y, x, y + hh);
    grad.addColorStop(0, col); grad.addColorStop(1, '#000');
    b.fillStyle = grad; b.globalAlpha = lit ? 0.95 : 0.45; b.fillRect(x, y, w, hh); b.globalAlpha = 1;
    b.strokeStyle = 'rgba(255,255,255,0.25)'; b.lineWidth = 1; b.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
    if (lit) { e.fillStyle = col; e.globalAlpha = 0.9; e.fillRect(x + 1, y + 1, w - 2, hh - 2); e.globalAlpha = 1; }
    h.fillStyle = '#c8c8c8'; h.fillRect(x, y, w, hh);
  };
  const toggle = (x, y, up) => {
    b.fillStyle = '#101216'; b.fillRect(x - 7, y - 16, 14, 32);
    b.strokeStyle = '#3a4048'; b.lineWidth = 1; b.strokeRect(x - 7, y - 16, 14, 32);
    b.fillStyle = '#d2d7dd'; b.fillRect(x - 3, up ? y - 14 : y + 2, 6, 12);
    b.fillStyle = '#5a6068'; b.fillRect(x - 3, up ? y - 4 : y - 8, 6, 4);
    h.fillStyle = '#e0e0e0'; h.fillRect(x - 3, up ? y - 14 : y + 2, 6, 12);
  };
  const gauge = (x, y, rad) => {
    b.fillStyle = '#0a0b0d'; b.beginPath(); b.arc(x, y, rad, 0, 7); b.fill();
    b.strokeStyle = '#4a5058'; b.lineWidth = 2.5; b.beginPath(); b.arc(x, y, rad, 0, 7); b.stroke();
    b.strokeStyle = '#8a929c'; b.lineWidth = 1.2;
    for (let k = 0; k < 7; k++) {
      const a = 2.4 + k * 0.4;
      b.beginPath();
      b.moveTo(x + Math.cos(a) * (rad - 7), y + Math.sin(a) * (rad - 7));
      b.lineTo(x + Math.cos(a) * (rad - 2), y + Math.sin(a) * (rad - 2));
      b.stroke();
    }
    const a = 2.4 + r() * 2.4;
    e.strokeStyle = accent; e.lineWidth = 2.5;
    e.beginPath(); e.moveTo(x, y); e.lineTo(x + Math.cos(a) * rad * 0.75, y + Math.sin(a) * rad * 0.75); e.stroke();
    h.fillStyle = '#5a5a5a'; h.beginPath(); h.arc(x, y, rad, 0, 7); h.fill();
  };
  const label = (x, y, w) => {
    b.fillStyle = '#caced4'; b.fillRect(x, y, w, 9);
    b.fillStyle = '#33363c';
    let lx = x + 3;
    while (lx < x + w - 6) { const lw = 3 + r() * 8; b.fillRect(lx, y + 3, lw, 3); lx += lw + 4; }
  };

  // vasen paneeli: nappularuudukko riveissä
  panel(14, 14, 310, 484);
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 7; col++) {
      const col5 = cols[(row * 2 + col) % 5];
      button(40 + col * 40, 50 + row * 66, 26, 18, col5, r() < 0.35);
    }
    label(40, 78 + row * 66, 110 + r() * 80);
  }
  // keskipaneeli: kytkinpankit + numeronäppäimistö
  panel(340, 14, 330, 230);
  for (let row = 0; row < 3; row++)
    for (let i = 0; i < 9; i++) toggle(372 + i * 32, 64 + row * 62, r() < 0.5);
  label(370, 218, 200);
  panel(340, 258, 330, 240);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 5; col++)
      button(395 + col * 46, 290 + row * 48, 32, 26, '#3c424a', false);
  // oikea paneeli: mittarit + liu'ut
  panel(686, 14, 324, 484);
  gauge(770, 90, 42); gauge(900, 90, 42); gauge(835, 200, 34);
  for (let i = 0; i < 4; i++) {
    const x = 730 + i * 70, y0 = 280, hh2 = 150;
    b.fillStyle = '#0c0d10'; b.fillRect(x - 4, y0, 8, hh2);
    const ky = y0 + 14 + r() * (hh2 - 28);
    b.fillStyle = '#cfd4da'; b.fillRect(x - 12, ky - 6, 24, 12);
    h.fillStyle = '#d8d8d8'; h.fillRect(x - 12, ky - 6, 24, 12);
    label(x - 22, y0 + hh2 + 12, 46);
  }
  // kulumat ja naarmut päälle
  for (let i = 0; i < 40; i++) {
    b.strokeStyle = `rgba(160,166,174,${0.04 + r() * 0.08})`;
    b.lineWidth = 0.8 + r() * 1.4;
    b.beginPath();
    const x = r() * W, y = r() * H;
    b.moveTo(x, y); b.lineTo(x + (r() - 0.5) * 70, y + (r() - 0.5) * 24);
    b.stroke();
  }
  return { map: tex(base), emissive: tex(emit), bump: tex(bump, false) };
}

// näyttöruudut: 'orbit' = tutkakehä, 'bars' = telemetria, 'nav' = reittiruudukko, 'wave' = käyrästö
function makeScreenTex(kind, hue){
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 192;
  const c = cv.getContext('2d');
  const r = rng(kind.length * 31 + kind.charCodeAt(0));
  c.fillStyle = '#03070c'; c.fillRect(0, 0, 256, 192);
  c.strokeStyle = hue; c.fillStyle = hue;
  c.strokeRect(3, 3, 250, 186);
  if (kind === 'orbit') {
    c.lineWidth = 1.2;
    for (const rad of [26, 52, 78]) { c.beginPath(); c.arc(128, 96, rad, 0, 7); c.stroke(); }
    c.beginPath(); c.moveTo(128, 14); c.lineTo(128, 178); c.moveTo(40, 96); c.lineTo(216, 96); c.stroke();
    for (let i = 0; i < 7; i++) {
      const a = r() * 6.28, d = 20 + r() * 60;
      c.fillRect(128 + Math.cos(a) * d - 2, 96 + Math.sin(a) * d - 2, 4, 4);
    }
    c.fillRect(20, 170, 90, 4); c.fillRect(20, 178, 60, 4);
  } else if (kind === 'bars') {
    for (let i = 0; i < 12; i++) {
      const h = 16 + r() * 120;
      c.globalAlpha = 0.85;
      c.fillRect(16 + i * 19, 168 - h, 13, h);
    }
    c.globalAlpha = 0.6; c.lineWidth = 0.7;
    for (let y = 20; y < 170; y += 30) { c.beginPath(); c.moveTo(12, y); c.lineTo(244, y); c.stroke(); }
    c.globalAlpha = 1;
  } else if (kind === 'wave') {
    c.lineWidth = 0.7; c.globalAlpha = 0.45;
    for (let y = 16; y < 192; y += 22) { c.beginPath(); c.moveTo(8, y); c.lineTo(248, y); c.stroke(); }
    c.globalAlpha = 1; c.lineWidth = 2;
    for (const [amp, f, y0] of [[18, 0.09, 60], [12, 0.05, 120], [8, 0.13, 160]]) {
      c.beginPath();
      for (let x = 8; x < 248; x += 4) {
        const y = y0 + Math.sin(x * f + r() * 2) * amp;
        x === 8 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke();
    }
  } else {
    c.lineWidth = 0.8; c.globalAlpha = 0.5;
    for (let x = 16; x < 256; x += 24) { c.beginPath(); c.moveTo(x, 8); c.lineTo(x, 184); c.stroke(); }
    for (let y = 8; y < 192; y += 24) { c.beginPath(); c.moveTo(16, y); c.lineTo(240, y); c.stroke(); }
    c.globalAlpha = 1; c.lineWidth = 2.4;
    c.beginPath(); c.moveTo(28, 160);
    let x = 28, y = 160;
    for (let i = 0; i < 6; i++) { x += 32; y -= 10 + r() * 28; c.lineTo(x, y); }
    c.stroke();
    c.save(); c.translate(x, y); c.rotate(0.785); c.fillRect(-5, -5, 10, 10); c.restore();
  }
  return tex(cv);
}

// takaseinän ovi varoitusraitoineen
function makeDoorTex(){
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d');
  c.fillStyle = '#7e8287'; c.fillRect(0, 0, 512, 512);
  c.fillStyle = '#6a6e74';
  c.beginPath();
  const oct = [[256, 60], [398, 120], [440, 256], [398, 392], [256, 452], [114, 392], [72, 256], [114, 120]];
  oct.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
  c.closePath(); c.fill();
  c.strokeStyle = '#34373c'; c.lineWidth = 8; c.stroke();
  c.lineWidth = 4;
  c.beginPath(); c.moveTo(256, 60); c.lineTo(256, 452); c.stroke();
  c.fillStyle = '#caa23c';
  for (let x = 0; x < 512; x += 64) {   // varoitusraidat ala- ja yläreunaan
    c.save(); c.translate(x, 480); c.transform(1, 0, -0.5, 1, 0, 0); c.fillRect(0, 0, 32, 32); c.restore();
    c.save(); c.translate(x, 0); c.transform(1, 0, -0.5, 1, 0, 0); c.fillRect(0, 0, 32, 32); c.restore();
  }
  return tex(cv);
}

// kattokonsoli: kytkinrivit + emissiiviset merkkivalot
function makeOverheadTex(accent){
  const base = document.createElement('canvas'); base.width = 512; base.height = 256;
  const emit = document.createElement('canvas'); emit.width = 512; emit.height = 256;
  const b = base.getContext('2d'), e = emit.getContext('2d');
  const r = rng(29);
  b.fillStyle = '#1d2025'; b.fillRect(0, 0, 512, 256);
  e.fillStyle = '#000'; e.fillRect(0, 0, 512, 256);
  b.strokeStyle = '#383d45'; b.lineWidth = 2;
  for (let row = 0; row < 4; row++) {
    const y = 28 + row * 56;
    b.strokeRect(14, y - 16, 484, 44);
    for (let i = 0; i < 16; i++) {
      const x = 30 + i * 30;
      b.fillStyle = '#0e0f12'; b.fillRect(x - 5, y - 8, 10, 26);
      b.fillStyle = '#c3c9d1'; b.fillRect(x - 3, r() < 0.5 ? y - 6 : y + 6, 6, 10);
      if (r() < 0.22) { e.fillStyle = r() < 0.5 ? accent : '#ffb340'; e.fillRect(x - 3, y + 22, 6, 4); }
    }
  }
  return { map: tex(base), emissive: tex(emit) };
}

/* ---- elävät kojelautanäytöt ----
   Keskirivin kolme näyttöä piirretään canvas-tekstuureihin ~8 Hz:
   vasen = aluksen sijainti (aurinkokuntakartta / matalalennossa planeetta
   ja korkeus), keski = nopeus, oikea = kohteen tiedot — samat luvut ja
   kaavat kuin HUD-paneeleissa (hud.js). */
const _live = [];
const _dir = new THREE.Vector3();
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

function fmtTime(s){
  if (!isFinite(s)) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function scrHead(c, hue, title){
  c.fillStyle = '#03070c';
  c.fillRect(0, 0, 256, 192);
  c.strokeStyle = hue; c.lineWidth = 1.5;
  c.strokeRect(3, 3, 250, 186);
  c.fillStyle = hue;
  c.globalAlpha = 0.8;
  c.font = '700 13px ' + MONO;
  c.fillText(title, 12, 21);
  c.fillRect(8, 28, 240, 1.2);
  c.globalAlpha = 1;
}

// vasen näyttö: aurinkokuntakartta ylhäältä (log-skaalatut radat),
// kohde korostettuna ja alus suuntakolmiona
function drawPos(c, hue){
  scrHead(c, hue, 'SIJAINTI');
  if (S.mode === 'space') {
    const cx = 128, cy = 108;
    const rOf = (au) => 13 + 60 * Math.log10(1 + au * 3) / Math.log10(1 + 30.07 * 3);
    c.fillStyle = '#ffd27f';
    c.beginPath(); c.arc(cx, cy, 3, 0, 7); c.fill();
    for (let i = 1; i < bodies.length; i++) {
      const b = bodies[i];
      if (!(b.def.a > 0)) continue;
      const r = rOf(b.def.a);
      c.strokeStyle = hue; c.globalAlpha = 0.22; c.lineWidth = 0.8;
      c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
      c.globalAlpha = 1;
      const ang = Math.atan2(b.group.position.z, b.group.position.x);
      const px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
      const isT = i === S.targetIdx;
      c.fillStyle = isT ? '#aef7c1' : hue;
      c.beginPath(); c.arc(px, py, isT ? 3 : 2, 0, 7); c.fill();
      if (isT) { c.strokeStyle = '#aef7c1'; c.lineWidth = 1; c.beginPath(); c.arc(px, py, 6, 0, 7); c.stroke(); }
    }
    const sAU = Math.hypot(camera.position.x, camera.position.z) / AU;
    const sr = rOf(sAU);
    const sa = Math.atan2(camera.position.z, camera.position.x);
    camera.getWorldDirection(_dir);
    const ha = Math.atan2(_dir.z, _dir.x);
    c.save();
    c.translate(cx + Math.cos(sa) * sr, cy + Math.sin(sa) * sr);
    c.rotate(ha);
    c.fillStyle = '#ffffff';
    c.beginPath(); c.moveTo(7, 0); c.lineTo(-4, 4.5); c.lineTo(-4, -4.5); c.closePath(); c.fill();
    c.restore();
    c.fillStyle = hue;
    c.font = '12px ' + MONO;
    c.fillText('r ' + sAU.toFixed(2) + ' AU', 12, 184);
  } else {
    const sd = surfDebug();
    const alt = sd.descentPos.y - sd.h(sd.descentPos.x, sd.descentPos.z);
    c.fillStyle = '#ffffff';
    c.font = '700 22px ' + MONO;
    c.fillText(sd.body || '—', 12, 62);
    c.fillStyle = hue;
    c.font = '13px ' + MONO;
    c.fillText('KORKEUS', 12, 96);
    c.fillStyle = '#ffffff';
    c.font = '700 30px ' + MONO;
    c.fillText(Math.max(0, Math.round(alt)) + ' m', 12, 128);
    c.fillStyle = hue;
    c.font = '12px ' + MONO;
    c.fillText('X ' + Math.round(sd.descentPos.x) + '  Z ' + Math.round(sd.descentPos.z), 12, 160);
  }
}

// keskinäyttö: nopeus — avaruudessa % c / km/s / gamma, matalalennossa m/s
function drawSpd(c, hue){
  scrHead(c, hue, 'NOPEUS');
  if (S.mode === 'space') {
    const eff = S.effFrac || 0;
    c.fillStyle = '#ffffff';
    c.font = '700 28px ' + MONO;
    c.fillText((eff * 100).toFixed(eff < 0.105 ? 2 : 1) + ' % c', 12, 70);
    c.fillStyle = hue;
    c.font = '14px ' + MONO;
    c.fillText(Math.round(eff * C_KMS).toLocaleString('fi-FI') + ' km/s', 12, 98);
    c.fillText('γ = ' + (1 / Math.sqrt(1 - eff * eff)).toFixed(2), 12, 120);
    c.globalAlpha = 0.5;
    c.strokeStyle = hue; c.lineWidth = 1;
    c.strokeRect(12, 138, 232, 14);
    c.globalAlpha = 1;
    c.fillRect(14, 140, 228 * Math.min(1, eff / 0.99), 10);
    const tick = 12 + 232 * Math.min(1, (S.targetFrac || 0) / 0.99);
    c.fillStyle = '#ffffff';
    c.fillRect(tick - 1, 134, 2, 22);
    if (S.dragBody && S.dragWeight > 0.01) {
      c.fillStyle = '#aef7c1';
      c.font = '11px ' + MONO;
      c.fillText('⊕ ' + S.dragBody.def.name + ' ' + Math.round(S.dragWeight * 100) + ' %', 12, 178);
    }
  } else {
    const sd = surfDebug();
    const v = sd.descentV();
    c.fillStyle = v <= 55 ? '#4dff88' : '#ffffff';
    c.font = '700 34px ' + MONO;
    c.fillText(Math.round(v) + ' m/s', 12, 78);
    c.globalAlpha = 0.5;
    c.strokeStyle = hue; c.lineWidth = 1;
    c.strokeRect(12, 100, 232, 14);
    c.globalAlpha = 1;
    c.fillStyle = hue;
    c.fillRect(14, 102, 228 * Math.min(1, v / 450), 10);
    const mark = 12 + 232 * (55 / 450);
    c.fillStyle = '#4dff88';
    c.fillRect(mark - 1, 96, 2, 22);
    const rollDeg = sd.roll() * 180 / Math.PI;
    c.fillStyle = Math.abs(rollDeg) <= 2 ? '#4dff88' : '#ff7a5c';
    c.font = '14px ' + MONO;
    c.fillText('KALLISTUS ' + rollDeg.toFixed(1) + '°', 12, 148);
    c.fillStyle = hue;
    c.font = '11px ' + MONO;
    c.fillText('lasku ≤ 55 m/s · ≤ 2°', 12, 178);
  }
}

// oikea näyttö: kohteen tiedot — nimi, etäisyys ja ETA kuten HUD:ssa
function drawTgt(c, hue){
  scrHead(c, hue, 'KOHDE');
  if (S.mode === 'space') {
    const tgt = bodies[S.targetIdx];
    const distU = camera.position.distanceTo(tgt.group.position) - tgt.def.r;
    const distAU = distU / AU;
    c.fillStyle = '#ffffff';
    c.font = '700 24px ' + MONO;
    c.fillText(tgt.def.name, 12, 64);
    c.fillStyle = hue;
    c.font = '15px ' + MONO;
    if (distAU >= 0.01) {
      c.fillText(distAU.toFixed(2) + ' AU', 12, 96);
      c.font = '12px ' + MONO;
      c.fillText('(' + Math.round(distAU * 149.6).toLocaleString('fi-FI') + ' milj. km)', 12, 116);
    } else {
      c.fillText(Math.max(0, Math.round(distU * 149600)).toLocaleString('fi-FI') + ' km', 12, 96);
    }
    const v = (S.effFrac || 0) * C;
    c.font = '14px ' + MONO;
    c.fillText('ETA ' + (v > 0.5 ? fmtTime(distU / v) : '—'), 12, 144);
    // tähtäyskehikko koristeena
    c.strokeStyle = hue; c.globalAlpha = 0.5; c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(196, 60); c.lineTo(186, 60); c.lineTo(186, 70);
    c.moveTo(236, 60); c.lineTo(246, 60); c.lineTo(246, 70);
    c.moveTo(196, 110); c.lineTo(186, 110); c.lineTo(186, 100);
    c.moveTo(236, 110); c.lineTo(246, 110); c.lineTo(246, 100);
    c.stroke();
    c.globalAlpha = 1;
  } else {
    const sd = surfDebug();
    const v = sd.descentV();
    const rollDeg = Math.abs(sd.roll() * 180 / Math.PI);
    c.fillStyle = '#ffffff';
    c.font = '700 20px ' + MONO;
    c.fillText((sd.body || '—') + ' · PINTA', 12, 60);
    c.font = '14px ' + MONO;
    c.fillStyle = v <= 55 ? '#4dff88' : '#ff7a5c';
    c.fillText('VAUHTI    ' + (v <= 55 ? 'OK' : 'LIIAN KOVA'), 12, 100);
    c.fillStyle = rollDeg <= 2 ? '#4dff88' : '#ff7a5c';
    c.fillText('KALLISTUS ' + (rollDeg <= 2 ? 'OK' : 'LIIKAA'), 12, 126);
    c.fillStyle = hue;
    c.font = '12px ' + MONO;
    c.fillText('B = takaisin avaruuteen', 12, 170);
  }
}

const LIVE_DRAW = { pos: drawPos, spd: drawSpd, tgt: drawTgt };

/* ---- geometria-apurit ---- */
const _blinkers = [];
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();

// nelikulmio neljästä kulmapisteestä (a→b→c→d sisäpuolelta katsottuna),
// uv metreinä → paneelitekstuuri toistuu pintojen yli yhtenäisesti
function quad(parent, mat, a, b, c, d){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    ...a, ...b, ...c, ...a, ...c, ...d], 3));
  const u = _v1.fromArray(b).distanceTo(_v2.fromArray(a));
  const v = _v1.fromArray(d).distanceTo(_v2.fromArray(a));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, u, 0, u, v, 0, 0, u, v, 0, v], 2));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  parent.add(m);
  return m;
}

// palkki kahden pisteen välille (oktagonipoikkileikkaus; fasetit erottuvat
// materiaalin flatShadingilla)
function bar(parent, mat, a, b, r){
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8, 1, false, Math.PI / 8), mat);
  m.position.copy(va).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  parent.add(m);
  return m;
}

function box(parent, mat, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

function blinker(parent, color, x, y, z, period, phase){
  const mat = new THREE.MeshBasicMaterial({ color });
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), mat);
  m.position.set(x, y, z);
  parent.add(m);
  _blinkers.push({ mat, on: new THREE.Color(color), period, phase });
}

/* ---- ohjaamon rakentaminen ----
   Runko on kahdeksankulmainen frustum: takarengas iso, keularengas pienempi
   ja lasikuvun sisärengas pienin — välit fasetoitu paneelein ja rivoin. */
const OCT = [];
for (let i = 0; i < 8; i++) {
  const a = i * Math.PI / 4 + Math.PI / 8;
  OCT.push([Math.cos(a), Math.sin(a)]);
}
// renkaiden mitat: [z, säde]; oktagoni venytetty leveäksi (sx) ja matalaksi (sy)
const SX = 1.30, SY = 0.92, CY = 0.04;
const RING_REAR = { z: 1.55, r: 1.45 };
const RING_FRONT = { z: -1.05, r: 1.02 };
const RING_INNER = { z: -1.48, r: 0.58 };
function ringP(ring, i){
  const p = OCT[i & 7];
  return [p[0] * ring.r * SX, CY + p[1] * ring.r * SY, ring.z];
}
// piste putken pinnalla: i = reunaindeksi, t = 0 (taka) … 1 (keula), s = 0…1 reunaa pitkin
function faceP(i, t, s){
  const a = ringP(RING_REAR, i), b = ringP(RING_FRONT, i);
  const c = ringP(RING_REAR, i + 1), d = ringP(RING_FRONT, i + 1);
  const p0 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const p1 = [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
  return [p0[0] + (p1[0] - p0[0]) * s, p0[1] + (p1[1] - p0[1]) * s, p0[2] + (p1[2] - p0[2]) * s];
}

function buildCockpit(opts){
  const g = new THREE.Group();

  // kehys/rivat/tummat pinnat: kulunut paneloitu metalli (Poly Haven),
  // canvas-sävy jää varalle kunnes lataus valmistuu
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x383c42, roughness: 0.55, metalness: 0.7, flatShading: true });
  applyPH(frameMat, 'metal_plate_02', [1.1, 1.3, 1.65], [2, 1]);
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.75, metalness: 0.4 });
  applyPH(darkMat, 'metal_plate_02', [0.65, 0.75, 0.95], [1, 1]);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x26282c, roughness: 0.8, metalness: 0.45 });
  applyPH(floorMat, 'metal_plate', [1.7, 1.7, 1.75], [3, 3]);   // kyynelpeltilattia
  const panelT = makePanelTex();
  const wallMat = new THREE.MeshStandardMaterial({
    map: panelT, roughness: 0.92, metalness: 0.12, side: THREE.DoubleSide,
    bumpMap: panelT, bumpScale: 0.5,
  });
  const con = makeConsoleTex(opts.accentCss);
  const consoleMat = new THREE.MeshStandardMaterial({
    map: con.map, emissiveMap: con.emissive, emissive: 0xffffff, emissiveIntensity: 0.75,
    bumpMap: con.bump, bumpScale: 1.6,
    roughness: 0.8, metalness: 0.15,
  });
  const over = makeOverheadTex(opts.accentCss);
  const overheadMat = new THREE.MeshStandardMaterial({
    map: over.map, emissiveMap: over.emissive, emissive: 0xffffff, emissiveIntensity: 0.9,
    roughness: 0.7, metalness: 0.15,
  });
  const doorMat = new THREE.MeshStandardMaterial({ map: makeDoorTex(), roughness: 0.85, metalness: 0.2, side: THREE.DoubleSide });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x99bbdd, transparent: true, opacity: 0.045,
    roughness: 0.55, metalness: 0.22, side: THREE.DoubleSide, depthWrite: false,
  });
  const seatMat = new THREE.MeshStandardMaterial({ color: opts.seat, roughness: 0.95, metalness: 0.05 });
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x4c5056, roughness: 0.45, metalness: 0.8, flatShading: true });
  applyPH(pipeMat, 'metal_plate_02', [0.95, 1.1, 1.4], [1, 2]);

  /* putkirunko: 8 fasettia takarenkaasta keularenkaaseen.
     Sivufasetteihin (i 3 = vasen, i 7 = oikea) upotetaan pieni ikkuna. */
  for (let i = 0; i < 8; i++) {
    const win = (i === 3 || i === 7);
    if (!win) {
      quad(g, wallMat, ringP(RING_REAR, i), ringP(RING_FRONT, i), ringP(RING_FRONT, i + 1), ringP(RING_REAR, i + 1));
    } else {
      // fasetti neljänä kaistana ikkuna-aukon ympärillä + lasi + kehys
      const t0 = 0.56, t1 = 0.86, s0 = 0.30, s1 = 0.70;
      quad(g, wallMat, faceP(i, 0, 0), faceP(i, t0, 0), faceP(i, t0, 1), faceP(i, 0, 1));
      quad(g, wallMat, faceP(i, t1, 0), faceP(i, 1, 0), faceP(i, 1, 1), faceP(i, t1, 1));
      quad(g, wallMat, faceP(i, t0, 0), faceP(i, t1, 0), faceP(i, t1, s0), faceP(i, t0, s0));
      quad(g, wallMat, faceP(i, t0, s1), faceP(i, t1, s1), faceP(i, t1, 1), faceP(i, t0, 1));
      quad(g, glassMat, faceP(i, t0, s0), faceP(i, t1, s0), faceP(i, t1, s1), faceP(i, t0, s1));
      bar(g, frameMat, faceP(i, t0, s0), faceP(i, t0, s1), 0.035);
      bar(g, frameMat, faceP(i, t1, s0), faceP(i, t1, s1), 0.035);
      bar(g, frameMat, faceP(i, t0, s0), faceP(i, t1, s0), 0.035);
      bar(g, frameMat, faceP(i, t0, s1), faceP(i, t1, s1), 0.035);
    }
    // putken rivat reunoja pitkin → keulaa kohti suppenevat linjat
    bar(g, pipeMat, ringP(RING_REAR, i), ringP(RING_FRONT, i), 0.045);
  }

  /* lasikupu: 8 reunapaneelia keularenkaasta sisärenkaaseen + keskioktagoni.
     Tukipuut säteilevät renkaiden kulmista — falcon-kanopia */
  for (let i = 0; i < 8; i++) {
    quad(g, glassMat, ringP(RING_FRONT, i), ringP(RING_INNER, i), ringP(RING_INNER, i + 1), ringP(RING_FRONT, i + 1));
    bar(g, frameMat, ringP(RING_FRONT, i), ringP(RING_INNER, i), 0.05);       // säteittäiset tukipuut
    bar(g, frameMat, ringP(RING_FRONT, i), ringP(RING_FRONT, i + 1), 0.055);  // keularengas
    bar(g, frameMat, ringP(RING_INNER, i), ringP(RING_INNER, i + 1), 0.04);   // sisärengas
  }
  {
    // keskioktagonin lasi
    const sh = new THREE.Shape(OCT.map(p => new THREE.Vector2(p[0] * RING_INNER.r * SX, p[1] * RING_INNER.r * SY)));
    const center = new THREE.Mesh(new THREE.ShapeGeometry(sh), glassMat);
    center.position.set(0, CY, RING_INNER.z);
    g.add(center);
  }
  blinker(g, 0xff5340, ringP(RING_INNER, 5)[0], ringP(RING_INNER, 5)[1], RING_INNER.z + 0.03, 1.4, 0.0);
  blinker(g, 0x46d06a, ringP(RING_INNER, 6)[0], ringP(RING_INNER, 6)[1], RING_INNER.z + 0.03, 2.1, 0.9);

  /* takaseinä: oktagoni ovitekstuurilla */
  {
    const sh = new THREE.Shape(OCT.map(p => new THREE.Vector2(p[0] * RING_REAR.r * SX, p[1] * RING_REAR.r * SY)));
    const rear = new THREE.Mesh(new THREE.ShapeGeometry(sh), doorMat);
    rear.position.set(0, CY, RING_REAR.z);
    rear.rotation.y = Math.PI;
    rear.scale.x = -1;   // peilaa takaisin oikeinpäin sisältä katsottuna
    g.add(rear);
  }

  /* lattia ja kojelauta: leveä kaareva konsoli näyttörivistöllä */
  box(g, floorMat, 2.6, 0.05, 2.9, 0, -0.93, 0.15);   // kyynelpeltilattia
  const dash = new THREE.Group();
  g.add(dash);
  const dashY = -0.46, dashZ = -0.82, tilt = -0.42;
  const segs = [
    { w: 1.25, x: 0, z: dashZ, ry: 0 },
    { w: 0.95, x: -0.93, z: dashZ + 0.27, ry: 0.62 },
    { w: 0.95, x: 0.93, z: dashZ + 0.27, ry: -0.62 },
  ];
  for (const sg of segs) {
    const b = box(dash, [darkMat, darkMat, consoleMat, darkMat, darkMat, darkMat],
      sg.w, 0.09, 0.55, sg.x, dashY, sg.z, tilt, sg.ry, 0);
    // etulevy konsolista lattiaan
    box(dash, darkMat, sg.w, 0.52, 0.07, sg.x * 1.13, dashY - 0.28, sg.z - 0.18 + Math.abs(sg.x) * 0.16, 0, sg.ry, 0);
    b.userData.ry = sg.ry;
  }
  // näyttörivistö: keskirivin kolme ruutua ovat eläviä mittareita
  // (sijainti / nopeus / kohde), reunimmaiset staattista telemetriakoristetta
  const screenDefs = [
    { kind: 'pos', x: -0.42, z: dashZ - 0.02, ry: 0, live: true },
    { kind: 'spd', x: 0, z: dashZ - 0.04, ry: 0, live: true },
    { kind: 'tgt', x: 0.42, z: dashZ - 0.02, ry: 0, live: true },
    { kind: 'wave', x: -1.00, z: dashZ + 0.24, ry: 0.62 },
    { kind: 'bars', x: 1.00, z: dashZ + 0.24, ry: -0.62 },
  ];
  for (const sd of screenDefs) {
    let emissiveMap;
    if (sd.live) {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 192;
      emissiveMap = new THREE.CanvasTexture(cv);
      emissiveMap.colorSpace = THREE.SRGBColorSpace;
      emissiveMap.anisotropy = 8;
      _live.push({ kind: sd.kind, ctx: cv.getContext('2d'), tex: emissiveMap, hue: opts.screenCss, group: g });
    } else {
      emissiveMap = makeScreenTex(sd.kind, opts.screenCss);
    }
    const sm = new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap,
      emissiveIntensity: 1.05, roughness: 0.3,
    });
    const holder = new THREE.Group();
    holder.position.set(sd.x, dashY + 0.10, sd.z);
    holder.rotation.set(-0.32, sd.ry, 0);
    dash.add(holder);
    box(holder, frameMat, 0.40, 0.28, 0.035, 0, 0, 0);
    const sc = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.24), sm);
    sc.position.z = 0.02;
    holder.add(sc);
  }
  blinker(dash, 0xffb340, -0.30, dashY + 0.06, dashZ + 0.20, 0.9, 0.4);
  blinker(dash, 0xff5340, 0.30, dashY + 0.06, dashZ + 0.20, 1.7, 1.3);

  /* keskipedestaali kaasukahvoineen */
  box(g, [darkMat, darkMat, consoleMat, darkMat, darkMat, darkMat], 0.40, 0.32, 0.5, 0, -0.80, -0.30, -0.12);
  for (const lx of [-0.09, 0.09]) {
    const lever = box(g, pipeMat, 0.03, 0.2, 0.03, lx, -0.56, -0.30, 0.5);
    box(lever, darkMat, 0.06, 0.05, 0.06, 0, 0.11, 0);
  }

  /* kattokonsoli */
  const oh = box(g, [darkMat, darkMat, darkMat, overheadMat, darkMat, darkMat], 1.15, 0.09, 0.55, 0, CY + RING_FRONT.r * SY - 0.07, -0.55, 0.30);
  blinker(oh, opts.accent, -0.45, -0.06, 0, 1.9, 0.2);
  blinker(oh, 0xffb340, 0.45, -0.06, 0, 0.7, 1.1);

  /* istuimet */
  for (const side of [-1, 1]) {
    box(g, seatMat, 0.50, 0.10, 0.50, side * 0.55, -0.66, -0.10);
    box(g, seatMat, 0.50, 0.52, 0.11, side * 0.55, -0.38, 0.18, -0.14);
    box(g, seatMat, 0.24, 0.15, 0.09, side * 0.55, -0.06, 0.22, -0.14);
  }

  mergeStatic(g);
  g.visible = false;
  camera.add(g);
  return g;
}

/* yhdistä staattiset meshit materiaaleittain — ~90 piirtokutsua → ~10.
   Näytöt (emissiveMap + flicker), vilkkuvalot (MeshBasic) ja
   monimateriaalilaatikot (konsolipinnat) jäävät omiksi mesheikseen */
function mergeStatic(g){
  g.updateMatrixWorld(true);
  const byMat = new Map();
  const remove = [];
  g.traverse(m => {
    if (!m.isMesh) return;
    if (Array.isArray(m.material) || !m.material.isMeshStandardMaterial) return;
    if (m.material.emissiveMap) return;
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    geo.applyMatrix4(m.matrixWorld);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(geo);
    remove.push(m);
  });
  for (const m of remove) m.parent.remove(m);
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    for (const x of geos) x.dispose();
    g.add(new THREE.Mesh(merged, mat));
  }
}

/* ---- ulkonäkymän alusmallit (takaviistosta) ----
   Mallit ovat kameran lapsia kuten ohjaamotkin: alus istuu katseakselin
   ala-etupuolella, jolloin sitä katsotaan takaviistosta ylhäältä ja
   maailma kääntyy ympärillä. Valaistus sama kuin ohjaamoissa. */

// kahdeksankulmaisen renkaan piste alusmalleille (paikalliskoordinaatit)
function octPt(i, r, z, sy = 0.85){
  const p = OCT[i & 7];
  return [p[0] * r, p[1] * r * sy, z];
}

/* Millennium Falcon -henkinen runko: linssimäinen lautanen, kaksi
   keulahaarukkaa ja oikealla oktagoniputki, jonka kärjessä sama
   fasetoitu kanopia kuin sisätilan ikkunassa */
function buildFalcon(){
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x82868c, roughness: 0.62, metalness: 0.45 });
  applyPH(hullMat, 'metal_plate_02', [1.35, 1.4, 1.5], [3, 3]);
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.7, metalness: 0.5, side: THREE.DoubleSide });
  applyPH(darkMat, 'metal_plate_02', [0.62, 0.66, 0.78], [2, 2]);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x383c42, roughness: 0.5, metalness: 0.7, flatShading: true });
  applyPH(frameMat, 'metal_plate_02', [1.0, 1.1, 1.3], [2, 1]);
  // tumma kiiltävä kanopialasi (sisätilaa ei mallinneta — aurinko kimpoaa pinnasta)
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1118, roughness: 0.15, metalness: 0.75, side: THREE.DoubleSide });
  const glowMat = new THREE.MeshBasicMaterial();
  glowMat.color.setRGB(0.45, 0.8, 1.1);   // hienovarainen moottorihehku

  // lautasrunko: litistetty pallo + reunapanta
  const disc = new THREE.Mesh(new THREE.SphereGeometry(2.6, 28, 14), hullMat);
  disc.scale.set(1, 0.32, 1);
  g.add(disc);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.58, 2.58, 0.36, 28, 1, true), darkMat);
  g.add(band);

  // keulahaarukat ja niiden välinen kuoppa
  for (const s of [-1, 1]) {
    box(g, hullMat, 0.82, 0.44, 2.3, s * 0.92, 0, -3.0);
    box(g, darkMat, 0.5, 0.3, 0.5, s * 0.92, 0, -4.1);
    box(g, darkMat, 0.16, 0.36, 2.1, s * 0.48, 0, -2.95);
  }
  box(g, darkMat, 0.82, 0.3, 1.0, 0, 0, -2.35);

  // ohjaamoputki oikealla: oktagonifrustum + fasetoitu kanopia kuten sisällä
  const tube = new THREE.Group();
  tube.position.set(1.62, 0.02, -0.4);
  g.add(tube);
  const R0 = { r: 0.56, z: 0.9 }, R1 = { r: 0.48, z: -1.45 }, R2 = { r: 0.26, z: -1.85 };
  for (let i = 0; i < 8; i++) {
    quad(tube, hullMat, octPt(i, R0.r, R0.z), octPt(i, R1.r, R1.z), octPt(i + 1, R1.r, R1.z), octPt(i + 1, R0.r, R0.z));
    quad(tube, glassMat, octPt(i, R1.r, R1.z), octPt(i, R2.r, R2.z), octPt(i + 1, R2.r, R2.z), octPt(i + 1, R1.r, R1.z));
    bar(tube, frameMat, octPt(i, R1.r, R1.z), octPt(i, R2.r, R2.z), 0.035);
    bar(tube, frameMat, octPt(i, R1.r, R1.z), octPt(i + 1, R1.r, R1.z), 0.035);
    bar(tube, frameMat, octPt(i, R2.r, R2.z), octPt(i + 1, R2.r, R2.z), 0.028);
  }
  {
    const sh = new THREE.Shape(OCT.map(p => new THREE.Vector2(p[0] * R2.r, p[1] * R2.r * 0.85)));
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(sh), glassMat);
    cap.position.z = R2.z;
    cap.rotation.y = Math.PI;
    tube.add(cap);
  }

  // moottoripalkki ja hehku perään
  box(g, darkMat, 3.4, 0.5, 0.3, 0, 0, 2.42);
  const glow = box(g, glowMat, 2.9, 0.1, 0.05, 0, 0, 2.6);
  glow.userData.glow = true;

  // lautasantenni ja greeblet kannelle
  const dishArm = box(g, frameMat, 0.07, 0.5, 0.07, -1.0, 0.6, 0.55);
  const dish = new THREE.Mesh(new THREE.CircleGeometry(0.38, 16), darkMat);
  dish.position.set(-1.0, 0.92, 0.55);
  dish.rotation.x = -0.9;
  g.add(dish);
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9 + 0.4, rr = 0.8 + (i % 3) * 0.5;
    box(g, darkMat, 0.3 + (i % 3) * 0.14, 0.12, 0.4 + (i % 2) * 0.2,
      Math.cos(a) * rr, 0.38 - (i % 2) * 0.04, Math.sin(a) * rr + 0.4);
  }
  blinker(g, 0xff5340, 0, 0.62, 1.6, 1.6, 0.3);
  blinker(g, 0x46d06a, -2.45, 0.12, 0.8, 2.2, 1.1);

  mergeStatic(g);
  // lähellä kameraa ja pienennettynä — iso offset uppoaisi planeetan
  // pintaan lähietäisyyksillä (syvyystesti piilottaisi aluksen)
  g.scale.setScalar(0.5);
  g.position.set(0, -0.95, -4.6);
  g.visible = false;
  camera.add(g);
  return g;
}

/* Star Trek -henkinen sukkula: laatikkorunko viistolla keulalla,
   tummat lasit, varoitusraidat, kaksi konehtimoa hehkuineen */
function buildShuttle(){
  const g = new THREE.Group();
  const panelT = makePanelTex();
  const hullMat = new THREE.MeshStandardMaterial({
    map: panelT, bumpMap: panelT, bumpScale: 0.4,
    roughness: 0.7, metalness: 0.25, side: THREE.DoubleSide,
  });
  hullMat.color.setRGB(1.15, 1.16, 1.2);
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2c2f34, roughness: 0.65, metalness: 0.5, side: THREE.DoubleSide });
  applyPH(darkMat, 'metal_plate_02', [0.7, 0.74, 0.85], [2, 2]);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1118, roughness: 0.15, metalness: 0.75, side: THREE.DoubleSide });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x7a2828, roughness: 0.6, metalness: 0.3 });
  const redGlow = new THREE.MeshBasicMaterial();
  redGlow.color.setRGB(1.15, 0.35, 0.25);
  const blueGlow = new THREE.MeshBasicMaterial();
  blueGlow.color.setRGB(0.45, 0.8, 1.1);

  // päärunko ja viisto keulaosa (frustum nelikulmioista)
  box(g, hullMat, 2.2, 1.35, 3.4, 0, 0, 0.7);
  const A = [[-1.1, -0.675, -1.0], [1.1, -0.675, -1.0], [1.1, 0.675, -1.0], [-1.1, 0.675, -1.0]];
  const B = [[-0.82, -0.62, -2.9], [0.82, -0.62, -2.9], [0.82, 0.16, -2.9], [-0.82, 0.16, -2.9]];
  quad(g, hullMat, A[0], A[1], B[1], B[0]);   // pohja
  quad(g, hullMat, A[3], B[3], B[2], A[2]);   // viisto katto
  quad(g, hullMat, A[0], B[0], B[3], A[3]);   // vasen
  quad(g, hullMat, A[1], A[2], B[2], B[1]);   // oikea
  quad(g, hullMat, B[0], B[1], B[2], B[3]);   // keulalevy
  // tuulilasi viistoon kattoon + kehys
  const W0 = [-0.62, 0.62, -2.42], W1 = [0.62, 0.62, -2.42], W2 = [0.5, 0.28, -2.86], W3 = [-0.5, 0.28, -2.86];
  quad(g, glassMat, W3, W2, W1, W0).position.y = 0.012;
  bar(g, darkMat, W0, W1, 0.035); bar(g, darkMat, W2, W3, 0.035);
  bar(g, darkMat, W0, W3, 0.035); bar(g, darkMat, W1, W2, 0.035);
  bar(g, darkMat, [0, 0.62, -2.42], [0, 0.28, -2.86], 0.028);   // keskipuite

  // sivuraidat ja takaovi varoitusraitoineen
  for (const s of [-1, 1]) box(g, stripeMat, 0.02, 0.2, 3.2, s * 1.105, 0.18, 0.6);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.15), new THREE.MeshStandardMaterial({
    map: makeDoorTex(), roughness: 0.8, metalness: 0.25 }));
  door.position.set(0, -0.02, 2.435);
  door.rotation.y = Math.PI;
  g.add(door);
  const imp = box(g, redGlow, 1.5, 0.1, 0.05, 0, 0.55, 2.43);
  imp.userData.glow = true;

  // konehtimot pylonien varassa (toimivat laskutelineinä)
  for (const s of [-1, 1]) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 3.3, 12), darkMat);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(s * 1.42, -0.92, 0.55);
    g.add(nac);
    box(g, hullMat, 0.16, 0.55, 1.1, s * 1.22, -0.62, 0.55, 0, 0, s * 0.5);
    const buss = new THREE.Mesh(new THREE.SphereGeometry(0.27, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), redGlow);
    buss.rotation.x = -Math.PI / 2;
    buss.position.set(s * 1.42, -0.92, -1.1);
    g.add(buss);
    const strip = box(g, blueGlow, 0.05, 0.08, 2.0, s * 1.68, -0.92, 0.5);
    strip.userData.glow = true;
    blinker(g, s < 0 ? 0xff5340 : 0x46d06a, s * 1.42, -0.6, 1.9, 1.3, s);
  }
  // kattogreeblet ja antenni
  box(g, darkMat, 0.7, 0.14, 1.2, 0, 0.75, 0.8);
  box(g, darkMat, 0.3, 0.1, 0.5, 0.55, 0.73, 0.1);
  bar(g, darkMat, [-0.6, 0.68, 1.7], [-0.6, 1.05, 1.7], 0.025);
  blinker(g, 0xffb340, -0.6, 1.1, 1.7, 0.9, 0.5);

  mergeStatic(g);
  g.scale.setScalar(0.7);
  g.position.set(0, -1.15, -7.5);
  g.visible = false;
  camera.add(g);
  return g;
}

/* avaruusaluksen komentosilta: siniset näytöt (referenssin mukaan) */
const bridgeCockpit = buildCockpit({
  accent: 0x3fb8ff, accentCss: '#3fb8ff', screenCss: '#6cc8ff',
  seat: 0x4a3c30,
});
/* laskeutumisalus: lämmin meripihka-aksentti */
const landerCockpit = buildCockpit({
  accent: 0xffb340, accentCss: '#ffb340', screenCss: '#ffc468',
  seat: 0x37404a,
});
/* ulkonäkymän mallit */
const falconExt = buildFalcon();
const shuttleExt = buildShuttle();

/* V vaihtaa ohjaamon ja ulkonäkymän (takaviistosta) välillä */
let extView = false;
export function toggleShipView(){
  if (S.mode === 'surface') return;
  extView = !extView;
}

/* valot: aurinko pistevalona origosta (avaruusscene — planeetat ovat
   shader-materiaaleja eivätkä reagoi) + himmeä ambientti ja ohjaamon
   sisäinen lämmin täytevalo, jotta mittaristo erottuu yöpuolellakin */
const sunLight = new THREE.PointLight(0xfff4e0, 1.9, 0, 0);
sunLight.position.set(0, 0, 0);
scene.add(sunLight);
const spaceAmbient = new THREE.AmbientLight(0x303a48, 0.55);
scene.add(spaceAmbient);
const fillLight = new THREE.PointLight(0xdfe8f2, 0.4, 5, 1.6);
fillLight.position.set(0, 0.25, -0.45);
camera.add(fillLight);

let _lastDraw = -9;
export function updateCockpit(){
  bridgeCockpit.visible = S.mode === 'space' && !extView;
  landerCockpit.visible = S.mode === 'descent' && !extView;
  falconExt.visible = S.mode === 'space' && extView;
  shuttleExt.visible = S.mode === 'descent' && extView;
  fillLight.visible = S.mode !== 'surface' && !extView;
  const t = S.simTime;
  if (S.mode === 'surface') return;
  for (const b of _blinkers) {
    const on = Math.sin(t * 6.2832 / b.period + b.phase) > 0.2;
    b.mat.color.copy(b.on).multiplyScalar(on ? 1.6 : 0.12);
  }
  // elävät mittarinäytöt ~8 Hz — vain näkyvän ohjaamon
  if (t - _lastDraw >= 0.12) {
    _lastDraw = t;
    for (const ls of _live) {
      if (!ls.group.visible) continue;
      LIVE_DRAW[ls.kind](ls.ctx, ls.hue);
      ls.tex.needsUpdate = true;
    }
  }
}
