/* ---------------- Ohjaus: hiiri, näppäimet, UI-napit ---------------- */
import { renderer } from './core.js';
import { bodies, orbitLines, placeNearBody } from './bodies.js';
import { quickTravel, tryBeamDown, exitSurface, abortDescent } from './surface.js';
import { toggleShipView, nearParkedShuttle } from './cockpit.js';
import { S, clamp01 } from './state.js';

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
  if (e.button === 0) { dragging = true; lastMX = e.clientX; lastMY = e.clientY; }
});
addEventListener('mouseup', () => { dragging = false; });
addEventListener('blur', () => { dragging = false; });

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
  S.yaw   -= dx * 0.0021;
  S.pitch -= dy * 0.0021;
  S.pitch = Math.max(-1.553, Math.min(1.553, S.pitch));
});
addEventListener('wheel', (e) => {
  S.targetFrac = clamp01(S.targetFrac - Math.sign(e.deltaY) * 0.02);
}, { passive: true });

addEventListener('keydown', (e) => {
  S.keys[e.code] = true;
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
