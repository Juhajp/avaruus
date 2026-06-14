/* ---------------- Avaruuslennon fysiikka (FPV) ---------------- */
import * as THREE from 'three';
import { AU, C, DEG, camera } from './core.js';
import { bodies } from './bodies.js';
import { S, clampThrottle } from './state.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const _vX = new THREE.Vector3(1, 0, 0);

export function updateFlight(dt){
  // nopeuden säätö näppäimillä (tavoitenopeus voi mennä negatiiviseksi → peruutus)
  const rate = (S.keys.ShiftLeft || S.keys.ShiftRight) ? 1.2 : 0.30;
  if (S.keys.KeyW || S.keys.ArrowUp)   S.targetFrac = clampThrottle(S.targetFrac + rate * dt);
  if (S.keys.KeyS || S.keys.ArrowDown) S.targetFrac = clampThrottle(S.targetFrac - rate * dt);
  if (S.keys.KeyQ) S.roll += 1.4 * dt;
  if (S.keys.KeyE) S.roll -= 1.4 * dt;
  // Liikemäärämalli (Newtonin inertia): targetFrac on KAASUVIPU (työntö), EI
  // tavoitenopeus. Vipu keskellä (0) = ei työntöä → alus jatkaa vauhdillaan
  // (coast, ei jarruta). Eteen = kiihdytys, taakse = jarrutus/peruutustyöntö.
  // speedFrac (todellinen nopeus) integroituu työnnöstä, rajataan
  // [-0.05, 0.99]:een. Siksi täsmälleen nopeuteen 0 pysähtyminen on vaikeaa:
  // työntö on nollattava juuri oikealla hetkellä, muuten ylittää nollan.
  // Nopeusmittari näyttää speedFracin (todellisen), kaasumerkki targetFracin.
  const lever = S.targetFrac;
  const DEAD = 0.004;
  let thrust = 0;
  if (lever > DEAD)       thrust = lever;           // eteen 0..1 (täysi kaasu 1.0 = täysi työntö)
  else if (lever < -DEAD) thrust = lever / 0.05;    // taakse 0..-1 (täysi -0.05 → -1)
  // inertia vahvempi lähellä planeettaa: kiihtyvyys laskee kehysseurannan painon
  // mukaan (kaukana 0.14/s → pinnan tuntumassa ~0.07/s). Lähivyöhykkeen
  // nopeuskartoitus puristaa jo itsessään ~10× (0.99→0.10 c), joten kerroin
  // pidetään maltillisena ettei ohjaus jähmety
  const ACCEL = 0.14 * (1 - 0.5 * S.dragWeight);
  // easing kohti nollaa: kun työntö JARRUTTAA (vastakkainen nopeudelle), pehmennä
  // sitä nopeuden lähestyessä nollaa → sulava pysähtyminen, ei nykäystä nollassa
  const braking = thrust !== 0 && Math.sign(thrust) === -Math.sign(S.speedFrac);
  let ease = 1;
  if (braking) {
    const x = Math.min(1, Math.abs(S.speedFrac) / 0.04);
    // pehmennys nollan lähellä, mutta ei jähmety nollaan (alaraja 0.35) ettei
    // pysähdys veny asymptoottiseksi mateluksi
    ease = 0.35 + 0.65 * (x * x * (3 - 2 * x));
  }
  let nv = S.speedFrac + thrust * ACCEL * ease * dt;
  // jarruttaessa asetu täsmälleen nollaan (ei ylitystä; easingin asymptootti
  // katkaistaan, jotta peruutus voi sitten alkaa nollasta)
  if (braking && (Math.abs(nv) < 0.0015 || Math.sign(nv) !== Math.sign(S.speedFrac))) nv = 0;
  S.speedFrac = Math.max(-0.05, Math.min(0.99, nv));

  // käänny kohti kohdetta (F)
  if (S.keys.KeyF) {
    _m.lookAt(camera.position, bodies[S.targetIdx].group.position, UP);
    _q.setFromRotationMatrix(_m);
    camera.quaternion.slerp(_q, 1 - Math.exp(-dt * 4));
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    S.yaw = e.y; S.pitch = e.x; S.roll = e.z;
  }

  camera.rotation.set(S.pitch, S.yaw, S.roll, 'YXZ');

  // liike — vyöhykkeen sisällä paikallinen nopeustila: säädin kattaa 0–0.1 c
  const vGlobal = S.speedFrac;
  const aLocal = Math.abs(S.speedFrac);
  // jatkuva kartoitus 0→0.10 c (ei 1 % c lattiaa) → effFrac liukuu pehmeästi
  // nollaan jarruttaessa lähellä planeettaa, ei äkkipysähdystä
  const vLocal = Math.sign(S.speedFrac) * 0.10 * (aLocal / 0.99);
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
