/* ---------------- Ohjaus: hiiri, näppäimet, UI-napit ---------------- */
import { renderer } from './core.js';
import { bodies, orbitLines } from './bodies.js';
import { quickTravel, tryBeamDown, exitSurface, abortDescent, aimingAtShuttle } from './surface.js';
import { toggleShipView, nearParkedShuttle } from './cockpit.js';
import {
  toggleCraft, craftRecipe, isCraftOpen, setMining, toggleWeapon, toggleSniperMode, lookSensitivityMul,
  togglePlasmaMeterTool, handlePlasmaMeterToolKey, setPlasmaMeterToolPointFromScreen, isPlasmaMeterToolActive,
} from './mining.js';
import { useItem } from './resources.js';
import { S, clampThrottle } from './state.js';

let lockFailed = false;
let dragging = false;
let lastMX = 0, lastMY = 0;

function setHint(msg){ document.getElementById('hint').textContent = msg; }
function onLockFailed(){
  if (lockFailed) return;
  lockFailed = true;
  setHint('Hiirilukko ei käytettävissä — käännä katsetta vetämällä hiirellä (nappi pohjassa)');
}
function tryPointerLock(){
  if (lockFailed) return;
  try {
    const p = renderer.domElement.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch(onLockFailed);
  } catch (err) { onLockFailed(); }
}
document.addEventListener('pointerlockerror', onLockFailed);

const overlay = document.getElementById('startOverlay');
overlay.addEventListener('click', () => {
  overlay.style.display = 'none';   // peli alkaa Marsin pinnalta (main.js), pelkkä piilotus
  tryPointerLock();
});

renderer.domElement.addEventListener('click', () => {
  if (overlay.style.display === 'none' && !isPlasmaMeterToolActive()) tryPointerLock();
});

// ohjeruutu (H) — klikkaus sulkee
const helpOverlay = document.getElementById('helpOverlay');
helpOverlay.addEventListener('click', () => { helpOverlay.style.display = 'none'; });

function isUiPointerTarget(e){
  const el = e.target;
  return !!(el && el !== renderer.domElement && el.closest
    && el.closest('button,input,select,textarea,#startOverlay,#helpOverlay,#deathOverlay,#craftPanel'));
}

// varajärjestelmä: katselu hiirellä vetämällä, jos hiirilukkoa ei saada.
// Kuunnellaan ikkunatasolla, koska pointer lockin aikana hiiritapahtuman target
// ei ole kaikissa selaimissa enää itse canvas.
addEventListener('mousedown', (e) => {
  if (isUiPointerTarget(e)) return;
  if (e.button === 0) {
    if (S.mode === 'surface' && isPlasmaMeterToolActive()) {
      if (setPlasmaMeterToolPointFromScreen(e.clientX, e.clientY)) {
        e.preventDefault();
        return;
      }
    }
    dragging = true; lastMX = e.clientX; lastMY = e.clientY;
    if (S.mode === 'surface') setMining(true);   // pinnalla vasen = louhi (tähtää esiintymään)
  } else if (e.button === 2 && S.mode === 'surface') {
    toggleSniperMode();
    e.preventDefault();
  }
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mouseup', () => { dragging = false; setMining(false); });
addEventListener('blur', () => { dragging = false; setMining(false); });

// Katseen päivitys: yaw aina sama, pitch käännetään lennossa (avaruusalus/sukkula)
// lentosimulaattorin tapaan — liike ylös → nokka alas. Kävelyssä (surface) normaali.
function applyLook(dx, dy){
  const pitchSign = (S.mode === 'surface') ? -1 : 1;
  const sens = 0.0021 * lookSensitivityMul();
  S.yaw   -= dx * sens;
  S.pitch += pitchSign * dy * sens;
  S.pitch = Math.max(-1.553, Math.min(1.553, S.pitch));
}

document.addEventListener('mousemove', (e) => {
  const locked = document.pointerLockElement === renderer.domElement;
  let dx, dy;
  if (locked) {
    dx = e.movementX; dy = e.movementY;
  } else if (dragging) {
    // movementX/Y ei ole luotettava ilman lukkoa kaikissa selaimissa
    dx = e.clientX - lastMX; dy = e.clientY - lastMY;
    lastMX = e.clientX; lastMY = e.clientY;
  } else {
    return;
  }
  applyLook(dx, dy);
});
addEventListener('wheel', (e) => {
  // hiirellä hieno säätö: 1 askel = 1 % (pyöristys kokonaisprosenttiin)
  const step = -Math.sign(e.deltaY) * 0.01;
  S.targetFrac = clampThrottle(Math.round((S.targetFrac + step) * 100) / 100);
}, { passive: true });

/* ---------------- Mobiiliohjaus (kosketus) ----------------
   Yksi sormi = katselu (kuten hiiren veto). Kaksi sormea: pystysuunta =
   kaasu (ylös kiihdyttää, alas hidastaa), kierto = kallistus (roll). */
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
if (IS_TOUCH) {
  document.body.classList.add('touch');
  setHint('Mobiili: 1 sormi = katsele · 2 sormea ylös/alas = kaasu · 2 sormea pyörittäen = kallistus');
}

let touchLookActive = false;       // yhden sormen katselu käynnissä
let touchLX = 0, touchLY = 0;
let twoFingerY = null;             // kahden sormen pystykeskiö (kaasusäätö)
let twoFingerAng = null;           // kahden sormen välinen kulma (roll-säätö)

function avgY(touches){
  let s = 0; for (const t of touches) s += t.clientY; return s / touches.length;
}
function twoAng(touches){
  return Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
}

const canvas = renderer.domElement;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length >= 2) {
    // kaksi sormea = kaasu + kallistus; ei katselua/louhintaa
    twoFingerY = avgY(e.touches);
    twoFingerAng = twoAng(e.touches);
    touchLookActive = false;
    setMining(false);
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    touchLookActive = true;
    touchLX = t.clientX; touchLY = t.clientY;
    twoFingerY = null; twoFingerAng = null;
    if (S.mode === 'surface') setMining(true);   // pinnalla sormi pohjassa = louhi (tähtää esiintymään)
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length >= 2) {
    const y = avgY(e.touches);
    if (twoFingerY !== null) {
      const dy = y - twoFingerY;                 // ylös = negatiivinen → kiihdytä
      S.targetFrac = clampThrottle(S.targetFrac - dy * 0.003);
    }
    twoFingerY = y;
    const ang = twoAng(e.touches);
    if (twoFingerAng !== null) {
      let dA = ang - twoFingerAng;               // kierto → kallistus (roll)
      if (dA > Math.PI) dA -= 2 * Math.PI; else if (dA < -Math.PI) dA += 2 * Math.PI;
      S.roll -= dA;
    }
    twoFingerAng = ang;
  } else if (e.touches.length === 1 && touchLookActive) {
    const t = e.touches[0];
    const dx = t.clientX - touchLX, dy = t.clientY - touchLY;
    touchLX = t.clientX; touchLY = t.clientY;
    applyLook(dx, dy);
  }
  e.preventDefault();
}, { passive: false });

