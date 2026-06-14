/* ---------------- Avaruuslennon fysiikka (FPV) ---------------- */
import * as THREE from 'three';
import { AU, C, DEG, camera } from './core.js';
import { bodies } from './bodies.js';
import { S, clampSpeed } from './state.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const _vX = new THREE.Vector3(1, 0, 0);

export function updateFlight(dt){
  // nopeuden säätö näppäimillä (tavoitenopeus voi mennä negatiiviseksi → peruutus)
  const rate = (S.keys.ShiftLeft || S.keys.ShiftRight) ? 1.2 : 0.30;
  if (S.keys.KeyW || S.keys.ArrowUp)   S.targetFrac = clampSpeed(S.targetFrac + rate * dt);
  if (S.keys.KeyS || S.keys.ArrowDown) S.targetFrac = clampSpeed(S.targetFrac - rate * dt);
  if (S.keys.KeyQ) S.roll += 1.4 * dt;
  if (S.keys.KeyE) S.roll -= 1.4 * dt;
  // inertia: nopeus liukuu tavoitteeseen. Kiihdytys vastaa ripeämmin kuin
  // hidastus/coast, joten vauhdin pudottaminen tai nollaan tulo tuntuu massalta.
  const k = (Math.abs(S.targetFrac) > Math.abs(S.speedFrac)) ? 2.5 : 1.1;
  S.speedFrac += (S.targetFrac - S.speedFrac) * (1 - Math.exp(-dt * k));
  if (Math.abs(S.speedFrac - S.targetFrac) < 0.0004) S.speedFrac = S.targetFrac;

  // käänny kohti kohdetta (F)
  if (S.keys.KeyF) {
    _m.lookAt(camera.position, bodies[S.targetIdx].group.position, UP);
    _q.setFromRotationMatrix(_m);
    camera.quaternion.slerp(_q, 1 - Math.exp(-dt * 4));
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    S.yaw = e.y; S.pitch = e.x; S.roll = e.z;
  }

  camera.rotation.set(S.pitch, S.yaw, S.roll, 'YXZ');

  // liike — vyöhykkeen sisällä paikallinen nopeustila: säädin kattaa 0.01–0.1 c
  const vGlobal = S.speedFrac;
  const aLocal = Math.abs(S.speedFrac);
  const vLocal = aLocal > 0.001 ? Math.sign(S.speedFrac) * (0.01 + 0.09 * (aLocal / 0.99)) : 0;
  S.effFrac = vGlobal * (1 - S.dragWeight) + vLocal * S.dragWeight;
  const fwd = _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(fwd, S.effFrac * C * dt);

  // kehysseuranta: lähellä planeettaa kamera kulkee sen mukana,
  // jotta kappaleen vierellä voi leijua sen karkaamatta radallaan
  S.dragBody = null; S.dragWeight = 0;
  for (const b of bodies) {
    if (b.def.a === 0) continue;
    const d = camera.position.distanceTo(b.group.position);
    const near = b.def.r * 8, far = b.def.r * 15;
    if (d < far) {
      const w = d < near ? 1 : 1 - (d - near) / (far - near);
      const ang = b.def.phase + b.angVel * S.simTime;
      const sp = b.def.a * AU * b.angVel;
      _v2.set(-Math.sin(ang) * sp, 0, Math.cos(ang) * sp);
      if (b.def.incl) _v2.applyAxisAngle(_vX, b.def.incl * DEG);
      camera.position.addScaledVector(_v2, w * dt);
      if (w > S.dragWeight) { S.dragWeight = w; S.dragBody = b; }
    }
  }

  // törmäyssuoja: ei planeetan sisään — liu'utaan pintaa pitkin
  for (const b of bodies) {
    const minD = b.def.r * 1.15;
    _v2.subVectors(camera.position, b.group.position);
    const d = _v2.length();
    if (d < minD) {
      camera.position.copy(b.group.position).addScaledVector(_v2.normalize(), minD);
    }
  }
}
