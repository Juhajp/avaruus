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
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { scene, camera, renderer, AU, C_KMS } from './core.js';
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
// hienovarainen gradientti + kevyt laikutus: käytetään `map`ina materiaaleille,
// joilla ei ole omaa tekstuuria → mikään pinta ei ole tasaista yksiväristä.
// Harmaasävyinen (materiaalin color sävyttää); keskiarvo ~0,95 (tuskin tummentaa).
let _subtleTex = null;
function subtleTex(){
  if (_subtleTex) return _subtleTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d'); const r = rng(131);
  const g = c.createLinearGradient(0, 0, 64, 128);
  g.addColorStop(0, '#e6e6e6'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#dedede');
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1100; i++) {   // hyvin kevyt laikutus
    const v = 222 + r() * 33 | 0;
    c.fillStyle = `rgba(${v},${v},${v},0.22)`;
    c.fillRect(r() * 128, r() * 128, 2 + r() * 6, 2 + r() * 6);
  }
  _subtleTex = tex(cv, true);
  return _subtleTex;
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

// takaseinän huoltoluukku varoitusraitoineen — ei tasaista yksiväristä pintaa:
// gradienttipohja + laikutus, keskuspaneeli, niitit, naarmut
function makeDoorTex(){
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d'); const r = rng(211);
  // pohja: pystygradientti (ei yksivärinen)
  const g = c.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#8a8e94'); g.addColorStop(0.5, '#7e8288'); g.addColorStop(1, '#70747a');
  c.fillStyle = g; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1500; i++) {   // kevyt likalaikutus
    const v = 110 + r() * 44 | 0;
    c.fillStyle = `rgba(${v},${v + 2},${v + 6},0.10)`;
    c.fillRect(r() * 512, r() * 512, 3 + r() * 11, 3 + r() * 11);
  }
  // keskuspaneeli (oktagoni) hieman tummempana
  const oct = [[256, 60], [398, 120], [440, 256], [398, 392], [256, 452], [114, 392], [72, 256], [114, 120]];
  c.fillStyle = '#6a6e74';
  c.beginPath(); oct.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath(); c.fill();
  c.strokeStyle = '#34373c'; c.lineWidth = 8; c.stroke();
  c.lineWidth = 4;
  c.beginPath(); c.moveTo(256, 60); c.lineTo(256, 452); c.stroke();
  // niitit oktagonin kulmiin + saranat
  c.fillStyle = '#3a3d42';
  for (const [x, y] of oct) { c.beginPath(); c.arc(x, y, 6, 0, 7); c.fill(); }
  c.fillStyle = '#2a2c30'; c.fillRect(120, 235, 24, 12); c.fillRect(368, 265, 24, 12);
  // naarmut (vaaleat/tummat)
  for (let i = 0; i < 36; i++) {
    const x = r() * 512, y = r() * 512, a = r() * 6.28, l = 8 + r() * 34;
    c.strokeStyle = r() < 0.5 ? 'rgba(210,210,210,0.12)' : 'rgba(50,50,50,0.14)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
  }
  // varoitusraidat ala- ja yläreunaan
  c.fillStyle = '#caa23c';
  for (let x = 0; x < 512; x += 64) {
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
let falconGlow = null;   // avaruusaluksen moottorihehkun materiaali (ajetaan vauhdista)
const _dir = new THREE.Vector3();
const MONO = 'ui-monospace, Menlo, Consolas, monospace';


function scrHead(c, hue, title){
  // tumma metallinen reunus (sulautuu kojelautaan) + sisään upotettu ruutu:
  // reuna = kojelaudan väriä, upotusvarjo ja ohut valoreuna → ei "päälleliimattu"
  const m = 9;
  c.fillStyle = '#0c0f14'; c.fillRect(0, 0, 256, 192);               // reunus = tumma metalli
  // upotusviiste: tumma reuna sisään, ohut yläkiilto
  c.fillStyle = '#05080d'; c.fillRect(m - 2, m - 2, 256 - 2 * (m - 2), 192 - 2 * (m - 2));
  c.fillStyle = '#03070c'; c.fillRect(m, m, 256 - 2 * m, 192 - 2 * m); // varsinainen ruutu
  c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 2;
  c.strokeRect(m + 1, m + 1, 254 - 2 * m, 190 - 2 * m);               // sisävarjo
  c.strokeStyle = 'rgba(150,170,200,0.10)'; c.lineWidth = 1;
  c.strokeRect(m - 1.5, m - 1.5, 259 - 2 * m, 195 - 2 * m);           // valoreuna
  c.fillStyle = hue; c.globalAlpha = 0.65;
  c.font = '700 12px ' + MONO;
  c.fillText(title, 15, 33);
  c.globalAlpha = 0.28; c.fillRect(m + 4, 39, 256 - 2 * m - 8, 1);
  c.globalAlpha = 1;
}

// vasen näyttö: aurinkokuntakartta ylhäältä (log-skaalatut radat),
// kohde korostettuna ja alus suuntakolmiona
// lineaarinen väri (BODIES.opts) → sRGB-canvasväri
function _l2s(v){ v = Math.max(0, v); return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
function planetCol(arr, a = 1, mul = 1){
  const f = v => Math.max(0, Math.min(255, Math.round(255 * _l2s(v * mul))));
  return `rgba(${f(arr[0])},${f(arr[1])},${f(arr[2])},${a})`;
}
// sRGB 0..255 -kanava lineaarisesta
function _s8(v){ return Math.max(0, Math.min(255, Math.round(255 * _l2s(v)))); }
// tiilattava arvokohina (jaksollinen x:ssä → pintakartta kiertyy saumattomasti)
function _h2(i, j){ const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); }
function _vn(x, y, P){
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const wx = xf * xf * (3 - 2 * xf), wy = yf * yf * (3 - 2 * yf);
  const wp = i => ((i % P) + P) % P;
  const a = _h2(wp(xi), yi), b = _h2(wp(xi + 1), yi), e = _h2(wp(xi), yi + 1), f = _h2(wp(xi + 1), yi + 1);
  return (a * (1 - wx) + b * wx) * (1 - wy) + (e * (1 - wx) + f * wx) * wy;
}
function _fbm(x, y, P, oct){ let s = 0, a = 0.5, fr = 1; for (let o = 0; o < oct; o++){ s += a * _vn(x * fr, y * fr, P * fr); a *= 0.5; fr *= 2; } return s; }
const _mixc = (A, B, t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];

/* planeetan ekvirektangulaarinen pintakartta (proseduraalinen kohina → mantereet,
   vyöt, pilvet, jääkalotit) piirretään KERRAN per planeetta offscreen-canvasille
   ja välimuistitetaan. Tiilattava x:ssä, joten se kiertyy saumattomasti. */
const _stripCache = {};
function planetStrip(body){
  const def = body.def, key = def.name;
  if (_stripCache[key]) return _stripCache[key];
  const W = 180, H = 60, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), d = img.data, o = def.opts || {};
  let c1, c2, c3, kind;
  if (def.type === 'sun')        { c1 = [1, 0.42, 0.08]; c2 = [1, 0.72, 0.25]; c3 = [1, 0.96, 0.72]; kind = 'sun'; }
  else if (def.type === 'earth') { c1 = [0.10, 0.34, 0.12]; c2 = [0.03, 0.16, 0.40]; c3 = [0.92, 0.94, 0.98]; kind = 'earth'; }
  else if (def.type === 'gas')   { c1 = o.c1 || [0.6, 0.5, 0.35]; c2 = o.c2 || [0.85, 0.78, 0.6]; c3 = o.c3 || [0.4, 0.3, 0.2]; kind = 'gas'; }
  else                           { c1 = o.c1 || [0.4, 0.36, 0.32]; c2 = o.c2 || [0.6, 0.55, 0.5]; c3 = o.c3 || [0.25, 0.22, 0.2]; kind = 'rocky'; }
  const P = 8;
  for (let y = 0; y < H; y++){
    const lat = (y / H - 0.5) * 2;                       // -1..1
    for (let x = 0; x < W; x++){
      const fx = x / W * P, fy = y / H * P; let col;
      if (kind === 'gas'){
        const warp = (_fbm(fx, fy, P, 3) - 0.5) * (o.turb || 1.5);
        const t = 0.5 + 0.5 * Math.sin(lat * Math.PI * (o.bandFreq || 5) * 0.5 + warp * 4);
        col = _mixc(_mixc(c3, c1, t), c2, _fbm(fx * 1.6 + 3, fy * 1.6, P, 2) * 0.45);
        col = _mixc(col, c3, Math.max(0, _fbm(fx * 2 + 9, fy * 2, P, 2) - 0.62) * 0.7);
        if (o.spot && Math.abs(lat - 0.25) < 0.13){       // Jupiterin punainen pilkku
          const dl = ((x / W - 0.6 + 1) % 1) - 0.0; const dx = Math.min(Math.abs(x / W - 0.6), 1 - Math.abs(x / W - 0.6));
          const sp = Math.max(0, 1 - Math.hypot(dx * 5, (lat - 0.25) * 8));
          col = _mixc(col, o.spotColor || [0.78, 0.32, 0.18], sp * 0.85);
        }
      } else if (kind === 'rocky'){
        const h = _fbm(fx, fy, P, 4);
        col = h > 0.52 ? _mixc(c2, c1, (h - 0.52) * 2) : _mixc(c3, c1, h * 1.4);
        col = _mixc(col, c3, Math.max(0, 0.34 - h) * 1.4);  // tummat kraatterit/altaat
        if (o.polar && Math.abs(lat) > 0.84) col = _mixc(col, [0.88, 0.9, 0.95], (Math.abs(lat) - 0.84) / 0.16 * 0.85);
      } else if (kind === 'earth'){
        const h = _fbm(fx, fy, P, 4);
        col = h > 0.55 ? _mixc(c1, [0.5, 0.42, 0.22], Math.max(0, h - 0.78) * 2)
                       : _mixc(c2, [0.02, 0.09, 0.26], Math.max(0, 0.55 - h) * 1.3);
        if (Math.abs(lat) > 0.82) col = _mixc(col, c3, (Math.abs(lat) - 0.82) / 0.18);   // jääkalotit
        const cl = _fbm(fx * 1.3 + 20, fy * 1.3, P, 3);                                   // pilvet
        if (cl > 0.6) col = _mixc(col, [0.95, 0.96, 1.0], Math.min(1, (cl - 0.6) * 3));
      } else {                                            // aurinko: granulaatio
        col = _mixc(c1, c3, _fbm(fx * 1.6, fy * 1.6, P, 3));
        col = _mixc(col, c2, _fbm(fx * 3 + 7, fy * 3, P, 2) * 0.4);
      }
      const i = (y * W + x) * 4; d[i] = _s8(col[0]); d[i + 1] = _s8(col[1]); d[i + 2] = _s8(col[2]); d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _stripCache[key] = cv; return cv;
}

/* pyörivä planeetan lähikuva: ekvirektangulaarinen pintakartta projisoidaan
   palloksi sarakkeittain (asin-projektio → oikea reunatiivistys), kierto skrollaa
   karttaa. Ei ulkoista tekstuuria → ei canvasin tainttausta. */
function drawPlanetOrb(c, ox, oy, R, body, t){
  const def = body.def, isSun = def.type === 'sun';
  const strip = planetStrip(body), SW = strip.width, SH = strip.height;
  const phaseAng = t * (isSun ? 0.18 : 0.35);
  c.save();
  c.beginPath(); c.arc(ox, oy, R, 0, 7); c.clip();
  c.fillStyle = '#000'; c.fillRect(ox - R, oy - R, 2 * R, 2 * R);
  for (let x = -R; x <= R; x += 2){
    const u = Math.max(-0.999, Math.min(0.999, x / R));
    const lon = (Math.asin(u) + phaseAng) / (2 * Math.PI);
    // kokonaislukusarake [0, SW-1] → 1 px:n lähde pysyy kuvan sisällä (ei
    // läpinäkyvää/mustaa juovaa kun kierto ylittää tekstuurin sauman)
    const sx = Math.min(SW - 1, Math.floor((lon - Math.floor(lon)) * SW));
    const ch = Math.sqrt(Math.max(0, R * R - x * x));
    c.drawImage(strip, sx, 0, 1, SH, ox + x, oy - ch, 2, 2 * ch);
  }
  let g;                                                 // valaistus / limbi
  if (isSun) { g = c.createRadialGradient(ox, oy, R * 0.1, ox, oy, R); g.addColorStop(0, 'rgba(255,250,225,0.4)'); g.addColorStop(0.7, 'rgba(255,170,60,0)'); g.addColorStop(1, 'rgba(255,110,20,0.25)'); }
  else { g = c.createRadialGradient(ox - R * 0.38, oy - R * 0.38, R * 0.1, ox, oy, R); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.62)'); }
  c.fillStyle = g; c.fillRect(ox - R, oy - R, 2 * R, 2 * R);
  c.restore();
  if (def.rings) {                                       // Saturnuksen renkaat (tyylitelty)
    c.save(); c.translate(ox, oy); c.scale(1, 0.34); c.strokeStyle = 'rgba(222,210,176,0.55)'; c.lineWidth = 2.4;
    c.beginPath(); c.arc(0, 0, R * 1.55, 0, 7); c.stroke(); c.restore();
  }
  if (isSun) { c.strokeStyle = 'rgba(255,180,80,0.5)'; c.lineWidth = 2; c.beginPath(); c.arc(ox, oy, R + 1.5, 0, 7); c.stroke(); }
  else if (def.atmo) { c.strokeStyle = planetCol(def.atmo.color, 0.45); c.lineWidth = 2.5; c.beginPath(); c.arc(ox, oy, R + 1.5, 0, 7); c.stroke(); }
  c.strokeStyle = 'rgba(150,180,210,0.28)'; c.lineWidth = 1; c.beginPath(); c.arc(ox, oy, R, 0, 7); c.stroke();
}
function drawPos(c, hue){
  scrHead(c, hue, S.mode === 'space' ? 'SIJAINTI' : 'ASENTO');
  if (S.mode === 'space') {
    // kartta siirretty vasemmalle, jotta oikeaan yläkulmaan mahtuu planeetan lähikuva
    const cx = 92, cy = 82;
    const rOf = (au) => 11 + 44 * Math.log10(1 + au * 3) / Math.log10(1 + 30.07 * 3);
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
    // valitun planeetan pyörivä lähikuva oikeaan yläkulmaan + kohdistinmerkit
    const oX = 206, oY = 92, oR = 29;
    drawPlanetOrb(c, oX, oY, oR, bodies[S.targetIdx], S.simTime);
    const bs = oR + 8, cl = 9;
    c.strokeStyle = hue; c.lineWidth = 1.5; c.globalAlpha = 0.7;
    for (const sgx of [-1, 1]) for (const sgy of [-1, 1]) {
      const px = oX + sgx * bs, py = oY + sgy * bs;
      c.beginPath();
      c.moveTo(px - sgx * cl, py); c.lineTo(px, py); c.lineTo(px, py - sgy * cl);
      c.stroke();
    }
    c.globalAlpha = 1;
    // kohdetiedot kartan alla (siirretty entisestä KOHDE-näytöstä; ei ETA:a)
    const tgt = bodies[S.targetIdx];
    const distU = camera.position.distanceTo(tgt.group.position) - tgt.def.r;
    const distAU = distU / AU;
    c.fillStyle = '#aef7c1'; c.font = '13px ' + MONO;
    c.fillText('▸ ' + tgt.def.name, 12, 158);
    c.fillStyle = hue; c.font = '12px ' + MONO;
    c.fillText(distAU >= 0.01
      ? distAU.toFixed(2) + ' AU · ' + Math.round(distAU * 149.6).toLocaleString('fi-FI') + ' milj. km'
      : Math.max(0, Math.round(distU * 149600)).toLocaleString('fi-FI') + ' km', 12, 178);
  } else {
    // matalalento: keinohorisontti + korkeus näytölle (DOM-overlayt poistettu)
    const sd = surfDebug();
    const alt = sd.descentPos.y - sd.h(sd.descentPos.x, sd.descentPos.z);
    const roll = sd.roll();
    const pitchDeg = (S.pitch || 0) * 180 / Math.PI;
    const cx = 128, cy = 92, R = 50;
    // horisonttilevy: taivas/maa kallistuu -rollin mukaan, siirtyy pitchistä
    c.save();
    c.beginPath(); c.arc(cx, cy, R, 0, 7); c.clip();
    c.translate(cx, cy); c.rotate(-roll);
    const ph = pitchDeg * 1.6;
    c.fillStyle = '#2e5f8e'; c.fillRect(-R - 40, -R - 70 + ph, (R + 40) * 2, R + 70);
    c.fillStyle = '#6e4a2c'; c.fillRect(-R - 40, ph, (R + 40) * 2, R + 70);
    c.strokeStyle = '#e8eef4'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-R - 40, ph); c.lineTo(R + 40, ph); c.stroke();
    c.restore();
    // kallistusasteikko: vihreä ±2°, harmaat ±5/±10°
    for (const [a, col, ln] of [[-2, '#4dff88', 9], [2, '#4dff88', 9], [-5, '#9fb4c8', 6], [5, '#9fb4c8', 6], [-10, '#9fb4c8', 6], [10, '#9fb4c8', 6]]) {
      const rad = a * Math.PI / 180;
      c.strokeStyle = col; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(cx + Math.sin(rad) * R, cy - Math.cos(rad) * R);
      c.lineTo(cx + Math.sin(rad) * (R + ln), cy - Math.cos(rad) * (R + ln));
      c.stroke();
    }
    c.strokeStyle = hue; c.lineWidth = 2;
    c.beginPath(); c.arc(cx, cy, R, 0, 7); c.stroke();
    // kallistusosoitin (kääntyy kallistuksen mukaan)
    c.save(); c.translate(cx, cy); c.rotate(roll);
    c.fillStyle = '#ffd27f'; c.beginPath();
    c.moveTo(0, -R + 2); c.lineTo(-6, -R + 14); c.lineTo(6, -R + 14); c.closePath(); c.fill();
    c.restore();
    // kiinteä alus-symboli
    c.strokeStyle = '#ffd27f'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(cx - 28, cy); c.lineTo(cx - 9, cy); c.lineTo(cx, cy + 7); c.lineTo(cx + 9, cy); c.lineTo(cx + 28, cy); c.stroke();
    c.fillStyle = '#ffd27f'; c.beginPath(); c.arc(cx, cy, 2.5, 0, 7); c.fill();
    // korkeus
    c.fillStyle = hue; c.font = '10px ' + MONO; c.fillText('KORKEUS', 12, 158);
    c.fillStyle = '#ffffff'; c.font = '13px ' + MONO;
    c.fillText(Math.max(0, Math.round(alt)) + ' m', 78, 158);
  }
}

// keskinäyttö: nopeus — avaruudessa % c / km/s / pystymittari, matalalennossa m/s
function drawSpd(c, hue){
  scrHead(c, hue, 'NOPEUS');
  if (S.mode === 'space') {
    const eff = S.effFrac || 0;
    const tgt = S.targetFrac || 0;
    // lukemat vasemmalla (peruutus → oranssi)
    c.fillStyle = eff < -0.0005 ? '#ffae42' : '#d4dde6';
    c.font = '16px ' + MONO;
    c.fillText((eff * 100).toFixed(Math.abs(eff) < 0.105 ? 2 : 1) + ' % c', 12, 64);
    c.fillStyle = hue;
    c.font = '14px ' + MONO;
    c.fillText(Math.round(eff * C_KMS).toLocaleString('fi-FI') + ' km/s', 12, 98);
    // kaasun (throttle) numeerinen voimakkuus -5..99
    const thr = Math.round(tgt * 100);
    c.fillStyle = hue; c.font = '11px ' + MONO;
    c.fillText('KAASU', 12, 130);
    c.fillStyle = thr < 0 ? '#ffae42' : '#cfe6d6';
    c.font = '20px ' + MONO;
    c.fillText(String(thr), 72, 132);
    // pystysuora nopeusmittari oikealla: nollataso + negatiivinen (peruutus) alue
    const bx = 214, bw = 20, bTop = 48, bBot = 176, bH = bBot - bTop;
    const vMin = -0.05, vMax = 1.0, span = vMax - vMin;   // kaasumerkki ulottuu 100 %:iin
    const yOf = (v) => bBot - Math.max(0, Math.min(1, (v - vMin) / span)) * bH;
    const zeroY = yOf(0);
    c.globalAlpha = 0.5; c.strokeStyle = hue; c.lineWidth = 1;
    c.strokeRect(bx, bTop, bw, bH);
    c.globalAlpha = 0.25;
    for (const v of [0.25, 0.5, 0.75]) { const y = yOf(v); c.beginPath(); c.moveTo(bx, y); c.lineTo(bx + bw, y); c.stroke(); }
    c.globalAlpha = 1;
    // täyttö: positiivinen nollasta ylös (hue), negatiivinen nollasta alas (oranssi)
    const yV = yOf(eff);
    if (eff >= 0) { c.fillStyle = hue; c.fillRect(bx + 1, yV, bw - 2, zeroY - yV); }
    else { c.fillStyle = '#ff7a3c'; c.fillRect(bx + 1, zeroY, bw - 2, yV - zeroY); }
    // nollataso korostettuna + merkinnät
    c.strokeStyle = '#d4dde6'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(bx - 4, zeroY); c.lineTo(bx + bw, zeroY); c.stroke();
    c.fillStyle = '#9fb4c8'; c.font = '9px ' + MONO;
    c.fillText('0', bx - 13, zeroY + 3);
    c.fillText('c', bx - 13, bTop + 8);
    // tavoitemerkki (valkoinen viiva mittarin yli)
    const yT = yOf(tgt);
    c.fillStyle = '#ffffff'; c.fillRect(bx - 3, yT - 1, bw + 6, 2);
    // runkokuumennus (ilmakehäsyöksy) — näkyy vain kuumetessa
    const hh = S.hullHeat || 0;
    if (hh > 0.01) {
      const hc = hh < 0.5 ? '#ffae42' : (hh < 0.85 ? '#ff5a1f' : '#ffffff');
      c.font = '11px ' + MONO; c.fillStyle = hc;
      c.fillText('RUNKO', 12, 167);
      c.fillText(Math.round(hh * 100) + ' %', 202, 167);
      c.globalAlpha = 0.35; c.strokeStyle = '#ffae42'; c.lineWidth = 1;
      c.strokeRect(66, 158, 120, 9); c.globalAlpha = 1;
      c.fillStyle = hc; c.fillRect(68, 160, 116 * Math.min(1, hh), 5);
    }
  } else {
    const sd = surfDebug();
    const v = sd.descentV();
    c.fillStyle = v <= 55 ? '#4dff88' : '#d4dde6';
    c.font = '15px ' + MONO;
    c.fillText(Math.round(v) + ' m/s', 12, 58);
    c.globalAlpha = 0.5;
    c.strokeStyle = hue; c.lineWidth = 1;
    c.strokeRect(12, 72, 232, 12);
    c.globalAlpha = 1;
    c.fillStyle = hue;
    c.fillRect(14, 74, 228 * Math.min(1, v / 450), 8);
    const mark = 12 + 232 * (55 / 450);
    c.fillStyle = '#4dff88';
    c.fillRect(mark - 1, 69, 2, 18);
    const rollDeg = sd.roll() * 180 / Math.PI;
    c.fillStyle = Math.abs(rollDeg) <= 2 ? '#4dff88' : '#ff7a5c';
    c.font = '12px ' + MONO;
    c.fillText('KALLISTUS ' + rollDeg.toFixed(1) + '°', 12, 108);
    c.fillStyle = hue;
    c.font = '10px ' + MONO;
    c.fillText('lasku ≤ 55 m/s · ≤ 2°', 12, 130);
  }
}

// oikea näyttö: aluksen resurssit — runko + happi mittarit ja varastot
function drawTgt(c, hue){
  scrHead(c, hue, S.mode === 'space' ? 'ALUS' : 'KOHDE');
  if (S.mode === 'space') {
    const hullCol = v => v > 0.5 ? '#4dff88' : v > 0.25 ? '#ffd24d' : '#ff5a4d';
    const oxyCol  = v => v > 0.5 ? '#5fd2ff' : v > 0.25 ? '#ffd24d' : '#ff5a4d';
    const drawRes = (label, val, y, col, stock, sLbl) => {
      c.fillStyle = '#d4dde6'; c.font = '13px ' + MONO;
      c.fillText(label, 12, y);
      c.fillStyle = col(val); c.font = '13px ' + MONO;
      c.fillText(Math.round(val * 100) + ' %', 198, y);
      c.globalAlpha = 0.5; c.strokeStyle = hue; c.lineWidth = 1;
      c.strokeRect(12, y + 8, 232, 13); c.globalAlpha = 1;
      c.fillStyle = col(val);
      c.fillRect(14, y + 10, 228 * Math.max(0, Math.min(1, val)), 9);
      c.fillStyle = hue; c.font = '11px ' + MONO;
      c.fillText(sLbl + ' ×' + stock, 12, y + 38);
    };
    drawRes('RUNKO', S.hull || 0,   60, hullCol, S.inv.paneeli || 0, 'paneeli');
    drawRes('HAPPI', S.oxygen || 0, 122, oxyCol,  S.inv.happi || 0,  'säiliö');
  } else {
    const sd = surfDebug();
    const v = sd.descentV();
    const rollDeg = Math.abs(sd.roll() * 180 / Math.PI);
    c.fillStyle = '#d4dde6';
    c.font = '12px ' + MONO;
    c.fillText((sd.body || '—') + ' · PINTA', 12, 50);
    c.font = '12px ' + MONO;
    c.fillStyle = v <= 55 ? '#4dff88' : '#ff7a5c';
    c.fillText('VAUHTI    ' + (v <= 55 ? 'OK' : 'LIIAN KOVA'), 12, 76);
    c.fillStyle = rollDeg <= 2 ? '#4dff88' : '#ff7a5c';
    c.fillText('KALLISTUS ' + (rollDeg <= 2 ? 'OK' : 'LIIKAA'), 12, 98);
    c.fillStyle = hue;
    c.font = '10px ' + MONO;
    c.fillText('W/S vauhti · A/D kallistus', 12, 120);
    c.fillText('B = takaisin avaruuteen', 12, 136);
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
// viistetyt kulmat: octagonin 8 kulmaa katkaistaan → 16-kulmainen poikkileikkaus
// (8 leveää sivua + 8 kapeaa viistepintaa), kavennettu päästä toiseen (rA→rB).
// t = viisteen osuus särmästä (0…0,5). UV-attribuutti (nollat) jotta mergeStatic
// yhdistää nämä CylinderGeometry-rimoihin samalla materiaalilla.
function octaStrutGeo(rA, rB, len, t){
  const N = 16, hy = len / 2, corner = [];
  for (let k = 0; k < 8; k++){ const a = k * Math.PI / 4 + Math.PI / 8; corner.push([Math.cos(a), Math.sin(a)]); }
  const cs = [];
  for (let k = 0; k < 8; k++){
    const P = corner[k], Pm = corner[(k + 7) % 8], Pp = corner[(k + 1) % 8];
    cs.push([P[0] + (Pm[0] - P[0]) * t, P[1] + (Pm[1] - P[1]) * t]);
    cs.push([P[0] + (Pp[0] - P[0]) * t, P[1] + (Pp[1] - P[1]) * t]);
  }
  const pos = [], idx = [];
  for (const [x, z] of cs) pos.push(x * rA, -hy, z * rA);
  for (const [x, z] of cs) pos.push(x * rB,  hy, z * rB);
  for (let i = 0; i < N; i++){ const a = i, b = (i + 1) % N; idx.push(a, b, N + b, a, N + b, N + i); }
  const cB = pos.length / 3; pos.push(0, -hy, 0); for (let i = 0; i < N; i++) idx.push(cB, (i + 1) % N, i);
  const cT = pos.length / 3; pos.push(0,  hy, 0); for (let i = 0; i < N; i++) idx.push(cT, N + i, N + (i + 1) % N);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _bm = new THREE.Matrix4();
function bar(parent, mat, a, b, r, r2 = r, flat = 1, nrm = null, bevel = 0){
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  // 8-kulmainen prisma; r (a-pää) → r2 (b-pää) kaventaa kärkeä, flat litistää.
  // bevel > 0 → octagonin kulmat viistetään (octaStrutGeo)
  const geo = bevel > 0 ? octaStrutGeo(r, r2, len, bevel)
                        : new THREE.CylinderGeometry(r2, r, len, 8, 1, false, Math.PI / 8);
  if (flat !== 1) geo.scale(1, 1, flat);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(va).addScaledVector(dir, 0.5);
  const y = _by.copy(dir).normalize();
  if (nrm) {
    // litistetty akseli (local z) pakotetaan rungon normaalin suuntaan, jotta
    // litteä sivu makaa runkoa vasten (ohut säteen suunnassa, leveä tangentissa)
    _bz.set(nrm[0], nrm[1], nrm[2]);
    _bz.addScaledVector(y, -_bz.dot(y));   // poista pituusakselin komponentti
    if (_bz.lengthSq() < 1e-8) _bz.set(1, 0, 0);
    _bz.normalize();
    _bx.crossVectors(y, _bz).normalize();
    _bz.crossVectors(_bx, y).normalize();
    m.quaternion.setFromRotationMatrix(_bm.makeBasis(_bx, y, _bz));
  } else {
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), y);
  }
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
// kuten box(), mutta viistetyt (pyöristetyt) särmät → ei teräviä 90° kulmia.
// r = viisteen säde (pieni, hieman pyöristää); r < min(w,h,d)/2.
function rbox(parent, mat, w, h, d, x, y, z, r = 0.04, rx = 0, ry = 0, rz = 0){
  const rr = Math.min(r, Math.min(w, h, d) * 0.48);
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, rr), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

/* kaareva näyttöpaneelin kehys: nauha, joka kiertää kaarta (keskus
   +z-puolella pelaajan suunnassa) — sitoo mittarinäytöt yhdeksi
   kojelaudaksi. Yläreuna kaareutuu samalla `arch`-käyrällä kuin näyttöjen
   yläreunat (huippu keskellä, laskee reunoja kohti); alareuna suora.
   bezelMat on DoubleSide, joten kiertosuunnalla ei väliä. */
function arcBezel(parent, mat, Cz, R, yC, halfH, a0, a1, arch, segs){
  const pos = [], uv = [];
  let prev = null;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const th = a0 + (a1 - a0) * t;
    const n = 2 * t - 1;   // -1..1 kaaren yli → sama (θ/a)² kuin näytöillä
    const cur = { x: R * Math.sin(th), z: Cz - R * Math.cos(th), top: yC + halfH - arch * n * n, u: t };
    if (prev) {
      const b0 = [prev.x, yC - halfH, prev.z], t0 = [prev.x, prev.top, prev.z];
      const b1 = [cur.x, yC - halfH, cur.z], t1 = [cur.x, cur.top, cur.z];
      pos.push(...b0, ...t0, ...t1, ...b0, ...t1, ...b1);
      uv.push(prev.u, 0, prev.u, 1, cur.u, 1, prev.u, 0, cur.u, 1, cur.u, 0);
    }
    prev = cur;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  parent.add(new THREE.Mesh(geo, mat));
}

/* yksittäisen näytön geometria (XY-taso, normaali +z): alareuna suora,
   YLÄREUNA kaareutuu kojelaudan kaaren mukaan — kukin näyttö kojelaudan eri
   kohdassa (thMid), joten jokaisen yläreuna on hieman erilainen (keskinäyttö
   symmetrinen, reunanäytöt viistottu ulospäin laskevaksi). Pystysarakkeet:
   UV venytetään niin että canvas-sisältö täyttää kaarevan yläreunan. */
function screenGeo(w, h, thMid, R, arch, aMax){
  const cols = 16, hw = w / 2, bottom = -h / 2;
  const top = x => { const n = (thMid + x / R) / aMax; return h / 2 - arch * n * n; };
  const pos = [], uv = [];
  for (let i = 0; i < cols; i++) {
    const x0 = -hw + w * i / cols, x1 = -hw + w * (i + 1) / cols;
    const t0 = top(x0), t1 = top(x1);
    pos.push(x0, bottom, 0, x1, bottom, 0, x1, t1, 0,
             x0, bottom, 0, x1, t1, 0, x0, t0, 0);
    const u0 = (x0 + hw) / w, u1 = (x1 + hw) / w;
    uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
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
  // avaruusaluksen kehikko sinisävyiseksi (yhtenäinen sinisen kojelaudan kanssa);
  // sukkula säilyttää lämpimän/neutraalin metallisävynsä
  const blue = !opts.shuttle;
  const frameMat = new THREE.MeshStandardMaterial({ color: blue ? 0x1f2f4a : 0x383c42, roughness: blue ? 0.5 : 0.55, metalness: blue ? 0.45 : 0.7, flatShading: true });
  applyPH(frameMat, 'metal_plate_02', blue ? [0.26, 0.55, 2.15] : [1.1, 1.3, 1.65], [2, 1]);
  const darkMat = new THREE.MeshStandardMaterial({ color: blue ? 0x1a2230 : 0x202329, roughness: 0.75, metalness: 0.4 });
  applyPH(darkMat, 'metal_plate_02', blue ? [0.5, 0.72, 1.3] : [0.65, 0.75, 0.95], [1, 1]);
  const floorMat = new THREE.MeshStandardMaterial({ color: blue ? 0x20242c : 0x26282c, roughness: 0.8, metalness: 0.45 });
  applyPH(floorMat, 'metal_plate', blue ? [1.3, 1.5, 1.95] : [1.7, 1.7, 1.75], [3, 3]);   // kyynelpeltilattia
  const panelT = makePanelTex();
  const wallMat = new THREE.MeshStandardMaterial({
    map: panelT, color: blue ? 0x53709f : 0xffffff, roughness: 0.92, metalness: 0.12, side: THREE.DoubleSide,
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
  const pipeMat = new THREE.MeshStandardMaterial({ color: blue ? 0x25364f : 0x4c5056, roughness: blue ? 0.48 : 0.45, metalness: blue ? 0.5 : 0.8, flatShading: true });
  applyPH(pipeMat, 'metal_plate_02', blue ? [0.26, 0.55, 2.1] : [0.95, 1.1, 1.4], [1, 2]);
  // kaarevan näyttöpaneelin taustakehys (DoubleSide → sisäpinta näkyy pelaajalle)
  const bezelMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.7, metalness: 0.5, side: THREE.DoubleSide });
  applyPH(bezelMat, 'metal_plate_02', [0.7, 0.78, 0.95], [3, 1]);

  /* putkirunko: 8 fasettia takarenkaasta keularenkaaseen.
     Sivufasetteihin (i 3 = vasen, i 7 = oikea) upotetaan pieni ikkuna. */
  for (let i = 0; i < 8; i++) {
    const win = !opts.shuttle && (i === 3 || i === 7);   // sukkulalla ei sivuikkunoita
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
    // putken rivat reunoja pitkin → ohuet, keulaa (kauinta kärkeä) kohti
    // suippenevat ja litistetyt rimat (avaruusalus); litteä sivu runkoa vasten
    const ea = ringP(RING_REAR, i), eb = ringP(RING_FRONT, i);
    bar(g, pipeMat, ea, eb, blue ? 0.026 : 0.045, blue ? 0.008 : 0.045, blue ? 0.5 : 1,
        blue ? [ea[0] + eb[0], ea[1] + eb[1], 0] : null);
  }

  /* lasikupu: 8 reunapaneelia keularenkaasta sisärenkaaseen + keskioktagoni.
     Tukipuut säteilevät renkaiden kulmista — falcon-kanopia */
  for (let i = 0; i < 8; i++) {
    quad(g, glassMat, ringP(RING_FRONT, i), ringP(RING_INNER, i), ringP(RING_INNER, i + 1), ringP(RING_FRONT, i + 1));
    bar(g, frameMat, ringP(RING_FRONT, i), ringP(RING_FRONT, i + 1), blue ? 0.034 : 0.055);  // keularengas (ikkunan ulkokehys)
    if (!opts.shuttle) {   // sukkulalla yksi iso ikkuna ilman tukipuita
      // säteittäiset tukipuut: sisärengasta (kärkeä) kohti suippenevat, litistetyt,
      // litteä sivu kupua vasten (rungon normaali), kulmat hieman viistetty
      const ra = ringP(RING_FRONT, i), rb = ringP(RING_INNER, i);
      bar(g, frameMat, ra, rb, 0.034, 0.016, 0.6, [ra[0] + rb[0], ra[1] + rb[1], 0], 0.16);
      bar(g, frameMat, ringP(RING_INNER, i), ringP(RING_INNER, i + 1), 0.024); // sisärengas
    }
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
  // avaruusaluksella kojelaudan pinta = sama sininen runkotekstuuri kuin
  // tukipuissa (PNG peittää sen, mutta alalaidassa pilkottava kaista sulautuu);
  // sukkulalla säilyy nappikonsoli (consoleMat)
  const deckMat = blue ? frameMat : consoleMat;
  for (const sg of segs) {
    const b = box(dash, [darkMat, darkMat, deckMat, darkMat, darkMat, darkMat],
      sg.w, 0.09, 0.55, sg.x, dashY, sg.z, tilt, sg.ry, 0);
    // etulevy konsolista lattiaan
    box(dash, darkMat, sg.w, 0.52, 0.07, sg.x * 1.13, dashY - 0.28, sg.z - 0.18 + Math.abs(sg.x) * 0.16, 0, sg.ry, 0);
    b.userData.ry = sg.ry;
  }
  // elävät mittarinäytöt (sijainti / nopeus / kohde) integroituina yhteen
  // kaarevaan näyttöpaneeliin — kolme ruutua kiertävät jaettua kaarta ja
  // yhtenäinen kaareva taustakehys sitoo ne yhdeksi kojelaudaksi. Nopeus ja
  // kohde himmeämmällä emissiolla ettei teksti heku bloomissa.
  const makeLiveScreen = (kind, intensity, matte) => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 192;
    const emissiveMap = new THREE.CanvasTexture(cv);
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.anisotropy = 8;
    _live.push({ kind, ctx: cv.getContext('2d'), tex: emissiveMap, hue: opts.screenCss, group: g });
    const p = { color: 0x000000, emissive: 0xffffff, emissiveMap, emissiveIntensity: intensity };
    // matte = ei spekulaariheijastusta (Lambert ilman kiiltoa), muuten kiiltävä Standard
    return matte ? new THREE.MeshLambertMaterial(p)
                 : new THREE.MeshStandardMaterial({ ...p, roughness: 0.3 });
  };
  // sukkulalla kallistuksen näyttö (keinohorisontti = 'pos'/ASENTO) keskelle
  const SCR = opts.shuttle
    ? [['spd', 0.72], ['pos', 0.95], ['tgt', 0.72]]
    : [['pos', 0.95], ['spd', 0.72], ['tgt', 0.72]];
  // sukkulalla loiva leveä panoraama; komentosillalla pienemmät ruudut
  // (vähemmän peittoa) ylempänä että kaikki tieto näkyy. Jokaisen näytön
  // yläreuna mukailee kojelaudan kaarta (arch), reunanäytöt viistottu.
  const ARC = opts.shuttle
    ? { R: 3.0, angs: [-0.135, 0, 0.135], a: 0.24, tilt: -0.24, w: 0.40, h: 0.30, y: 0.17, arch: 0.05 }
    : { R: 1.45, angs: [-0.265, 0, 0.265], a: 0.40, tilt: -0.26, w: 0.32, h: 0.215, y: 0.19, arch: 0.05 };
  if (opts.shuttle) {
    // laskeutumissukkula: kaareva panoraamapaneeli (ennallaan)
    const scrY = dashY + ARC.y;
    const arcCz = dashZ + ARC.R;
    // tumma metallikonsoli näyttöjen takana aivan kiinni (gap ~1 cm) → ruudut
    // upotettuina, eivät kellu. Reunus jää näyttöjen ympärille kehykseksi.
    arcBezel(dash, bezelMat, arcCz, ARC.R + 0.022, scrY, ARC.h / 2 + 0.012, -ARC.a, ARC.a, ARC.arch, 26);
    for (let i = 0; i < 3; i++) {
      const th = ARC.angs[i];
      const holder = new THREE.Group();
      holder.position.set(ARC.R * Math.sin(th), scrY, arcCz - ARC.R * Math.cos(th));
      holder.rotation.set(ARC.tilt, -th, 0);
      dash.add(holder);
      const sc = new THREE.Mesh(screenGeo(ARC.w, ARC.h, th, ARC.R, ARC.arch, ARC.a), makeLiveScreen(SCR[i][0], SCR[i][1]));
      sc.position.z = 0.012;
      holder.add(sc);
    }
  } else {
    // avaruusalus: kojelauta = valmis bittikartta (assets/kojelauta.png),
    // jonka näyttöaukkojen päälle ladotaan elävät näytöt 4-kulmaisina
    // paneeleina (reunanäytöt ovat perspektiivissä = puolisuunnikkaita).
    const IW = 3298, IH = 930;            // png-tekstuurin pikselikoko
    const PW = 1.18, PH = PW * IH / IW;   // paneelin koko (kuvasuhde säilyy)
    const panelY = dashY + 0.19, panelZ = dashZ, ptilt = -0.52;
    const dashTex = new THREE.TextureLoader().load('assets/kojelauta.png');
    dashTex.colorSpace = THREE.SRGBColorSpace; dashTex.anisotropy = 8;
    const panelMat = new THREE.MeshStandardMaterial({
      map: dashTex, emissiveMap: dashTex, emissive: 0xffffff, emissiveIntensity: 0.9,
      transparent: false, alphaTest: 0.5, roughness: 0.6, metalness: 0.3,
    });
    const panelG = new THREE.Group();
    panelG.position.set(0, panelY, panelZ);
    panelG.rotation.x = ptilt;
    dash.add(panelG);
    panelG.add(new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), panelMat));
    g.userData.dashCrop = { panelG, PH };   // näkymän alarajausta varten
    // png-pikseli → paneelin paikalliskoordinaatti
    const P = (x, y, z) => [(x / IW - 0.5) * PW, (0.5 - y / IH) * PH, z];
    // havaitut näyttöaukkojen kulmat (png-pikseleinä): vasen=pos, keski=spd, oikea=tgt
    const SCRN = [
      { c: { tl: [444, 184], tr: [1178, 117], br: [1155, 681], bl: [371, 753] }, kind: 'pos', int: 0.95 },
      { c: { tl: [1339, 99], tr: [2000, 108], br: [2014, 658], bl: [1328, 661] }, kind: 'spd', int: 0.72 },
      { c: { tl: [2161, 117], tr: [2870, 189], br: [2918, 739], bl: [2186, 679] }, kind: 'tgt', int: 0.72 },
    ];
    for (const s of SCRN) {
      const z = 0.012, c = s.c;
      let q = [P(...c.tl, z), P(...c.tr, z), P(...c.br, z), P(...c.bl, z)];
      // 98 % koko: kutista kukin näyttö hieman kohti omaa keskipistettään
      const mx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
      const my = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      q = q.map(p => [mx + (p[0] - mx) * 0.98, my + (p[1] - my) * 0.98, p[2]]);
      const [tl, tr, br, bl] = q;
      const geo = new THREE.BufferGeometry();
      // CCW edestä (+Z) → etupinta pelaajaa kohti
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...tl, ...br, ...tr, ...tl, ...bl, ...br], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0], 2));
      geo.computeVertexNormals();
      panelG.add(new THREE.Mesh(geo, makeLiveScreen(s.kind, s.int, s.kind === 'spd')));
    }
  }
  blinker(dash, 0xffb340, -0.30, dashY + 0.06, dashZ + 0.20, 0.9, 0.4);
  blinker(dash, 0xff5340, 0.30, dashY + 0.06, dashZ + 0.20, 1.7, 1.3);

  /* keskipedestaali kaasukahvoineen */
  box(g, [darkMat, darkMat, deckMat, darkMat, darkMat, darkMat], 0.40, 0.32, 0.5, 0, -0.80, -0.30, -0.12);
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
  // moottorihehku: sammuksissa musta, väri ajetaan vauhdista updateCockpitissa
  const glowMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  glowMat.color.setRGB(0, 0, 0);
  falconGlow = glowMat;

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

  // moottoriosa: lautasen takakaarta myötäilevä kaareva kotelo, jonka
  // sisällä hehkunauha kiertää peräkaaren (sulautuu runkoon saumatta)
  const ENG_ARC = 1.6;
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(2.68, 2.68, 0.46, 22, 1, true, -ENG_ARC / 2, ENG_ARC), darkMat);
  g.add(housing);
  const housingTrim = new THREE.Mesh(
    new THREE.CylinderGeometry(2.72, 2.72, 0.2, 22, 1, true, -ENG_ARC / 2 + 0.06, ENG_ARC - 0.12), hullMat);
  g.add(housingTrim);
  const glowBand = new THREE.Mesh(
    new THREE.CylinderGeometry(2.74, 2.74, 0.18, 22, 1, true, -ENG_ARC * 0.42, ENG_ARC * 0.84), glowMat);
  g.add(glowBand);

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
  g.position.set(0, -1.3, -4.6);   // alempana → katse takaviistosta ylhäältä
  g.visible = false;
  camera.add(g);
  return g;
}

