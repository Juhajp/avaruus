/* ---------------- Pääsilmukka ja käynnistys ---------------- */
import * as THREE from 'three';
import { camera, composer, renderer, renderPass, scene } from './core.js';
import { shaderMats } from './shaders.js';
import { bodies, placeNearBody, updateBodies } from './bodies.js';
import { updateWarp } from './warp.js';
import { updateReentry, reentryDebug } from './reentry.js';
import { updateSurface, updateDescent, checkDescentEntry, tryBeamDown, exitSurface, surfDebug } from './surface.js';
import { updateFlight } from './flight.js';
import { updateCockpit } from './cockpit.js';
import { updateResources } from './resources.js';
import { updateSpaceHUD } from './hud.js';
import { setTarget } from './input.js';
import { S, clampSpeed } from './state.js';

// aloituspaikka: Marsin lähellä — varsinainen pintalasku tehdään 1. ruudulla
// (tryBeamDown tarvitsee b.group.positionin, jonka vasta updateBodies asettaa)
placeNearBody(4);

const clock = new THREE.Clock();
let started = false;   // peli alkaa Marsin pinnalta, lasku 1. ruudulla

function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!S.paused) {
    S.simTime += dt;
    updateBodies(dt);
    if (!started) {
      // kohdista Mars ja laskeudu kun radan paikka (b.group.position) on tiedossa
      started = true;
      setTarget(4);
      placeNearBody(4, 6);
      tryBeamDown();
    }
    if (S.mode === 'surface') updateSurface(dt);
    else if (S.mode === 'descent') updateDescent(dt);
  }

  if (!S.paused && S.mode === 'space') {
    updateFlight(dt);
    updateReentry(dt);
    checkDescentEntry();
    updateWarp(dt);
  }

  // shaderien uniformit
  for (const m of shaderMats) m.uniforms.uTime.value = S.simTime;

  updateCockpit(dt);
  updateResources(dt);   // happi kuluu + runkovaurio kaikissa tiloissa

  if (S.mode === 'space') updateSpaceHUD();

  composer.render();

  // ensimmäinen ruutu renderöity — piilota aloitus-/latausruutu automaattisesti
  if (!window.__simReady) {
    window.__simReady = true;
    const ov = document.getElementById('startOverlay');
    if (ov) ov.style.display = 'none';
  }
}
animate();

// testikoukku kehitystä varten
window.__sim = {
  goto(idx, distMult = 3.5){ placeNearBody(idx, distMult); },
  setSpeed(f){ S.targetFrac = clampSpeed(f); S.speedFrac = S.targetFrac; },
  state(){ return { simTime: S.simTime, speedFrac: S.speedFrac, mode: S.mode, pos: camera.position.toArray() }; },
  beam(i){ S.targetFrac = 0; S.speedFrac = 0; setTarget(i); placeNearBody(i, 6); tryBeamDown(); },
  beamUp(){ exitSurface(); },
  surf(){ return surfDebug(); },
  reentry(){ return reentryDebug(); },
  res(){ return { hull: S.hull, oxygen: S.oxygen, hullHeat: S.hullHeat }; },
  setHull(v){ S.hull = Math.max(0, Math.min(1, v)); },
  setOxygen(v){ S.oxygen = Math.max(0, Math.min(1, v)); },
  pause(){   // P-näppäin poistettu — tauko vain testikoukkuna
    S.paused = !S.paused;
    document.getElementById('pausedTag').style.display = S.paused ? 'block' : 'none';
    return S.paused;
  },
  camera, bodies, THREE, renderPass, renderer, scene,
};
