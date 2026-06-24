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

// mittasuhteet (yksiköt) — JÄYKKÄ, MASSIIVINEN kivigolem (kyyryssä, isot kädet,
// pienet jalat, iso matala pää) referenssikuvan mukaan
const TH = 0.62, SH = 0.62;          // lyhyet tukevat jalat
const UA = 1.18, FA = 1.05;          // pitkät paksut kädet (ulottuvat lähes maahan)
const HEADR = 0.58;                  // pää (pienempi)
const HIPX = 0.52, SHX = 1.08;       // leveät lonkat ja hartiat (puolikas)
const PELVIS_Y = TH + SH;            // lantio (~1.24) jalkojen päällä
const SHOULDER_Y = 1.7;              // hartian korkeus lantiosta
const ARM_BASE = 0.12;               // käsien lepokulma (kyyryssä hieman eteen)
const LEAN = 0.14;                   // vartalon etukumara

const HP_MAX = 30;                   // iso → kestää enemmän (pää/vartalo-osumat tappavat lopulta)
const BITE_DMG = 0.34;               // iskun vahinko pelaajaan
const ATTACK_RANGE = 3.8;            // iso ulottuvuus
const SPEED = 2.2;                   // raskas könytys
const EMERGE_T = 3.6, DEAD_T = 2.0, RESPAWN_T = 16;
const REGROW_T = 9;                  // raajan takaisinkasvu
const EMERGE_DEPTH = 5.2;            // syvyys josta nousee

const _wp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _nrm = new THREE.Vector3();
const _qTilt = new THREE.Quaternion(), _qYaw = new THREE.Quaternion();

function jitter(geo, amt){
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (Math.random() - 0.5) * amt, p.getY(i) + (Math.random() - 0.5) * amt, p.getZ(i) + (Math.random() - 0.5) * amt);
  p.needsUpdate = true; geo.computeVertexNormals();
}