/* Sukkulan runkopinta: kulunut, likainen valkoinen MAALATTU METALLI (ei
   metallilevykuviota eikä laattaruudukkoa). Maalipohja, laaja-alainen
   likamottling, alasvaluvat likajuovat, muutama EPÄSÄÄNNÖLLINEN paneelisauma
   niitteineen, naarmut (paljastunut metalli kiiltää → matalampi rosoisuus) ja
   nokituhrut. Bump-kartta korostaa saumaurat/niitit; rosoisuuskartta tekee
   naarmuista kiiltäviä ja likaläiskistä mattoja → realistinen kuluneisuus.
   UV-toisto 0,42 → kuvio kattaa ~2,4 yks → ei silmiinpistävää toistoa. */
let _shuttleHullTex = null;
function makeShuttleHullTex(){
  if (_shuttleHullTex) return _shuttleHullTex;
  const SZ = 512;
  const al = document.createElement('canvas'); al.width = al.height = SZ;
  const bp = document.createElement('canvas'); bp.width = bp.height = SZ;
  const ro = document.createElement('canvas'); ro.width = ro.height = SZ;
  const c = al.getContext('2d'), b = bp.getContext('2d'), q = ro.getContext('2d');
  const r = rng(91);
  c.fillStyle = '#e9eae6'; c.fillRect(0, 0, SZ, SZ);          // hieman kellastunut valkoinen maali
  b.fillStyle = '#808080'; b.fillRect(0, 0, SZ, SZ);
  q.fillStyle = '#8c8c8c'; q.fillRect(0, 0, SZ, SZ);          // perusrosoisuus ~0,55 (maalattu metalli)

  // laaja-alainen likamottling: pehmeät harmaanruskeat läiskät (+ mattapintaisemmaksi)
  for (let i = 0; i < 26; i++) {
    const x = r() * SZ, y = r() * SZ, rad = 40 + r() * 120, a = 0.04 + r() * 0.07;
    let g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(122,114,99,${a.toFixed(2)})`); g.addColorStop(1, 'rgba(122,114,99,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
    g = q.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(200,200,200,${(a * 2).toFixed(2)})`); g.addColorStop(1, 'rgba(200,200,200,0)');
    q.fillStyle = g; q.beginPath(); q.arc(x, y, rad, 0, 7); q.fill();
  }
  // pystysuuntaiset likajuovat (valuvat alas) — "likainen" tuntu
  for (let i = 0; i < 60; i++) {
    const x = r() * SZ, y0 = r() * SZ * 0.6, len = 40 + r() * 200, w = 1 + r() * 2.5, a = 0.05 + r() * 0.12;
    const g = c.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, 'rgba(94,88,78,0)'); g.addColorStop(0.3, `rgba(94,88,78,${a.toFixed(2)})`); g.addColorStop(1, 'rgba(94,88,78,0)');
    c.fillStyle = g; c.fillRect(x, y0, w, len);
  }
  // paneelisaumat: muutama EPÄSÄÄNNÖLLINEN viiva (ei ruudukkoa) + valoreuna + bump-ura
  const seams = [];
  const seam = (x0, y0, x1, y1) => {
    c.strokeStyle = 'rgba(70,72,70,0.5)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x0 + 1.5, y0 + 1.5); c.lineTo(x1 + 1.5, y1 + 1.5); c.stroke();
    b.strokeStyle = '#4a4a4a'; b.lineWidth = 2.5;
    b.beginPath(); b.moveTo(x0, y0); b.lineTo(x1, y1); b.stroke();
    seams.push([x0, y0, x1, y1]);
  };
  seam(0, 150, SZ, 150 + (r() - 0.5) * 26);
  seam(0, 332, SZ, 332 + (r() - 0.5) * 26);
  seam(124, 0, 124 + (r() - 0.5) * 18, SZ);
  seam(372, 0, 372 + (r() - 0.5) * 18, SZ);
  // niitit saumojen varteen
  b.fillStyle = '#9a9a9a'; c.fillStyle = 'rgba(80,82,80,0.35)';
  for (const [x0, y0, x1, y1] of seams) {
    const n = Math.hypot(x1 - x0, y1 - y0) / 22 | 0;
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      b.beginPath(); b.arc(x, y, 1.5, 0, 7); b.fill();
      c.beginPath(); c.arc(x, y, 1.2, 0, 7); c.fill();
    }
  }
  // naarmut: ohuet vaaleat/tummat viivat; paljas metalli kiiltää → rosoisuus matalampi
  for (let i = 0; i < 70; i++) {
    const x = r() * SZ, y = r() * SZ, a2 = r() * 6.28, len = 4 + r() * 22;
    const dx = Math.cos(a2) * len, dy = Math.sin(a2) * len;
    c.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(70,68,64,0.18)'; c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + dx, y + dy); c.stroke();
    q.strokeStyle = 'rgba(45,45,45,0.5)'; q.lineWidth = 0.8;
    q.beginPath(); q.moveTo(x, y); q.lineTo(x + dx, y + dy); q.stroke();
  }
  // pienet noki-/likatuhrut
  for (let i = 0; i < 40; i++) {
    const x = r() * SZ, y = r() * SZ, rad = 2 + r() * 9;
    c.fillStyle = `rgba(58,54,48,${(0.05 + r() * 0.1).toFixed(2)})`;
    c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
  }
  const t1 = tex(al), t2 = tex(bp, false), t3 = tex(ro, false);
  for (const t of [t1, t2, t3]) t.repeat.set(0.42, 0.42);
  _shuttleHullTex = { map: t1, bump: t2, rough: t3 };
  return _shuttleHullTex;
}

