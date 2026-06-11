/* ---------------- Pääsilmukka ja käynnistys ---------------- */
import * as THREE from 'three';
import { camera, composer, renderer, renderPass, scene } from './core.js';
import { shaderMats } from './shaders.js';
import { bodies, placeNearBody, updateBodies } from './bodies.js';
import { updateWarp } from './warp.js';
import { updateReentry, reentryDebug } from './reentry.js';
import { updateSurface, updateDescent, checkDescentEntry, tryBeamDown, exitSurface, surfDebug } from './surface.js';
import { updateFlight } from './flight.js';
import { updateSpaceHUD } from './hud.js';
import { setTarget } from './input.js';
import { S, clamp01 } from './state.js';

// aloituspaikka: Maan lähellä, katse kohti Maata
placeNearBody(3);

const clock = new THREE.Clock();

function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!S.paused) {
    S.simTime += dt;
    updateBodies(dt);
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

  if (S.mode === 'space') updateSpaceHUD();

  composer.render();

  // ensimmäinen ruutu renderöity — vapauta aloitusruutu
  if (!window.__simReady) {
    window.__simReady = true;
    document.getElementById('bootStatus').textContent = '▶ Klikkaa aloittaaksesi';
  }
}
animate();

// testikoukku kehitystä varten
window.__sim = {
  goto(idx, distMult = 3.5){ placeNearBody(idx, distMult); },
  setSpeed(f){ S.targetFrac = clamp01(f); S.speedFrac = S.targetFrac; },
  state(){ return { simTime: S.simTime, speedFrac: S.speedFrac, mode: S.mode, pos: camera.position.toArray() }; },
  beam(i){ S.targetFrac = 0; S.speedFrac = 0; setTarget(i); placeNearBody(i, 6); tryBeamDown(); },
  beamUp(){ exitSurface(); },
  surf(){ return surfDebug(); },
  reentry(){ return reentryDebug(); },
  pause(){   // P-näppäin poistettu — tauko vain testikoukkuna
    S.paused = !S.paused;
    document.getElementById('pausedTag').style.display = S.paused ? 'block' : 'none';
    return S.paused;
  },
  camera, bodies, THREE, renderPass, renderer, scene,
};