function endTouch(e){
  if (e.touches.length === 0) {
    touchLookActive = false; twoFingerY = null; twoFingerAng = null; setMining(false);
  } else if (e.touches.length === 1) {
    // kahdesta yhteen sormeen — vaihda katseluun, nollaa perustaso ettei nykäise
    const t = e.touches[0];
    touchLookActive = true;
    touchLX = t.clientX; touchLY = t.clientY;
    twoFingerY = null; twoFingerAng = null;
    if (S.mode === 'surface') setMining(true);
  }
}
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

addEventListener('keydown', (e) => {
  S.keys[e.code] = true;
  if (S.mode === 'surface' && e.code === 'Space') e.preventDefault();
  if (S.mode === 'surface' && e.code === 'KeyP') {
    if (togglePlasmaMeterTool()) { S.keys[e.code] = false; e.preventDefault(); return; }
  }
  if (handlePlasmaMeterToolKey(e)) { S.keys[e.code] = false; e.preventDefault(); return; }
  // jalostus: C avaa/sulkee paneelin, numerot jalostavat kun paneeli auki
  if (e.code === 'KeyC') { toggleCraft(); return; }
  if (isCraftOpen() && /^Digit[1-9]$/.test(e.code)) { craftRecipe(parseInt(e.code.slice(5), 10) - 1); return; }
  // käytä jalostustuote: J = happisäiliö → happi, K = runkopaneeli → runko (toimii kaikissa tiloissa)
  if (e.code === 'KeyJ') { useItem('happi'); return; }
  if (e.code === 'KeyK') { useItem('paneeli'); return; }
  if (e.code === 'KeyX') {
    if (e.repeat) return;
    if (S.mode === 'surface') { toggleWeapon(); return; }
    S.targetFrac = 0;
  }
  if (e.code === 'KeyM') S.targetFrac = 1.0;   // täysi työntö
  if (e.code === 'KeyO') orbitLines.visible = !orbitLines.visible;
  if (e.code === 'KeyV') toggleShipView();
  if (e.code === 'KeyH') {
    const help = document.getElementById('helpOverlay');
    help.style.display = help.style.display === 'flex' ? 'none' : 'flex';
  }
  if (S.mode === 'space') {
    if (e.code === 'KeyR') quickTravel();
    if (e.code === 'KeyG') tryBeamDown();
    if (/^Digit[0-9]$/.test(e.code)) setTarget(parseInt(e.code.slice(5), 10));   // 9 = Kuu
  } else {
    if (e.code === 'KeyB') {
      if (S.mode === 'descent') abortDescent();
      else if (nearParkedShuttle() || aimingAtShuttle()) exitSurface();   // paluu sukkulan vierestä tai sitä osoittaen
    }
  }
});
addEventListener('keyup', (e) => { S.keys[e.code] = false; });

const slider = document.getElementById('speedSlider');
slider.addEventListener('input', () => { S.targetFrac = parseFloat(slider.value); });

/* kohdenapit */
const bodyBar = document.getElementById('bodyBar');
const bodyBtns = [];
bodies.forEach((b, i) => {
  const btn = document.createElement('button');
  btn.textContent = `${i} ${b.def.name}`;
  btn.addEventListener('click', () => setTarget(i));
  bodyBar.appendChild(btn);
  bodyBtns.push(btn);
});
export function setTarget(i){
  S.targetIdx = i;
  bodyBtns.forEach((b, j) => b.classList.toggle('active', j === i));
}
setTarget(S.targetIdx);

document.getElementById('btnOrbit').addEventListener('click', quickTravel);
document.getElementById('btnBeam').addEventListener('click', tryBeamDown);