/* neutraali ympäristökartta sukkulan heijastuksiin: pystygradientti
   (vaalea "taivas" → tumma "maa") PMREM:nä. Toimii kaikissa tiloissa
   (avaruus/Kuu/Mars) ilman scenekohtaista kytkentää; antaa valkoiselle
   rungolle ja lasille hienovaraiset valonheijastukset. */
let _shuttleEnv = null;
function shuttleEnvMap(){
  if (_shuttleEnv) return _shuttleEnv;
  const cv = document.createElement('canvas'); cv.width = 16; cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0.00, '#454b54'); g.addColorStop(0.46, '#23262b');
  g.addColorStop(0.54, '#16181c'); g.addColorStop(1.00, '#0a0b0c');
  c.fillStyle = g; c.fillRect(0, 0, 16, 64);
  const t = new THREE.CanvasTexture(cv);
  t.mapping = THREE.EquirectangularReflectionMapping;
  const pg = new THREE.PMREMGenerator(renderer);
  const rt = pg.fromEquirectangular(t);
  t.dispose(); pg.dispose();
  _shuttleEnv = rt.texture;
  return _shuttleEnv;
}

/* Star Trek -henkinen sukkula: virtaviivainen runko viistetystä
   poikkileikkauksesta (8 pistettä × 5 sektiota — kapenee keulaan ja
   perään), kulunut likainen valkoinen metallipinta ja punainen vyötäisraita,
   oktagonikonehtimot kiskomaisin laskujalaksin.
   makeShuttleModel rakentaa tuoreen mallin omine resursseineen —
   pinnalle pysäköity kopio saa tuhoutua scenen mukana */
