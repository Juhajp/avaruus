/* ---------------- Vihollinen: Hiekkagolem (Sand Golem) ----------------
   Humanoidi hiekasta muodostuva golem. Erillinen entiteetti/luokka (jokainen
   vihollistyyppi oma tiedostonsa, vrt. regolithWorm.js).

   Rakenne: nivelhierarkia (lonkka, polvi, hartia, kyynärpää, niska) Object3D-
   ryhminä → realistinen kävely ja iskuanimaatio. Nivelet eivät näy (pelkkiä
   transformeja); raajat ovat kapseleita, nivelkohdissa pallot peittävät saumat.
   Kasvoton pää; suu (tumma onkalo) aukeaa vain iskiessä.

   Käytös: nousee HITAASTI maasta → kävelee pelaajaa kohti → lähietäisyydellä
   lyö käsiswingillä (osuma = raskas vahinko). Osuma-alueet: pää, vartalo ja 4
   raajaa. Raajaan 3–4 osumaa → raaja irtoaa (lentää + hiekkapurske) ja kasvaa
   hitaasti takaisin. Osumasta rungon nytkähdys (recoil). Jos jalka irtoaa →
   kaatuu, nousee kun jalka on kasvanut takaisin.

   Vahingoitettavissa hakulla TAI aseella (meshien userData.enemy + .part).
   API (yhtenäinen surface.js-kytkennän kanssa): update(dt,px,pz,camera),
   takeDamage(amount, hit), get tremor(), reset(), dispose(). */
import * as THREE from 'three';
import { toonMat, addOutlines } from './toon.js';

// mittasuhteet (yksiköt)
const TH = 0.8, SH = 0.8;            // reisi, sääri
const TORSO = 1.0;                    // vartalon korkeus
const UA = 0.72, FA = 0.7;           // olkavarsi, kyynärvarsi
const HEADR = 0.4;                   // pään säde
const HIPX = 0.27, SHX = 0.46;       // lonkka- ja hartialeveys (puolikas)
const PELVIS_Y = TH + SH;            // lantio jalkojen päällä (jalat 0-tasolla)
const TORSO_TOP = PELVIS_Y + TORSO;

const HP_MAX = 20;                   // kokonaiskestävyys (pää/vartalo-osumat tappavat lopulta)
const BITE_DMG = 0.3;                // iskun vahinko pelaajaan
const ATTACK_RANGE = 2.8;            // tällä etäisyydellä lyö
const SIGHT = 60;                    // havaitsee/jäljittää tällä etäisyydellä
const SPEED = 2.6;                   // kävelynopeus (m/s)
const EMERGE_T = 3.2, DEAD_T = 1.8, RESPAWN_T = 16;
const REGROW_T = 9;                  // raajan takaisinkasvu

const _wp = new THREE.Vector3();

function jitter(geo, amt){
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (Math.random() - 0.5) * amt, p.getY(i) + (Math.random() - 0.5) * amt, p.getZ(i) + (Math.random() - 0.5) * amt);
  p.needsUpdate = true; geo.computeVertexNormals();
}

export class SandGolem {
  constructor(scene, heightFn, cbs){
    this.scene = scene; this.heightFn = heightFn; this.cbs = cbs || {};
    this.hp = HP_MAX;
    this.state = 'emerge'; this.t = 0;
    this.gx = 0; this.gz = 0; this.facing = 0;
    this.walkPhase = 0;
    this._tremor = 0; this._recoil = 0; this._respawn = 0;
    this._atkCd = 0; this._bitDone = false;
    this.fallen = false; this._fall = 0;        // 0 pystyssä … 1 maassa
    this.chunks = [];
    this._build();
  }

