/* ---------------- HUD ja nimilaput ---------------- */
import * as THREE from 'three';
import { AU, C, C_KMS, camera } from './core.js';
import { bodies } from './bodies.js';
import { ROCKY } from './surface.js';
import { LANDING_MAX_EFF } from './reentry.js';
import { S } from './state.js';

const el = (id) => document.getElementById(id);
const hud = {
  pct: el('speedPct'), kms: el('speedKms'), gamma: el('gamma'),
  bar: el('speedBar'),
  tName: el('targetName'), tDist: el('targetDist'), tEta: el('targetEta'),
};
const slider = el('speedSlider');
const _v2 = new THREE.Vector3();

function fmtTime(s){
  if (!isFinite(s)) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function updateSpaceHUD(){
  // FOV kasvaa nopeuden myötä
  const fov = 60 + 24 * Math.pow(S.effFrac, 3);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }

  // HUD — näytetään todellinen nopeus (lähialuetila huomioiden)
  hud.pct.textContent = (S.effFrac * 100).toFixed(S.effFrac < 0.105 ? 2 : 1);
  hud.kms.textContent = Math.round(S.effFrac * C_KMS).toLocaleString('fi-FI');
  hud.gamma.textContent = (1 / Math.sqrt(1 - S.effFrac * S.effFrac)).toFixed(2);
  hud.bar.style.width = `${(S.effFrac / 0.99) * 100}%`;
  const fd = document.getElementById('frameDrag');
  if (S.dragBody && S.dragWeight > 0.01) {
    fd.style.display = 'block';
    fd.textContent = `⊕ kehysseuranta: ${S.dragBody.def.name} ${Math.round(S.dragWeight * 100)} % · nopeusalue 1–10 % c`;
  } else {
    fd.style.display = 'none';
  }
  if (Math.abs(parseFloat(slider.value) - S.targetFrac) > 0.001) slider.value = S.targetFrac;

  const tgt = bodies[S.targetIdx];
  const distU = camera.position.distanceTo(tgt.group.position) - tgt.def.r;
  const distAU = distU / AU;
  hud.tName.textContent = tgt.def.name;
  hud.tDist.textContent = distAU >= 0.01
    ? `${distAU.toFixed(2)} AU (${Math.round(distAU * 149.6).toLocaleString('fi-FI')} milj. km)`
    : `${Math.max(0, Math.round(distU * 149600)).toLocaleString('fi-FI')} km`;
  const v = S.effFrac * C;
  hud.tEta.textContent = v > 0.5 ? fmtTime(distU / v) : '—';

  // laskeutumisnappi näkyviin kiviplaneetan kiertoradalla; vaatii hitaan vauhdin
  const distCenter = distU + tgt.def.r;
  const canBeam = ROCKY.has(tgt.def.name) && distCenter < tgt.def.r * 15;
  const btnBeam = document.getElementById('btnBeam');
  btnBeam.style.display = canBeam ? '' : 'none';
  if (canBeam) {
    const tooFast = S.effFrac > LANDING_MAX_EFF;
    btnBeam.disabled = tooFast;
    btnBeam.textContent = tooFast ? '⇓ hidasta laskeutuaksesi (alle 2 % c)' : '⇓ pinnalle · G';
  }

  // nimilaput
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    _v2.copy(b.group.position).project(camera);
    const onScreen = _v2.z < 1 && _v2.x > -1.05 && _v2.x < 1.05 && _v2.y > -1.05 && _v2.y < 1.05;
    const dist = camera.position.distanceTo(b.group.position);
    if (onScreen && dist > b.def.r * 4) {
      b.label.style.display = 'block';
      b.label.style.left = `${(_v2.x * 0.5 + 0.5) * window.innerWidth}px`;
      b.label.style.top  = `${(-_v2.y * 0.5 + 0.5) * window.innerHeight}px`;
      b.label.classList.toggle('target', i === S.targetIdx);
      const dAU = dist / AU;
      b.label.innerHTML = `<span class="dot">◦</span> ${b.def.name}` +
        (i === S.targetIdx ? ` · ${dAU.toFixed(2)} AU` : '');
    } else {
      b.label.style.display = 'none';
    }
  }
}