// proseduraalinen halkeillut kivipinta (terrakotta + tummat halkeamat + ylävalot)
let _rockTex = null;
function rockTex(){
  if (_rockTex) return _rockTex;
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.fillStyle = '#834a30'; c.fillRect(0, 0, s, s);   // tummempi pohja
  // karkea rakeisuus (grunge)
  for (let i = 0; i < 4200; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 0.6 + Math.random() * 3.0;
    c.fillStyle = Math.random() < 0.55 ? `rgba(40,18,10,${0.06 + Math.random() * 0.18})` : `rgba(176,118,82,${0.04 + Math.random() * 0.13})`;
    c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
  }
  // tummat likaläiskät (grime) — epätasaiset isot tahrat
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 8 + Math.random() * 34;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(24,11,6,${0.18 + Math.random() * 0.22})`); g.addColorStop(1, 'rgba(24,11,6,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
  }
  const crackle = (col, w, n, len) => {   // rosoiset halkeamat
    c.strokeStyle = col;
    for (let i = 0; i < n; i++) {
      let x = Math.random() * s, y = Math.random() * s;
      c.lineWidth = w * (0.5 + Math.random()); c.beginPath(); c.moveTo(x, y);
      const seg = 4 + (Math.random() * 7 | 0);
      for (let k = 0; k < seg; k++) { x += (Math.random() - 0.5) * len; y += (Math.random() - 0.5) * len; c.lineTo(x, y); }
      c.stroke();
    }
  };
  crackle('rgba(16,7,3,0.9)', 2.8, 48, 70);       // tiheämmät syvät halkeamat
  crackle('rgba(14,6,3,0.6)', 1.4, 60, 38);       // hienot säröt
  crackle('rgba(196,148,112,0.35)', 1.0, 22, 46); // niukat vaaleat kohokuviot
  _rockTex = new THREE.CanvasTexture(cv);
  _rockTex.wrapS = _rockTex.wrapT = THREE.RepeatWrapping; _rockTex.repeat.set(1.6, 1.6);
  return _rockTex;
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
    // halkeillut kivipinta (terrakotta) + fasetoitu (flatShading) → lohkomainen kivi
    this.sandMat = toonMat({ map: rockTex(), flatShading: true });
    this.sandMat.color.setRGB(0.6, 0.5, 0.44);             // tummempi kivipinta
    this.sandMat.shadowSide = THREE.BackSide;
    const mouthMat = new THREE.MeshBasicMaterial({ color: 0x0a0503 });   // tummat onkalot (silmät/suu)
    this.lift = new THREE.Group(); g.add(this.lift);        // emerge/kaatuminen
    const pelvis = new THREE.Group(); pelvis.position.y = PELVIS_Y; this.lift.add(pelvis); this.pelvis = pelvis;

    const cap = (len, rT, rB) => {                          // kapseli alaspäin nivelestä (0 → -len)
      const geo = new THREE.CapsuleGeometry((rT + rB) / 2, Math.max(0.01, len - (rT + rB)), 5, 14);
      jitter(geo, 0.1);
      const m = new THREE.Mesh(geo, this.sandMat); m.position.y = -len / 2; return m;
    };
    const ball = (r, mat) => { const geo = new THREE.SphereGeometry(r, 13, 11); jitter(geo, r * 0.12); return new THREE.Mesh(geo, mat || this.sandMat); };
    const ballAt = (r, x, y, z, mat) => { const m = ball(r, mat); m.position.set(x, y, z); return m; };
    // ANGULAARINEN lohkare (matalapolyinen ikosaedri + voimakas jitter) → särmikäs,
    // ei pyöreä. Käytetään päässä, nyrkeissä ja nivelissä.
    const chunk = (r, detail) => { const geo = new THREE.IcosahedronGeometry(r, detail || 0); jitter(geo, r * 0.2); return new THREE.Mesh(geo, this.sandMat); };
    const chunkAt = (r, x, y, z, detail) => { const m = chunk(r, detail); m.position.set(x, y, z); return m; };
    const joint = (parent, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };

    // ---- MASSIIVINEN pyöreä vartalo (limittäisistä lohkareista) ----
    const spine = joint(pelvis, 0, 0, 0); this.spine = spine;
    const bodyParts = [
      ballAt(1.12, 0, 0.95, 0),     // päämassa
      ballAt(1.02, 0, 0.35, 0.2),   // pömppövatsa (eteen)
      ballAt(0.92, 0, 1.5, -0.05),  // hartiamassa (ylä, hieman taakse → pää erottuu edestä)
    ];
    bodyParts.forEach(m => { m.scale.set(1.25, 1.12, 1.12); m.userData.part = 'torso'; spine.add(m); });

    // ---- ISO matala pää joka TYÖNTYY eteen ylävartalosta (kyyryssä) + tummat onkalot ----
    const neck = joint(spine, 0, SHOULDER_Y - 0.05, 0.88); this.neck = neck;
    const head = chunk(HEADR, 1); head.scale.set(1.1, 1.0, 1.05); head.position.set(0, 0.05, 0.22); neck.add(head);
    head.userData.part = 'head';
    // kaksi syvää tummaa kuoppaa pään ETUPINNALLE (kuten kuvassa) — muuten kasvoton.
    // Lapsia HEAD-meshille → head-lokaalikoordinaatit (etunapa z ≈ HEADR).
    const hole = (x, y, z, sx, sy, sz, r) => { const e = new THREE.Mesh(new THREE.SphereGeometry(r || 0.2, 10, 8), mouthMat); e.position.set(x, y, z); e.scale.set(sx, sy, sz); head.add(e); return e; };
    hole(-0.17, 0.13, HEADR * 0.92, 1.0, 1.1, 0.6, 0.075);   // hyvin pienet silmäkuopat
    hole(0.17, 0.13, HEADR * 0.92, 1.0, 1.1, 0.6, 0.075);
    this.mouth = null;   // ei suuta lainkaan

    // ---- paksut pitkät kädet (hartia → olka → kyynär → kyynärvarsi → nyrkki) ----
    const arm = (side) => {
      const sh = joint(spine, side * SHX, SHOULDER_Y, 0.05);
      spine.add(chunkAt(0.52, side * SHX, SHOULDER_Y, 0.05));   // hartialohkare (jää vartaloon)
      const ua = cap(UA, 0.36, 0.3); sh.add(ua);
      const el = joint(sh, 0, -UA, 0);
      el.add(chunk(0.34));                                       // kyynärlohkare (särmikäs)
      const fa = cap(FA, 0.3, 0.26); el.add(fa);
      const hand = chunk(0.44); hand.scale.set(1.0, 0.82, 1.15); hand.position.y = -FA - 0.08; el.add(hand);   // iso särmikäs nyrkki
      const part = side < 0 ? 'larm' : 'rarm';
      [ua, fa, hand].forEach(m => m.userData.part = part);
      return { sh, el, ua, fa, side };
    };
    this.armL = arm(-1); this.armR = arm(1);

    // ---- lyhyet tukevat jalat (lonkka → reisi → polvi → sääri → jalka) ----
    const leg = (side) => {
      const hip = joint(pelvis, side * HIPX, 0, 0);
      pelvis.add(chunkAt(0.52, side * HIPX, 0, 0));   // lonkkalohkare (jää lantioon)
      const th = cap(TH, 0.4, 0.36); hip.add(th);
      const kn = joint(hip, 0, -TH, 0);
      kn.add(chunk(0.36));                              // polvilohkare (särmikäs)
      const shn = cap(SH, 0.36, 0.34); kn.add(shn);
      const foot = chunk(0.44); foot.scale.set(1.1, 0.65, 1.5); foot.position.set(0, -SH, 0.2); kn.add(foot);
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
    this._emergeY = -EMERGE_DEPTH * (1 - p);     // nousee hitaasti maasta
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
        this.walkPhase += dt * 4.6;     // raskas, hidas tahti
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
    // isku osuu ~55 % swingistä
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
    const walking = this.state === 'walk' && !this.fallen;
    const ph = this.walkPhase;
    // lyhyet tukevat jalat: pieni heilahdus + polven taittuminen
    const lift = this.fallen ? 0 : 1;
    L.hip.rotation.x = Math.sin(ph) * 0.34 * lift;
    R.hip.rotation.x = Math.sin(ph + Math.PI) * 0.34 * lift;
    L.kn.rotation.x = -Math.max(0, Math.sin(ph + Math.PI * 0.5)) * 0.7 * lift - 0.05;
    R.kn.rotation.x = -Math.max(0, Math.sin(ph + Math.PI * 1.5)) * 0.7 * lift - 0.05;
    // paksut kädet roikkuvat eteen-ulos ja heiluvat raskaasti (vastatahti)
    A.sh.rotation.set(ARM_BASE + Math.sin(ph + Math.PI) * 0.26, 0, A.side * 0.2);
    A.el.rotation.x = -0.3 - Math.max(0, Math.sin(ph)) * 0.22;
    if (this.state === 'attack') {
      const u = Math.min(1, this.t / 0.95);
      const swing = u < 0.4 ? -1.9 * (u / 0.4) : -1.9 + 3.4 * ((u - 0.4) / 0.6);   // nosto → murskaava isku alas
      B.sh.rotation.set(swing, 0, B.side * 0.2 - 0.3 * Math.min(1, u * 2));
      B.el.rotation.x = -0.25 - (1 - Math.min(1, Math.abs(u - 0.5) * 2)) * 0.9;
    } else {
      B.sh.rotation.set(ARM_BASE + Math.sin(ph) * 0.26, 0, B.side * 0.2);
      B.el.rotation.x = -0.3 - Math.max(0, Math.sin(ph + Math.PI)) * 0.22;
    }
    // vartalo: etukumara (LEAN) + osuman nytkähdys taakse + raskas keinunta
    this.spine.rotation.x = LEAN - this._recoil * 0.5 + (walking ? Math.sin(ph * 2) * 0.04 : 0);
    this.spine.rotation.z = walking ? Math.sin(ph) * 0.07 : 0;
    this.pelvis.position.y = PELVIS_Y + (walking ? Math.abs(Math.sin(ph)) * 0.07 : 0);
    // raajojen takaisinkasvu (skaalaus)
    for (const k in this.parts) { const p = this.parts[k]; if (!p.gone) p.grp.scale.setScalar(p.grow); }
  }

  _applyTransform(){
    const h = this.heightFn;
    const gy = h ? h(this.gx, this.gz) : 0;
    // SLOPE-suuntaus: kallista golem maaston normaalin mukaan (keskidifferenssi) →
    // jalat seuraavat rinnettä, runko ei uppoa ylämäkeen eikä leiju alamäessä
    if (h) {
      const e = 1.2;
      const dhx = (h(this.gx + e, this.gz) - h(this.gx - e, this.gz)) / (2 * e);
      const dhz = (h(this.gx, this.gz + e) - h(this.gx, this.gz - e)) / (2 * e);
      _nrm.set(-dhx, 1, -dhz).normalize();
    } else _nrm.set(0, 1, 0);
    _qYaw.setFromAxisAngle(_up, this.facing);
    _qTilt.setFromUnitVectors(_up, _nrm);
    this.group.quaternion.multiplyQuaternions(_qTilt, _qYaw);   // suunta ensin, sitten kallistus rinteeseen
    this.group.position.set(this.gx, gy + (this._sink || 0), this.gz);
    // emerge-nousu + kaatuminen: maltillinen etukallistus + pieni nosto, ettei
    // eteen kurottava pää uppoa maahan (kierto jalkatason ympäri muuten upottaisi)
    this.lift.position.y = (this._emergeY || 0) + this._fall * 0.35;
    this.lift.rotation.x = this._fall * 1.05;
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
    const geo = new THREE.CapsuleGeometry(isLeg ? 0.38 : 0.32, isLeg ? 0.9 : 1.0, 4, 10); jitter(geo, 0.07);
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
    this._emergeY = -EMERGE_DEPTH; this._sink = 0; this._fall = 0; this.fallen = false;
  }

  dispose(){
    this.scene.remove(this.group);
    for (const c of this.chunks) this.scene.remove(c.m);
    this.chunks = [];
  }
}
