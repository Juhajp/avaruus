/* ---------------- Ohjaus: hiiri, näppäimet, UI-napit ---------------- */
import { renderer } from './core.js';
import { bodies, orbitLines, placeNearBody } from './bodies.js';
import { quickTravel, tryBeamDown, exitSurface, abortDescent } from './surface.js';
import { toggleShipView, nearParkedShuttle } from './cockpit.js';
import { toggleCraft, craftRecipe, isCraftOpen, setMining } from './mining.js';
import { S, clampSpeed } from './state.js';

let started = false;
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
  overlay.style.display = 'none';
  if (!started) { started = true; placeNearBody(3); }
  tryPointerLock();
});

renderer.domElement.addEventListener('click', () => {
  if (overlay.style.display === 'none') tryPointerLock();
});

// varajärjestelmä: katselu hiirellä vetämällä, jos hiirilukkoa ei saada
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    dragging = true; lastMX = e.clientX; lastMY = e.clientY;
    if (S.mode === 'surface') setMining(true);   // pinnalla vasen = louhi (tähtää esiintymään)
  }
});
addEventListener('mouseup', () => { dragging = false; setMining(false); });
addEventListener('blur', () => { dragging = false; setMining(false); });

// Katseen päivitys: yaw aina sama, pitch käännetään lennossa (avaruusalus/sukkula)
// lentosimulaattorin tapaan — liike ylös → nokka alas. Kävelyssä (surface) normaali.
function applyLook(dx, dy){
  const pitchSign = (S.mode === 'surface') ? -1 : 1;
  S.yaw   -= dx * 0.0021;
  S.pitch += pitchSign * dy * 0.0021;
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
  S.targetFrac = clampSpeed(S.targetFrac - Math.sign(e.deltaY) * 0.02);
}, { passive: true });

/* ---------------- Mobiiliohjaus (kosketus) ----------------
   Yksi sormi = katselu (kuten hiiren veto). Kaksi sormea pystysuunnassa =
   kaasu: ylös kiihdyttää, alas hidastaa. */
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
if (IS_TOUCH) {
  document.body.classList.add('touch');
  setHint('Mobiili: 1 sormi = katsele · 2 sormea ylös/alas = kaasu · napit alhaalla');
}

let touchLookActive = false;       // yhden sormen katselu käynnissä
let touchLX = 0, touchLY = 0;
let twoFingerY = null;             // kahden sormen pystykeskiö (kaasusäätö)

function avgY(touches){
  let s = 0; for (const t of touches) s += t.clientY; return s / touches.length;
}

const canvas = renderer.domElement;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length >= 2) {
    // kaksi sormea = kaasu; ei katselua/louhintaa
    twoFingerY = avgY(e.touches);
    touchLookActive = false;
    setMining(false);
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    touchLookActive = true;
    touchLX = t.clientX; touchLY = t.clientY;
    twoFingerY = null;
    if (S.mode === 'surface') setMining(true);   // pinnalla sormi pohjassa = louhi (tähtää esiintymään)
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length >= 2) {
    const y = avgY(e.touches);
    if (twoFingerY !== null) {
      const dy = y - twoFingerY;                 // ylös = negatiivinen → kiihdytä
      S.targetFrac = clampSpeed(S.targetFrac - dy * 0.003);
    }
    twoFingerY = y;
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
    touchLookActive = false; twoFingerY = null; setMining(false);
  } else if (e.touches.length === 1) {
    // kahdesta yhteen sormeen — vaihda katseluun, nollaa perustaso ettei nykäise
    const t = e.touches[0];
    touchLookActive = true;
    touchLX = t.clientX; touchLY = t.clientY;
    twoFingerY = null;
    if (S.mode === 'surface') setMining(true);
  }
}
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

addEventListener('keydown', (e) => {
  S.keys[e.code] = true;
  // jalostus: C avaa/sulkee paneelin, numerot jalostavat kun paneeli auki
  if (e.code === 'KeyC') { toggleCraft(); return; }
  if (isCraftOpen() && /^Digit[1-9]$/.test(e.code)) { craftRecipe(parseInt(e.code.slice(5), 10) - 1); return; }
  if (e.code === 'KeyX') S.targetFrac = 0;
  if (e.code === 'KeyM') S.targetFrac = 0.99;
  if (e.code === 'KeyO') orbitLines.visible = !orbitLines.visible;
  if (e.code === 'KeyV') toggleShipView();
  if (e.code === 'KeyH') {
    overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
  }
  if (S.mode === 'space') {
    if (e.code === 'KeyR') quickTravel();
    if (e.code === 'KeyG') tryBeamDown();
    if (/^Digit[0-8]$/.test(e.code)) setTarget(parseInt(e.code.slice(5), 10));
  } else {
    if (e.code === 'KeyB') {
      if (S.mode === 'descent') abortDescent();
      else if (nearParkedShuttle()) exitSurface();   // paluu vain sukkulan vierestä
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