function makeShuttleModel(withBlinkers = true){
  const g = new THREE.Group();
  const hull = makeShuttleHullTex();
  const env = shuttleEnvMap();
  // kulunut, likainen valkoinen maalattu metalli: metallinen pinta (heijastaa
  // ympäristöä), rosoisuuskartta tekee naarmuista kiiltäviä ja liasta mattoja
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: hull.map, bumpMap: hull.bump, bumpScale: 0.45,
    roughnessMap: hull.rough, roughness: 1.0, metalness: 0.55, side: THREE.DoubleSide,
    envMap: env, envMapIntensity: 0.55,
  });
  const nacMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: hull.map, bumpMap: hull.bump, bumpScale: 0.4,
    roughnessMap: hull.rough, roughness: 1.0, metalness: 0.55, flatShading: true,
    envMap: env, envMapIntensity: 0.55,
  });
  // Korvaa proseduraalipinta REALISTISELLA Poly Haven -valokuvatekstuurilla
  // (`painted_plaster_wall` = kulunut vaalea maalipinta, CC0 — ei kuvioita/uria
  // kuten metallilevyissä/-sälekaihtimissa) heti kun se latautuu; canvas-
  // proseduraali jää offline-varalle. Vaalennetaan tintillä (setRGB > 1) →
  // kulunut VALKOINEN maalattu pinta; materiaalin metalness antaa metallikiillon.
  // diff korvaa bumpin (kuvassa jo kuluneisuus), nor_gl antaa pinnan reliefin.
  const applyRealHull = (mat, rep) => {
    loadPH('painted_plaster_wall', 'diff', true).then(t => { if (!t) return;
      const c = t.clone(); c.needsUpdate = true; c.repeat.set(rep, rep);
      mat.map = c; mat.bumpMap = null; mat.color.setRGB(1.3, 1.3, 1.33); mat.metalness = 0.4; mat.needsUpdate = true; });
    loadPH('painted_plaster_wall', 'nor_gl', false).then(t => { if (!t) return;
      const c = t.clone(); c.needsUpdate = true; c.repeat.set(rep, rep);
      mat.normalMap = c; mat.normalScale = new THREE.Vector2(0.4, 0.4); mat.needsUpdate = true; });
    loadPH('painted_plaster_wall', 'rough', false).then(t => { if (!t) return;
      const c = t.clone(); c.needsUpdate = true; c.repeat.set(rep, rep);
      mat.roughnessMap = c; mat.needsUpdate = true; });
  };
  applyRealHull(hullMat, 0.45);
  applyRealHull(nacMat, 0.6);

  // map: subtleTex() → ei tasaista yksiväristä pintaa (hienovarainen gradientti/laikutus)
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x34383f, map: subtleTex(), roughness: 0.6, metalness: 0.5, flatShading: true, envMap: env, envMapIntensity: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1118, roughness: 0.12, metalness: 0.85, side: THREE.DoubleSide, envMap: env, envMapIntensity: 1.0 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xbe2222, map: subtleTex(), roughness: 0.45, metalness: 0.1 });
  const redGlow = new THREE.MeshBasicMaterial();
  redGlow.color.setRGB(1.15, 0.35, 0.25);
  const blueGlow = new THREE.MeshBasicMaterial();
  blueGlow.color.setRGB(0.5, 0.9, 1.2);
  // RCS-ohjaussuutin: pieni tumma suppilo (käytetään perässä ja keulassa)
  const rcs = (x, y, z) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.02, 0.05, 8), darkMat); m.position.set(x, y, z); m.rotation.x = Math.PI / 2; g.add(m); };

  // PERÄN omat REALISTISET bittikarttatekstuurit (3 eri Poly Haven CC0 -tekstuuria,
  // eri elementeille → mekaaninen yksityiskohtaisuus erottuu sileästä maalipinnasta):
  const applyTex = (mat, slug, rep, tint) => {
    loadPH(slug, 'diff', true).then(t => { if (!t) return;
      const c = t.clone(); c.needsUpdate = true; c.repeat.set(rep, rep); mat.map = c;
      if (tint) mat.color.setRGB(tint[0], tint[1], tint[2]); mat.needsUpdate = true; });
    loadPH(slug, 'nor_gl', false).then(t => { if (!t) return;
      const c = t.clone(); c.needsUpdate = true; c.repeat.set(rep, rep); mat.normalMap = c; mat.needsUpdate = true; });
  };
  // (subtleTex on alkukartta → ei yksiväristä pintaa ennen valokuvan latausta)
  // 1) peräkotelo: niitattu metallilevy (moottori-/laitemoduuli)
  const aftHousingMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, map: subtleTex(), roughness: 0.6, metalness: 0.6, envMap: env, envMapIntensity: 0.5 });
  applyTex(aftHousingMat, 'metal_plate_02', 1.0, [1.18, 1.22, 1.28]);
  // 2) kiinnityslaippa + sivupaneelit: aaltopelti (vahvike/ritilä)
  const aftFrameMat = new THREE.MeshStandardMaterial({ color: 0x6a6e72, map: subtleTex(), roughness: 0.72, metalness: 0.5, flatShading: true, envMap: env, envMapIntensity: 0.4 });
  applyTex(aftFrameMat, 'corrugated_iron_03', 1.0, [0.92, 0.94, 0.98]);
  // 3) suuttimet: karkea ruoste/noki (kuumentunut pakoputki)
  const aftNozzleMat = new THREE.MeshStandardMaterial({ color: 0x6a625a, map: subtleTex(), roughness: 0.75, metalness: 0.55, flatShading: true, envMap: env, envMapIntensity: 0.35 });
  applyTex(aftNozzleMat, 'rust_coarse_01', 1.6, [0.72, 0.66, 0.6]);

  // runko: viistetty poikkileikkaus pyyhkäistynä sektioiden läpi
  const CS = [[-0.78, 0.66], [0.78, 0.66], [1.05, 0.38], [1.05, -0.42],
              [0.74, -0.66], [-0.74, -0.66], [-1.05, -0.42], [-1.05, 0.38]];
  const SEC = [
    { z: 2.35, sx: 0.86, sy: 0.84, y: 0.02 },
    { z: 0.60, sx: 1.00, sy: 1.00, y: 0.04 },
    { z: -1.30, sx: 0.96, sy: 0.94, y: 0.00 },
    { z: -2.20, sx: 0.84, sy: 0.70, y: -0.10 },
    { z: -2.95, sx: 0.56, sy: 0.36, y: -0.28 },
  ];
  const sp = (si, ci) => {
    const s = SEC[si], p = CS[ci % 8];
    return [p[0] * s.sx, p[1] * s.sy + s.y, s.z];
  };
  for (let si = 0; si < SEC.length - 1; si++)
    for (let ci = 0; ci < 8; ci++)
      quad(g, hullMat, sp(si, ci), sp(si, ci + 1), sp(si + 1, ci + 1), sp(si + 1, ci));
  // perä- ja keulakannet
  for (const [si, flip] of [[0, false], [SEC.length - 1, true]]) {
    const s = SEC[si];
    const sh = new THREE.Shape(CS.map(p => new THREE.Vector2(p[0] * s.sx, p[1] * s.sy + s.y)));
    const capM = new THREE.Mesh(new THREE.ShapeGeometry(sh), hullMat);
    capM.position.z = s.z;
    if (flip) capM.rotation.y = Math.PI;
    g.add(capM);
  }

  // punainen vaakaraita kiertää koko rungon (sivut + kannet)
  const stp = (si) => { const s = SEC[si]; return [1.065 * s.sx, 0.10 * s.sy + s.y, s.z]; };
  for (const side of [-1, 1])
    for (let si = 0; si < SEC.length - 1; si++) {
      const a = stp(si), b = stp(si + 1);
      bar(g, stripeMat, [side * a[0], a[1], a[2]], [side * b[0], b[1], b[2]], 0.034);
    }
  const sf = stp(SEC.length - 1), sr = stp(0);
  bar(g, stripeMat, [-sf[0], sf[1], sf[2] - 0.015], [sf[0], sf[1], sf[2] - 0.015], 0.034);
  bar(g, stripeMat, [-sr[0], sr[1], sr[2] + 0.015], [sr[0], sr[1], sr[2] + 0.015], 0.034);

  // tuulilasi keulan viistoon yläpintaan + puitteet
  const wt = (si, ci) => {
    const p = sp(si, ci);
    return [p[0] * 0.88, p[1] + 0.015, p[2]];
  };
  quad(g, glassMat, wt(3, 0), wt(3, 1), wt(4, 1), wt(4, 0));
  bar(g, darkMat, wt(3, 0), wt(3, 1), 0.03);
  bar(g, darkMat, wt(4, 0), wt(4, 1), 0.03);
  bar(g, darkMat, wt(3, 0), wt(4, 0), 0.03);
  bar(g, darkMat, wt(3, 1), wt(4, 1), 0.03);
  // (pystysuora keskituki poistettu — yksi yhtenäinen tuulilasi)

  // ---- PERÄ: hieman ulkoneva moottori-/laitemoduuli yksityiskohtineen ----
  // (runko päättyy z = 2,35; moduuli porrastuu siitä taaksepäin → ulkonema)
  // tumma kiinnityslaippa (AALTOPELTI-tekstuuri), hieman runkoa leveämpi → porras näkyy
  rbox(g, aftFrameMat, 1.64, 1.18, 0.10, 0, -0.02, 2.40, 0.02);
  // ulkoneva kotelo (NIITATTU METALLILEVY -tekstuuri), kapeampi kuin runko, viistetyt särmät
  rbox(g, aftHousingMat, 1.46, 0.96, 0.42, 0, -0.02, 2.62, 0.03);   // z 2,41 → 2,83
  // huoltoluukku varoitusraidoin moduulin takapinnassa (canvas-tekstuuri)
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.72), new THREE.MeshStandardMaterial({
    map: makeDoorTex(), roughness: 0.8, metalness: 0.25 }));
  door.position.set(0, 0.02, 2.835); g.add(door);             // taso osoittaa +z (taakse)
  // impulssipalkki (hehku) moduulin yläreunaan
  box(g, redGlow, 0.98, 0.07, 0.04, 0, 0.5, 2.84);
  // kaksi päämoottorin suutinta (RUOSTE/NOKI-tekstuuri) moduulin alaosaan (+z)
  for (const s of [-1, 1]) {
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.12, 0.34, 12), aftNozzleMat);
    noz.rotation.x = Math.PI / 2; noz.position.set(s * 0.38, -0.34, 2.9); g.add(noz);
  }
  // pienet yksityiskohdat: louver-tuuletusritilä, kulmasuuttimet, kahvat, putket
  for (let i = 0; i < 3; i++) box(g, darkMat, 0.5, 0.025, 0.03, -0.32, 0.32 - i * 0.1, 2.835);  // tuuletusritilä luukun vasemmalla
  for (const s of [-1, 1]) {
    rbox(g, aftFrameMat, 0.05, 0.78, 0.36, s * 0.7, -0.02, 2.6, 0.01);   // sivupaneeli (aaltopelti)
    rcs(s * 0.55, 0.5, 2.84);                                   // RCS-suutin yläkulmassa (peruutus)
    box(g, darkMat, 0.04, 0.04, 0.4, s * 0.55, -0.02, 2.62);    // kylkiputki/johdin
    rbox(g, hullMat, 0.16, 0.1, 0.06, s * 0.42, 0.34, 2.84, 0.012); // kohopaneeli/kahva luukun yllä
  }
  box(g, darkMat, 0.3, 0.12, 0.05, 0, -0.5, 2.84);              // alalaipan greeble keskellä

  // konehtimot: valkoiset oktagoniprismat, tummat kärkikartiot ja
  // bussard-hehkut; alla viistetyt kiskomaiset laskujalakset
  for (const s of [-1, 1]) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 2.9, 8, 1, false, Math.PI / 8), nacMat);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(s * 1.36, -0.76, 0.45);
    g.add(nac);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.24, 0.4, 8, 1, false, Math.PI / 8), darkMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(s * 1.36, -0.76, -1.2);
    g.add(cone);
    const buss = new THREE.Mesh(new THREE.CircleGeometry(0.085, 8), redGlow);
    buss.position.set(s * 1.36, -0.76, -1.41);
    buss.rotation.y = Math.PI;
    g.add(buss);
    box(g, blueGlow, 0.04, 0.07, 1.7, s * 1.605, -0.76, 0.45);
    // pyloni rungosta konehtimon kanteen
    box(g, hullMat, 0.13, 0.5, 0.85, s * 1.16, -0.5, 0.45, 0, 0, s * 0.5);
    // jalaskisko: matala palkki + ylösviistetty kärki
    box(g, darkMat, 0.13, 0.07, 2.4, s * 1.36, -1.06, 0.55);
    box(g, darkMat, 0.13, 0.07, 0.5, s * 1.36, -0.99, -0.85, -0.42, 0, 0);
    if (withBlinkers) blinker(g, s < 0 ? 0xff5340 : 0x46d06a, s * 1.36, -0.48, 1.85, 1.3, s);
  }

  // kattodetaljit ja antenni (viistetyt särmät)
  rbox(g, hullMat, 0.7, 0.12, 1.2, 0, 0.74, 0.9, 0.02);
  rbox(g, darkMat, 0.32, 0.08, 0.5, 0.5, 0.72, 0.0, 0.015);
  bar(g, darkMat, [-0.55, 0.7, 1.8], [-0.55, 1.05, 1.8], 0.022);
  if (withBlinkers) blinker(g, 0xffb340, -0.55, 1.1, 1.8, 0.9, 0.5);

  // ---- yksityiskohdat: ohjaamon sivuikkunat, RCS-suuttimet, keulaputki ----
  // sivuikkunat: tummat lasiruudut etukabiinin kyljissä (kehys upotettuna)
  for (const s of [-1, 1])
    for (const wz of [-0.25, -0.85, -1.45]) {
      const wx = 0.96 - (wz < -1.0 ? 0.06 : 0);   // runko kapenee keulaa kohti
      box(g, darkMat, 0.03, 0.2, 0.3, s * (wx + 0.01), 0.04, wz);   // kehys
      box(g, glassMat, 0.02, 0.15, 0.24, s * (wx + 0.03), 0.04, wz);
    }
  // RCS-ohjaussuuttimet keulassa ja kyljissä (perän suuttimet lisätty perämoduulissa)
  for (const s of [-1, 1]) { rcs(s * 0.34, 0.34, -2.78); rcs(s * 0.5, -0.2, -2.74); rcs(s * 1.0, 0.0, 1.9); }
  rcs(0, 0.5, -2.7); rcs(0, -0.45, -2.5);
  // keulan pitot-/anturiputki rungon kärjessä
  bar(g, darkMat, [0, -0.06, -2.95], [0, -0.04, -3.28], 0.03, 0.008);
  // pari kohotettua selkäpaneelia (greeble) lakatulla rungolla (viistetyt särmät)
  rbox(g, hullMat, 0.5, 0.05, 0.7, 0, 0.79, -0.4, 0.01);
  rbox(g, hullMat, 0.26, 0.04, 0.34, 0.32, 0.5, 1.55, 0.009);

  mergeStatic(g);
  return g;
}