  _build(){
    const g = new THREE.Group(); this.group = g;
    this.sandMat = toonMat({ color: 0xc6a878 });          // cell-shaded hiekka
    this.sandDark = toonMat({ color: 0x8f744c });          // varjoisat syvennykset
    const mouthMat = new THREE.MeshBasicMaterial({ color: 0x140d06 });
    this.lift = new THREE.Group(); g.add(this.lift);        // emerge/kaatuminen
    const pelvis = new THREE.Group(); pelvis.position.y = PELVIS_Y; this.lift.add(pelvis); this.pelvis = pelvis;

    const cap = (len, rT, rB, mat) => {                     // kapseli alaspäin nivelestä (0 → -len)
      const geo = new THREE.CapsuleGeometry((rT + rB) / 2, Math.max(0.01, len - (rT + rB)), 4, 10);
      jitter(geo, 0.03);
      const m = new THREE.Mesh(geo, mat || this.sandMat); m.position.y = -len / 2; return m;
    };
    const ball = (r, mat) => { const geo = new THREE.SphereGeometry(r, 10, 8); jitter(geo, 0.02); return new THREE.Mesh(geo, mat || this.sandMat); };
    const ballAt = (r, x, y, z, mat) => { const m = ball(r, mat); m.position.set(x, y, z); return m; };
    const joint = (parent, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };

    // ---- vartalo (spine) ----
    const spine = joint(pelvis, 0, 0, 0); this.spine = spine;
    const torso = cap(TORSO, 0.34, 0.46, this.sandMat); torso.position.y = TORSO / 2; spine.add(torso);
    spine.add(ballAt(0.46, 0, 0.12, 0));   // lantiopallo
    const chest = ball(0.4); chest.position.set(0, TORSO * 0.82, 0); spine.add(chest);
    torso.userData.part = 'torso'; chest.userData.part = 'torso';

    // ---- pää ----
    const neck = joint(spine, 0, TORSO + 0.02, 0); this.neck = neck;
    spine.add(ballAt(0.2, 0, TORSO - 0.04, 0));   // niskapallo (jää vartaloon)
    const head = ball(HEADR); head.scale.set(1, 1.12, 1.02); head.position.y = HEADR * 0.9; neck.add(head);
    head.userData.part = 'head';
    // suu: tumma litteä onkalo pään etupuolella (+Z), aukeaa iskiessä
    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mouthMat);
    mouth.position.set(0, HEADR * 0.62, HEADR * 0.86); mouth.scale.set(1.1, 0.06, 0.5); neck.add(mouth); this.mouth = mouth;

    // ---- kädet (hartia → olka → kyynär → kyynärvarsi) ----
    const arm = (side) => {
      const sh = joint(spine, side * SHX, TORSO * 0.86, 0);
      spine.add(ballAt(0.2, side * SHX, TORSO * 0.86, 0));   // hartiapallo (jää vartaloon)
      sh.rotation.z = side * 0.12;
      const ua = cap(UA, 0.17, 0.14, this.sandMat); sh.add(ua);
      const el = joint(sh, 0, -UA, 0);
      el.add(ball(0.14));
      const fa = cap(FA, 0.14, 0.1, this.sandMat); el.add(fa);
      const hand = ball(0.17); hand.scale.set(1.1, 0.8, 1.2); hand.position.y = -FA; el.add(hand);
      const part = side < 0 ? 'larm' : 'rarm';
      [ua, fa, hand].forEach(m => m.userData.part = part);
      return { sh, el, ua, fa };
    };
    this.armL = arm(-1); this.armR = arm(1);

    // ---- jalat (lonkka → reisi → polvi → sääri) ----
    const leg = (side) => {
      const hip = joint(pelvis, side * HIPX, 0, 0);
      pelvis.add(ballAt(0.24, side * HIPX, 0, 0));   // lonkkapallo (jää lantioon)
      const th = cap(TH, 0.24, 0.19, this.sandMat); hip.add(th);
      const kn = joint(hip, 0, -TH, 0);
      kn.add(ball(0.18));
      const shn = cap(SH, 0.19, 0.14, this.sandMat); kn.add(shn);
      const foot = ball(0.2); foot.scale.set(1.1, 0.7, 1.6); foot.position.set(0, -SH, 0.12); kn.add(foot);
      const part = side < 0 ? 'lleg' : 'rleg';
      [th, shn, foot].forEach(m => m.userData.part = part);
      return { hip, kn };
    };
    this.legL = leg(-1); this.legR = leg(1);