function buildShuttle(){
  const g = makeShuttleModel(true);
  g.scale.setScalar(0.7);
  g.position.set(0, -1.5, -7.2);   // alempana → katse takaviistosta ylhäältä
  g.visible = false;
  camera.add(g);
  return g;
}

/* avaruusaluksen komentosilta: siniset näytöt (referenssin mukaan) */
const bridgeCockpit = buildCockpit({
  accent: 0x3fb8ff, accentCss: '#3fb8ff', screenCss: '#6cc8ff',
  seat: 0x4a3c30,
});
/* laskeutumisalus: lämmin meripihka-aksentti, erilainen kojelauta ja
   yksi iso ikkuna ilman tukipuita/sivuikkunoita */
const landerCockpit = buildCockpit({
  accent: 0xffb340, accentCss: '#ffb340', screenCss: '#ffc468',
  seat: 0x37404a, shuttle: true,
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

/* ---- pinnalle pysäköity sukkula ----
   Laskeuduttaessa pintascenen spawn-pisteen viereen pysäköidään sukkula;
   paluu kiertoradalle onnistuu vain sen vierestä (B). Malli rakennetaan
   tuoreena joka laskulle — leaveSurfaceScenen dispose saa tuhota sen. */
let shuttleSurf = null;
let _prevMode = S.mode;
export function nearParkedShuttle(){
  return !!(shuttleSurf && camera.position.distanceTo(shuttleSurf.position) < 10);
}
function parkShuttle(){
  const sd = surfDebug();
  if (!sd.scene) return;
  const m = makeShuttleModel(false);   // pysäköitynä valot sammuksissa
  m.scale.setScalar(1.3);
  // viistosti pelaajan vasempaan etukulmaan, nokka saapumissuuntaan
  const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
  const rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw);
  const px = sd.x + fx * 7.5 - rx * 4.5;
  const pz = sd.z + fz * 7.5 - rz * 4.5;
  // pinnan normaali korkeusfunktiosta (keskidifferenssi footprintin yli) →
  // sukkula kallistuu rinteen suuntaan eikä jää vaakatasoon
  const e = 3;
  const dhx = (sd.h(px + e, pz) - sd.h(px - e, pz)) / (2 * e);
  const dhz = (sd.h(px, pz + e) - sd.h(px, pz - e)) / (2 * e);
  const up = new THREE.Vector3(0, 1, 0);
  const N = new THREE.Vector3(-dhx, 1, -dhz).normalize();
  const qTilt = new THREE.Quaternion().setFromUnitVectors(up, N);
  const qYaw = new THREE.Quaternion().setFromAxisAngle(up, S.yaw + 0.45);
  m.quaternion.multiplyQuaternions(qTilt, qYaw);   // suuntaus ensin, sitten kallistus rinteeseen
  m.position.set(px, sd.h(px, pz) + 1.43, pz);     // jalakset maahan
  m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  sd.scene.add(m);
  shuttleSurf = m;
  S.shuttlePos = m.position.clone();   // kypäränäyttö lukee tästä (vältetään sirkulaarinen import)
}

/* etäisyyssovitus: lähellä planeetan pintaa (tai matalalennossa maata)
   ulkomalli vedetään lähemmäs kameraa ja kutistetaan samassa suhteessa —
   näennäiskoko ruudulla ei muutu (yhdenmuotoiset kolmiot), mutta mallin
   todellinen ulottuvuus pysyy vapaassa tilassa eikä leikkaa planeettaan
   (syvyystesti upottaisi aluksen pinnan sisään) */
const FALCON_POS = new THREE.Vector3(0, -1.3, -4.6), FALCON_SCALE = 0.5;
const SHUTTLE_POS = new THREE.Vector3(0, -1.5, -7.2), SHUTTLE_SCALE = 0.7;
let _extFit = 1;
function updateExtFit(){
  let target = 1;
  if (S.mode === 'space') {
    let dmin = Infinity;
    for (const b of bodies) {
      const d = camera.position.distanceTo(b.group.position) - b.def.r;
      if (d < dmin) dmin = d;
    }
    target = Math.min(1, Math.max(0.04, dmin * 0.09));
  } else {
    const sd = surfDebug();
    const alt = sd.descentPos.y - sd.h(sd.descentPos.x, sd.descentPos.z);
    target = Math.min(1, Math.max(0.12, alt * 0.06));
  }
  // kutistu heti pinnan lähestyessä (ei leikkaa planeettaan), kasva pehmeästi
  _extFit += (target - _extFit) * (target < _extFit ? 1.0 : 0.2);
  falconExt.position.copy(FALCON_POS).multiplyScalar(_extFit);
  falconExt.scale.setScalar(FALCON_SCALE * _extFit);
  shuttleExt.position.copy(SHUTTLE_POS).multiplyScalar(_extFit);
  shuttleExt.scale.setScalar(SHUTTLE_SCALE * _extFit);
}

/* ohjausmyötäily: ulkomalli pankkaa kaarrossa, kääntää nokkaa kaarron
   suuntaan ja nyökkää pystyohjauksessa — kulmanopeudet johdetaan
   yaw/pitch-muutoksista ja suodatetaan pehmeiksi */
let _pYaw = 0, _pPitch = 0, _swayX = 0, _swayY = 0, _swayZ = 0;
function updateSway(dt){
  let ry = S.yaw - _pYaw;
  if (ry > Math.PI) ry -= Math.PI * 2; else if (ry < -Math.PI) ry += Math.PI * 2;
  const rx = S.pitch - _pPitch;
  _pYaw = S.yaw; _pPitch = S.pitch;
  if (dt <= 0) return;
  // teleportit (pikasiirtymä, spawn) ohitetaan — vain aito ohjausliike
  const yawRate = Math.abs(ry) > 0.5 ? 0 : ry / dt;
  const pitchRate = Math.abs(rx) > 0.5 ? 0 : rx / dt;
  const k = 1 - Math.exp(-dt * 5);
  const cl = (v, m) => Math.max(-m, Math.min(m, v));
  _swayZ += (cl(yawRate * 0.40, 0.45) - _swayZ) * k;   // pankkaus kaartoon
  _swayY += (cl(yawRate * 0.15, 0.20) - _swayY) * k;   // nokka kaarron suuntaan
  _swayX += (cl(pitchRate * 0.22, 0.30) - _swayX) * k; // nyökkäys
  falconExt.rotation.set(_swayX, _swayY, _swayZ);
  shuttleExt.rotation.set(_swayX, _swayY, _swayZ);
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

// näkymän alareunan rajaus: musta letterbox-palkki, jonka yläreuna seuraa
// kojelaudan PNG:n alareunaa (projisoidaan paneelin alareuna ruudulle)
const _cropV = new THREE.Vector3();
let _cropEl = null;
function dashCropEl(){
  if (_cropEl) return _cropEl;
  _cropEl = document.createElement('div');
  _cropEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;background:#000;z-index:3;pointer-events:none;display:none;';
  document.body.appendChild(_cropEl);
  return _cropEl;
}

export function updateCockpit(dt = 0.016){
  // moodisiirtymät: pinnalle → pysäköi sukkula; pois pinnalta → scene
  // hävitti pysäköidyn mallin resursseineen, pudota viite
  if (S.mode !== _prevMode) {
    if (S.mode === 'surface') parkShuttle();
    else shuttleSurf = null;
    _prevMode = S.mode;
  }
  bridgeCockpit.visible = S.mode === 'space' && !extView;
  landerCockpit.visible = S.mode === 'descent' && !extView;
  falconExt.visible = S.mode === 'space' && extView;
  shuttleExt.visible = S.mode === 'descent' && extView;
  fillLight.visible = S.mode !== 'surface' && !extView;
  // rajaa näkymä kojelaudan alareunaan: musta palkki PNG:n alalipan alapuolelle
  const _crop = dashCropEl(), _dc = bridgeCockpit.userData.dashCrop;
  if (bridgeCockpit.visible && _dc) {
    camera.updateMatrixWorld();
    _dc.panelG.updateWorldMatrix(true, false);
    _cropV.set(0, -_dc.PH * 0.47, 0.02);          // PNG:n näkyvä alareuna paneelin lokaalikoordinaatistossa
    _dc.panelG.localToWorld(_cropV);
    _cropV.project(camera);
    const yPx = (1 - (_cropV.y * 0.5 + 0.5)) * window.innerHeight;
    _crop.style.display = 'block';
    _crop.style.height = Math.max(0, Math.round(window.innerHeight - yPx)) + 'px';
  } else if (_crop.style.display !== 'none') {
    _crop.style.display = 'none';
  }
  if (extView && S.mode !== 'surface') updateExtFit();
  updateSway(dt);
  // moottorihehku skaalautuu vauhdista: sammuksissa musta, kovassa vauhdissa
  // kirkas sininen (kanavat yli 1.0 → bloom syttyy ja voimistuu)
  if (falconGlow) {
    const lvl = Math.pow(Math.min(1, (S.effFrac || 0) / 0.6), 0.8);
    falconGlow.color.setRGB(lvl * 0.85, lvl * 1.3, lvl * 1.95);
  }
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