    // osa-rekisteri (irrotettavat: 4 raajaa; pää/vartalo eivät irtoa)
    this.parts = {
      larm: { grp: this.armL.sh, hits: 0, detachAt: 3 + (Math.random() < 0.5 ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: false },
      rarm: { grp: this.armR.sh, hits: 0, detachAt: 3 + (Math.random() < 0.5 ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: false },
      lleg: { grp: this.legL.hip, hits: 0, detachAt: 3 + (Math.random() < 0.5 ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: true },
      rleg: { grp: this.legR.hip, hits: 0, detachAt: 3 + (Math.random() < 0.5 ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: true },
    };

    g.traverse(o => { if (o.isMesh) { o.userData.enemy = this; o.castShadow = true; o.receiveShadow = false; } });
    addOutlines(g, 0.025);   // cell-shade ääriviivat (lisätään niveliin lapsiksi → animoituvat mukana)
    g.visible = false;
    this.scene.add(g);
  }

  // ---- tilakone ----
  update(dt, px, pz, camera){
    this.t += dt; this._tremor = 0;
    if (this._recoil > 0) this._recoil = Math.max(0, this._recoil - dt * 4);
    this._regrowTick(dt);
    const dist = Math.hypot(this.gx - px, this.gz - pz);

    switch (this.state) {
      case 'emerge': this._emerge(dt, px, pz); break;
      case 'walk': this._walk(dt, px, pz, dist); break;
      case 'attack': this._attack(dt, px, pz, dist); break;
      case 'dead': this._dead(dt); break;
      case 'gone': this._respawn -= dt; if (this._respawn <= 0) this._spawn(px, pz); break;
    }
    // kaatuminen jos jalka poissa (pystytys kun molemmat jalat on)
    const legGone = this.parts.lleg.gone || this.parts.rleg.gone;
    const target = legGone ? 1 : 0;
    this._fall += (target - this._fall) * Math.min(1, dt * 3.5);
    if (legGone && !this.fallen && this._fall > 0.5) this.fallen = true;
    if (!legGone && this.fallen && this._fall < 0.1) this.fallen = false;

    this._pose(dt);
    this._applyTransform();
    this._updateChunks(dt);
  }

  _setState(s){ this.state = s; this.t = 0; }
  _spawn(px, pz){
    this.hp = HP_MAX; this.fallen = false; this._fall = 0;
    for (const k in this.parts) { const p = this.parts[k]; p.gone = false; p.hits = 0; p.grow = 1; p.regrow = 0; p.grp.visible = true; p.grp.scale.setScalar(1); }
    const a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 14;
    this.gx = px + Math.cos(a) * r; this.gz = pz + Math.sin(a) * r;
    this.group.visible = true;
    this._setState('emerge');
  }

  _emerge(dt, px, pz){
    const p = Math.min(1, this.t / EMERGE_T);
    this._emergeY = -3.6 * (1 - p);     // nousee hitaasti maasta
    this._tremor = 0.05 * (1 - p);
    this._face(px, pz, dt * 1.5);
    if (p > 0.2 && Math.random() < dt * 6 && this.cbs.burst) {   // hiekkaa varisee
      this.group.getWorldPosition(_wp);
      this.cbs.burst(_wp.x + (Math.random() - 0.5), _wp.y + Math.random() * 2, _wp.z + (Math.random() - 0.5), false, this.sandMat);
    }
    if (p >= 1) { this._emergeY = 0; this._setState('walk'); }
  }

  _walk(dt, px, pz, dist){
    this._emergeY = 0;
    this._face(px, pz, dt * 2.2);
    if (!this.fallen) {
      if (dist > ATTACK_RANGE) {
        const dx = px - this.gx, dz = pz - this.gz, d = Math.hypot(dx, dz) || 1;
        this.gx += dx / d * SPEED * dt; this.gz += dz / d * SPEED * dt;
        this.walkPhase += dt * 6.0;     // jalkojen tahti
      } else if (this._atkCd <= 0) {
        this._bitDone = false; this._setState('attack');
      }
    }
    this._atkCd = Math.max(0, this._atkCd - dt);
  }

  _attack(dt, px, pz, dist){
    this._face(px, pz, dt * 1.5);
    if (this.fallen) { this._setState('walk'); return; }
    const T = 0.95;
    // suu auki swingin ajan; isku osuu ~55 % kohdalla
    if (this.t > T * 0.2 && this.t < T * 0.8) this.mouthOpen = Math.min(1, this.mouthOpen + dt * 8);
    else this.mouthOpen = Math.max(0, this.mouthOpen - dt * 6);
    if (!this._bitDone && this.t >= T * 0.55) {
      this._bitDone = true;
      if (dist < ATTACK_RANGE + 0.8 && this.cbs.bite) { this.cbs.bite(BITE_DMG); this._tremor = 0.12; }
    }
    if (this.t >= T) { this._atkCd = 1.1; this._setState('walk'); }
  }

  _dead(dt){
    const p = Math.min(1, this.t / DEAD_T);
    this._sink = -2.5 * p;              // vajoaa hiekaksi
    this.group.scale.setScalar(Math.max(0.01, 1 - p * 0.5));
    this._tremor = 0.08 * (1 - p);
    if (p > 0.1 && Math.random() < dt * 10 && this.cbs.burst) {
      this.group.getWorldPosition(_wp);
      this.cbs.burst(_wp.x + (Math.random() - 0.5) * 1.5, _wp.y + Math.random() * 2, _wp.z + (Math.random() - 0.5) * 1.5, false, this.sandMat);
    }
    if (p >= 1) { this.group.visible = false; this.group.scale.setScalar(1); this._sink = 0; this._respawn = RESPAWN_T; this._setState('gone'); }
  }

  // sileä kääntyminen pelaajaa kohti
  _face(px, pz, rate){
    const want = Math.atan2(px - this.gx, pz - this.gz);
    let d = want - this.facing; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    this.facing += d * Math.min(1, rate);
  }

  // asento: kävely / isku / kaatuminen + recoil
  _pose(dt){
    const A = this.armL, B = this.armR, L = this.legL, R = this.legR;
    if (this.mouthOpen === undefined) this.mouthOpen = 0;
    // kasvoton lepotilassa: suu näkyy VAIN auetessaan (iskun aikana)
    this.mouth.visible = this.mouthOpen > 0.03;
    this.mouth.scale.y = 0.12 + this.mouthOpen * 0.95;
    const walking = this.state === 'walk' && !this.fallen;
    const ph = this.walkPhase;
    // jalat
    const lift = this.fallen ? 0 : 1;
    L.hip.rotation.x = Math.sin(ph) * 0.5 * lift;
    R.hip.rotation.x = Math.sin(ph + Math.PI) * 0.5 * lift;
    L.kn.rotation.x = -Math.max(0, Math.sin(ph + Math.PI * 0.5)) * 0.9 * lift - 0.04;
    R.kn.rotation.x = -Math.max(0, Math.sin(ph + Math.PI * 1.5)) * 0.9 * lift - 0.04;
    // kädet (vastatahti) — paitsi oikea käsi iskun aikana
    A.sh.rotation.x = Math.sin(ph + Math.PI) * 0.35;
    A.el.rotation.x = -0.35 - Math.max(0, Math.sin(ph)) * 0.25;
    if (this.state === 'attack') {
      const u = Math.min(1, this.t / 0.95);
      // ylösnosto (u<0.4) → isku alas/eteen (u>0.4)
      const swing = u < 0.4 ? -2.0 * (u / 0.4) : -2.0 + 3.2 * ((u - 0.4) / 0.6);
      B.sh.rotation.x = swing;
      B.sh.rotation.z = 0.12 - 0.5 * Math.min(1, u * 2);
      B.el.rotation.x = -0.3 - (1 - Math.min(1, Math.abs(u - 0.5) * 2)) * 0.8;
    } else {
      B.sh.rotation.x = Math.sin(ph) * 0.35;
      B.sh.rotation.z = 0.12;
      B.el.rotation.x = -0.35 - Math.max(0, Math.sin(ph + Math.PI)) * 0.25;
    }
    // vartalon nytkähdys osumasta (taakse) + kävelyn keinunta
    this.spine.rotation.x = -this._recoil * 0.5 + (walking ? Math.sin(ph * 2) * 0.03 : 0);
    this.spine.rotation.z = walking ? Math.sin(ph) * 0.05 : 0;
    this.pelvis.position.y = PELVIS_Y + (walking ? Math.abs(Math.sin(ph)) * 0.06 : 0);
    // raajojen takaisinkasvu (skaalaus)
    for (const k in this.parts) { const p = this.parts[k]; if (!p.gone) p.grp.scale.setScalar(p.grow); }
  }

  _applyTransform(){
    const gy = this.heightFn ? this.heightFn(this.gx, this.gz) : 0;
    this.group.position.set(this.gx, gy + (this._sink || 0), this.gz);
    this.group.rotation.y = this.facing;
    // emerge-nousu + kaatuminen (kierto eteen + lasku)
    this.lift.position.y = (this._emergeY || 0) - this._fall * (PELVIS_Y * 0.55);
    this.lift.rotation.x = this._fall * 1.45;
  }

  // ---- vahinko ----
  takeDamage(amount, hit){
    if (!this.group.visible || this.state === 'dead' || this.state === 'gone') return false;
    // selvitä osuma-alue meshin userData.partista
    let o = hit && hit.object, part = null;
    while (o) { if (o.userData && o.userData.part) { part = o.userData.part; break; } o = o.parent; }
    this._recoil = 1;                          // rungon nytkähdys
    this._tremor = 0.06;
    this.hp -= amount;
    const pd = part && this.parts[part];
    if (pd && !pd.gone) {
      pd.hits += 1;
      if (pd.hits >= pd.detachAt) this._detach(part);
    }
    if (this.hp <= 0) { this._die(); return true; }
    return false;
  }

  _detach(key){
    const p = this.parts[key]; if (!p || p.gone) return;
    p.gone = true; p.regrow = REGROW_T;
    p.grp.getWorldPosition(_wp);
    p.grp.visible = false;
    if (this.cbs.burst) for (let k = 0; k < 6; k++) this.cbs.burst(_wp.x + (Math.random() - 0.5) * 0.6, _wp.y + (Math.random() - 0.5) * 0.6, _wp.z + (Math.random() - 0.5) * 0.6, k < 2, this.sandMat);
    this._spawnChunk(_wp, p.leg);
  }

  _regrowTick(dt){
    for (const k in this.parts) {
      const p = this.parts[k];
      if (p.gone) { p.regrow -= dt; if (p.regrow <= 0) { p.gone = false; p.hits = 0; p.grow = 0; p.grp.visible = true; } }
      else if (p.grow < 1) p.grow = Math.min(1, p.grow + dt / 1.5);   // kasvaa esiin ~1,5 s
    }
  }

  // irronnut raaja lentää hiekkana
  _spawnChunk(worldPos, isLeg){
    const geo = new THREE.CapsuleGeometry(isLeg ? 0.2 : 0.15, isLeg ? 0.7 : 0.6, 4, 8); jitter(geo, 0.04);
    const m = new THREE.Mesh(geo, this.sandMat); m.position.copy(worldPos); m.castShadow = true;
    this.scene.add(m);
    this.chunks.push({ m, vel: new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4), spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8), t: 0, max: 2.6 });
  }
  _updateChunks(dt){
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]; c.t += dt;
      c.vel.y -= 12 * dt; c.m.position.addScaledVector(c.vel, dt);
      const gy = this.heightFn ? this.heightFn(c.m.position.x, c.m.position.z) : 0;
      if (c.m.position.y < gy + 0.15) { c.m.position.y = gy + 0.15; c.vel.set(0, 0, 0); }
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt; c.m.rotation.z += c.spin.z * dt;
      if (c.t > c.max) { const s = Math.max(0.01, 1 - (c.t - c.max) / 0.6); c.m.scale.setScalar(s); if (s <= 0.02) { this.scene.remove(c.m); c.m.geometry.dispose(); this.chunks.splice(i, 1); } }
    }
  }

  _die(){ this.hp = 0; this._setState('dead'); this._sink = 0; }

  get tremor(){ return this._tremor; }
  get alive(){ return this.state !== 'gone' && this.state !== 'dead'; }

  reset(){
    this.group.visible = false; this.group.scale.setScalar(1);
    for (const c of this.chunks) { this.scene.remove(c.m); c.m.geometry.dispose(); }
    this.chunks = [];
    this._respawn = RESPAWN_T * 0.4; this._setState('gone');
    this._emergeY = -3.6; this._sink = 0; this._fall = 0; this.fallen = false;
  }

  dispose(){
    this.scene.remove(this.group);
    for (const c of this.chunks) this.scene.remove(c.m);
    this.chunks = [];
  }
}
