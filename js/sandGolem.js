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

// mittasuhteet (yksiköt) — KIVIKLUSTERIGOLEM joka kävelee gorillan tavoin
// neljällä raajalla (referenssikuvan mukaan). Erittäin pitkät kädet jotka
// ulottuvat maahan, kyyryssä kävelyasento.
const TH = 1.15, SH = 1.05;          // pidemmät jalat (reisi + sääri)
const UA = 1.05, FA = 0.95;          // lyhyemmät kädet
const HEADR = 0.52;                  // pää (pieni vartalon suhteen)
const HIPX = 0.95, SHX = 1.4;        // leveä haara-asento, leveät hartiat
const FOOT_LIFT = 0.65;              // alustava lantion clearance — IK tarkentaa kummankin jalan maaston mukaan
const PELVIS_Y = TH + SH + FOOT_LIFT; // lantion vakiokorkeus (suora jalka, koko jalkaterä maassa)
const SWING_FRAC = 0.32;             // raaja ilmassa tämän osan puolisyklistään
const SHOULDER_Y = 1.65;             // hartian korkeus lantiosta
const ARM_BASE = 0;                  // kädet roikkuvat suoraan alas
const LEAN = 0.5;                    // VAHVA etukumara (gorilla-asento)

const HP_MAX = 30;                   // iso → kestää enemmän (pää/vartalo-osumat tappavat lopulta)
const BITE_DMG = 0.34;               // iskun vahinko pelaajaan
const ATTACK_RANGE = 3.8;            // iso ulottuvuus
const ATTACK_T = 1.65;               // pitkä iskun kesto (anticipation → snap → follow-through)
const SPEED = 0.85;                  // erittäin hidas, painava liike
const EMERGE_T = 3.6, DEAD_T = 2.0, RESPAWN_T = 16;
const REGROW_T = 9;                  // raajan takaisinkasvu
const EMERGE_DEPTH = 5.2;            // syvyys josta nousee

const _wp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _nrm = new THREE.Vector3();
const _qTilt = new THREE.Quaternion(), _qYaw = new THREE.Quaternion();
const _ikL = new THREE.Vector3(), _ikR = new THREE.Vector3();

function jitter(geo, amt){
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (Math.random() - 0.5) * amt, p.getY(i) + (Math.random() - 0.5) * amt, p.getZ(i) + (Math.random() - 0.5) * amt);
  p.needsUpdate = true; geo.computeVertexNormals();
}

// proseduraalinen sammaleinen harmaakivipinta (tumma kivi + sammaleläiskät)
let _rockTex = null;
function rockTex(){
  if (_rockTex) return _rockTex;
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.fillStyle = '#3d3a35'; c.fillRect(0, 0, s, s);   // tumma harmaakivi (pohja)
  // karkea rakeisuus
  for (let i = 0; i < 4200; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 0.6 + Math.random() * 2.6;
    c.fillStyle = Math.random() < 0.55 ? `rgba(20,18,16,${0.05 + Math.random() * 0.18})` : `rgba(100,98,90,${0.04 + Math.random() * 0.13})`;
    c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
  }
  // SAMMAL: harvat, pehmeät vihertävänkeltaiset läiskät (vähemmistö pinnasta)
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 14 + Math.random() * 30;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const hue = 75 + Math.random() * 20, sat = 22 + Math.random() * 18, lum = 22 + Math.random() * 10;
    g.addColorStop(0, `hsla(${hue},${sat}%,${lum}%,${0.22 + Math.random() * 0.18})`);
    g.addColorStop(1, `hsla(${hue},${sat}%,${lum}%,0)`);
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
  }
  // hienovaraiset sammaltäplät
  for (let i = 0; i < 600; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 0.5 + Math.random() * 1.2;
    c.fillStyle = `hsla(${75 + Math.random() * 25},${28}%,${30 + Math.random() * 12}%,${0.13 + Math.random() * 0.13})`;
    c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
  }
  // tummat likaläiskät
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 8 + Math.random() * 30;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(12,10,8,${0.18 + Math.random() * 0.2})`); g.addColorStop(1, 'rgba(12,10,8,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fill();
  }
  const crackle = (col, w, n, len) => {
    c.strokeStyle = col;
    for (let i = 0; i < n; i++) {
      let x = Math.random() * s, y = Math.random() * s;
      c.lineWidth = w * (0.5 + Math.random()); c.beginPath(); c.moveTo(x, y);
      const seg = 4 + (Math.random() * 7 | 0);
      for (let k = 0; k < seg; k++) { x += (Math.random() - 0.5) * len; y += (Math.random() - 0.5) * len; c.lineTo(x, y); }
      c.stroke();
    }
  };
  crackle('rgba(8,7,5,0.85)', 2.2, 36, 60);
  crackle('rgba(6,5,4,0.55)', 1.0, 48, 30);
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
    // sammaleinen harmaa kivipinta + flatShading → lohkomainen, kasvoton golem
    this.sandMat = toonMat({ map: rockTex(), flatShading: true, side: THREE.DoubleSide });
    this.sandMat.color.setRGB(0.55, 0.55, 0.5);             // tumma harmaakivi (toon tummentaa lisää)
    this.sandMat.shadowSide = THREE.BackSide;
    this.lift = new THREE.Group(); g.add(this.lift);
    const pelvis = new THREE.Group(); pelvis.position.y = PELVIS_Y; this.lift.add(pelvis); this.pelvis = pelvis;

    const joint = (parent, x, y, z) => { const j = new THREE.Group(); j.position.set(x, y, z); parent.add(j); return j; };
    // PIENI KIVI: matalapolyinen ikosaedri + jitter → särmikäs lohkare
    const rock = (r) => {
      const rr = r * (0.75 + Math.random() * 0.5);
      const geo = new THREE.IcosahedronGeometry(rr, 0); jitter(geo, rr * 0.18);
      const m = new THREE.Mesh(geo, this.sandMat);
      m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      return m;
    };
    // KASA pieniä kiviä annetussa ellipsoidialueessa: läpileikkaavat kerrokset
    // täyttävät tilavuuden niin ettei sisäänpäin näy reikiä.
    const cluster = (parent, opts, partTag) => {
      const { cx = 0, cy = 0, cz = 0, sx = 1, sy = 1, sz = 1, n = 14, r = 0.32, jit = 0.15 } = opts;
      for (let i = 0; i < n; i++) {
        // fibonaccin spiraalimainen jakauma + jitteri → tasainen mutta epäsäännöllinen
        const u = (i + 0.5) / n, theta = i * 2.39996, phi = Math.acos(1 - 2 * u);
        const ux = Math.sin(phi) * Math.cos(theta), uy = Math.cos(phi), uz = Math.sin(phi) * Math.sin(theta);
        const rad = 0.55 + Math.random() * 0.42;     // pisteet kuoren tuntumassa
        const dx = ux * rad + (Math.random() - 0.5) * jit;
        const dy = uy * rad + (Math.random() - 0.5) * jit;
        const dz = uz * rad + (Math.random() - 0.5) * jit;
        const m = rock(r);
        m.position.set(cx + dx * sx, cy + dy * sy, cz + dz * sz);
        if (partTag) m.userData.part = partTag;
        parent.add(m);
      }
      // sisus: pari isompaa kiveä keskelle ettei tilavuus näy ontolta jos pintakivi siirtyy
      for (let i = 0; i < Math.max(2, n / 7 | 0); i++) {
        const m = rock(r * 1.5);
        m.position.set(cx + (Math.random() - 0.5) * sx * 0.5, cy + (Math.random() - 0.5) * sy * 0.5, cz + (Math.random() - 0.5) * sz * 0.5);
        if (partTag) m.userData.part = partTag;
        parent.add(m);
      }
    };
    // RAAJA kasattuna kapselin sijaan: kasa pieniä kiviä putkimaisesti pituussuunnassa
    const limbCluster = (parent, len, rT, rB, n, partTag) => {
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const y = -t * len;
        const rad = rT + (rB - rT) * t;
        const phi = Math.random() * 6.28;
        const off = rad * (0.55 + Math.random() * 0.5);
        const dx = Math.cos(phi) * off, dz = Math.sin(phi) * off;
        const r = rad * 0.6;
        const m = rock(r);
        m.position.set(dx, y, dz);
        if (partTag) m.userData.part = partTag;
        parent.add(m);
      }
      // keskirivi täyttöä
      for (let i = 0; i < Math.max(2, n / 3 | 0); i++) {
        const t = (i + 0.5) / Math.max(2, n / 3);
        const r = (rT + (rB - rT) * t) * 0.7;
        const m = rock(r); m.position.y = -t * len;
        if (partTag) m.userData.part = partTag;
        parent.add(m);
      }
    };

    // ---- VARTALO: kiviklusteri (leveämpi alaosa, kapeampi yläosa) ----
    const spine = joint(pelvis, 0, 0, 0); this.spine = spine;
    cluster(spine, { cx: 0, cy: 0.35, cz: 0.05, sx: 1.4, sy: 0.95, sz: 1.25, n: 22, r: 0.36 }, 'torso');   // alavatsa
    cluster(spine, { cx: 0, cy: 1.05, cz: 0,    sx: 1.3, sy: 1.0,  sz: 1.2,  n: 22, r: 0.34 }, 'torso');   // keskimassa
    cluster(spine, { cx: 0, cy: 1.65, cz: 0,    sx: 1.45, sy: 0.7, sz: 1.2,  n: 18, r: 0.32 }, 'torso');   // hartiamassa (leveä yläosa)

    // ---- PÄÄ: pieni kiviklusteri eteen-alas (kyyryssä), ei kasvopiirteitä ----
    const neck = joint(spine, 0, SHOULDER_Y - 0.1, 0.42); this.neck = neck;
    cluster(neck, { cx: 0, cy: 0.1, cz: 0.05, sx: 0.7, sy: 0.6, sz: 0.7, n: 14, r: 0.24 }, 'head');
    this.mouth = null;

    // ---- KÄDET: erittäin pitkät, ulottuvat maahan (gorilla-asento) ----
    const arm = (side) => {
      const sh = joint(spine, side * SHX, SHOULDER_Y - 0.15, 0.0);
      cluster(spine, { cx: side * SHX, cy: SHOULDER_Y - 0.1, cz: 0.0, sx: 0.5, sy: 0.5, sz: 0.5, n: 9, r: 0.3 }, 'torso');   // hartiarykelmä jää vartaloon
      limbCluster(sh, UA, 0.34, 0.3, 12, side < 0 ? 'larm' : 'rarm');
      const el = joint(sh, 0, -UA, 0);
      cluster(el, { cx: 0, cy: 0, cz: 0, sx: 0.45, sy: 0.45, sz: 0.45, n: 7, r: 0.28 }, side < 0 ? 'larm' : 'rarm');   // kyynärrykelmä
      limbCluster(el, FA, 0.3, 0.26, 11, side < 0 ? 'larm' : 'rarm');
      // nyrkki: tiivis klusteri kyynärvarren päässä
      const hand = joint(el, 0, -FA - 0.1, 0);
      cluster(hand, { cx: 0, cy: 0, cz: 0.05, sx: 0.55, sy: 0.55, sz: 0.65, n: 12, r: 0.3 }, side < 0 ? 'larm' : 'rarm');
      return { sh, el, side };
    };
    this.armL = arm(-1); this.armR = arm(1);

    // ---- JALAT: pitkät, taipuneet (kyyryssä) ----
    const leg = (side) => {
      const hip = joint(pelvis, side * HIPX, 0, 0);
      cluster(pelvis, { cx: side * HIPX, cy: 0, cz: 0, sx: 0.55, sy: 0.55, sz: 0.55, n: 9, r: 0.32 }, 'torso');   // lonkkarykelmä
      limbCluster(hip, TH, 0.42, 0.36, 12, side < 0 ? 'lleg' : 'rleg');
      const kn = joint(hip, 0, -TH, 0);
      cluster(kn, { cx: 0, cy: 0, cz: 0, sx: 0.5, sy: 0.5, sz: 0.5, n: 8, r: 0.3 }, side < 0 ? 'lleg' : 'rleg');   // polvirykelmä
      limbCluster(kn, SH, 0.36, 0.32, 11, side < 0 ? 'lleg' : 'rleg');
      // NILKKA: oma niveloryhmä → jalkaterä pyörii erikseen pitäen pohjan vaakatasossa
      const ank = joint(kn, 0, -SH, 0);
      cluster(ank, { cx: 0, cy: 0, cz: 0, sx: 0.42, sy: 0.42, sz: 0.45, n: 7, r: 0.28 }, side < 0 ? 'lleg' : 'rleg');   // nilkkarykelmä
      // jalkaterä: leveä litteä klusteri nilkasta eteenpäin (lattajalka)
      const foot = joint(ank, 0, -0.1, 0.25);
      cluster(foot, { cx: 0, cy: 0, cz: 0, sx: 0.75, sy: 0.22, sz: 1.0, n: 11, r: 0.26 }, side < 0 ? 'lleg' : 'rleg');
      return { hip, kn, ank };
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
        // PULSSATTU ETENEMINEN + SETTLE-TAUKO jokaisen askeleen jälkeen.
        // Painava liike: (1) runko hidastuu raajan ollessa swingissä (yhden tukijalan
        // kannatus) ja (2) heti footfall:n jälkeen ease-out-tauko jossa runko ja gait
        // pysähtyvät hetkellisesti → paino tuntuu jokaisessa askeleessa.
        const cyc = ((this.walkPhase / (Math.PI * 2)) % 1 + 1) % 1;
        const halfA = (cyc * 2) % 1, halfB = (cyc * 2 + 0.5) % 1;
        const lc = (p) => { const q = ((p % 1) + 1) % 1; return q < SWING_FRAC ? Math.sin((q / SWING_FRAC) * Math.PI) : 0; };
        const swingNow = Math.max(lc(halfA), lc(halfB));
        // Settle-tauko ease-out (sharp at footfall, smoothly back to normal)
        const PAUSE_WIN = 0.18;          // settle ikkuna puolisyklin osina
        const ease = (t) => { const u = 1 - t; return u * u * u; };   // ease-out kuutio
        const sincePlantA = ((halfA - SWING_FRAC) % 1 + 1) % 1;
        const sincePlantB = ((halfB - SWING_FRAC) % 1 + 1) % 1;
        const settleA = sincePlantA < PAUSE_WIN ? ease(sincePlantA / PAUSE_WIN) : 0;
        const settleB = sincePlantB < PAUSE_WIN ? ease(sincePlantB / PAUSE_WIN) : 0;
        const settle = Math.max(settleA, settleB);   // 1 heti footfall:n jälkeen, 0 muutoin
        const gaitMul = 1.0 - settle * 0.75;          // gait pysähtyy lähes kokonaan footfall:n jälkeen
        const moveMul = (1.0 - swingNow * 0.85) * gaitMul;
        this.gx += dx / d * SPEED * moveMul * dt;
        this.gz += dz / d * SPEED * moveMul * dt;
        this.walkPhase += dt * 1.9 * gaitMul;   // settle-aukon aikana gait myös pysähtyy
      } else if (this._atkCd <= 0) {
        this._bitDone = false; this._setState('attack');
      }
    }
    this._atkCd = Math.max(0, this._atkCd - dt);
  }

  _attack(dt, px, pz, dist){
    this._face(px, pz, dt * 1.5);
    if (this.fallen) { this._setState('walk'); return; }
    // isku osuu ~55 % swingistä (vaakapyyhkäisyn keskivaihe)
    if (!this._bitDone && this.t >= ATTACK_T * 0.55) {
      this._bitDone = true;
      if (dist < ATTACK_RANGE + 0.8 && this.cbs.bite) { this.cbs.bite(BITE_DMG); this._tremor = 0.14; }
    }
    if (this.t >= ATTACK_T) { this._atkCd = 1.2; this._setState('walk'); }
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
    const lift = this.fallen ? 0 : 1;
    let twist = 0;

    // ---- PAINOTETTU KNUCKLE-WALK ----
    // Gait-sykli (0..1) jaettu kahteen puolisykliin = kaksi diagonaaliparin askelta.
    // Puolisyklin sisällä: SWING (raaja ilmassa, lyhyt) → STANCE (planted, pitkä) →
    // raaja viipyy maassa suurimman osan ajasta → paino tuntuu jokaisessa askelessa.
    const cyc = ((ph / (Math.PI * 2)) % 1 + 1) % 1;
    const halfA = (cyc * 2) % 1;                   // A-pari (vas käsi + oik jalka): 0..1, 0..1 per syklillä
    const halfB = (cyc * 2 + 0.5) % 1;             // B-pari (oik käsi + vas jalka): puolen sweepin offset → vuorottelu
    // KORKEUSKÄYRÄ: kellomainen nosto swing-vaiheessa, 0 stance:ssa
    const liftC = (p) => p < SWING_FRAC ? Math.sin((p / SWING_FRAC) * Math.PI) : 0;
    // ETEEN-SWING: -1 (takana, äsken planted) → +1 (edessä, plantaamassa), sitten ajelehtii
    // hitaasti taakse stance-vaiheessa kun runko liikkuu raajan yli
    const swingC = (p) => p < SWING_FRAC
      ? (-1 + 2 * (p / SWING_FRAC))                // nopea swing eteen ilmassa
      : (1 - 2 * ((p - SWING_FRAC) / (1 - SWING_FRAC)));   // hidas drift taakse maassa
    const lA = liftC(halfA), lB = liftC(halfB);
    const sA = swingC(halfA), sB = swingC(halfB);

    // JALAT: lonkka taipuu eteen swing-vaiheessa, polvi koukistuu lisää (ilmassa),
    // NILKKA kompensoi → jalkaterä pysyy vaakatasossa eikä lävistä maata.
    // HUOM: model facing = +Z → positiivinen hip.rotation.x kääntää jalan tipun
    // -Z suuntaan (taaksepäin). Eteenpäin swing vaatii NEGATIIVISEN muutoksen
    // (jalka edessä = hipR negatiivinen).
    L.hip.rotation.x = 0.4 - sB * 0.32 * lift;
    R.hip.rotation.x = 0.4 - sA * 0.32 * lift;
    L.kn.rotation.x = -0.7 - lB * 0.5 * lift;
    R.kn.rotation.x = -0.7 - lA * 0.5 * lift;
    L.ank.rotation.x = -(L.hip.rotation.x + L.kn.rotation.x);
    R.ank.rotation.x = -(R.hip.rotation.x + R.kn.rotation.x);

    if (this.state === 'attack') {
      const u = Math.min(1, this.t / ATTACK_T);
      // ---- PAINOTETTU ISKU: HIDAS ANTICIPATION → SNAP → FOLLOW-THROUGH ----
      let yaw;
      if (u < 0.42) {                                  // anticipation: hidas kiihtyvä veto sivulle
        const a = u / 0.42, ae = a * a;
        yaw = 1.7 * ae; twist = 0.75 * ae;
      } else if (u < 0.78) {                           // SNAP: nopea raskas pyyhkäisy poikki
        const a = (u - 0.42) / 0.36;
        yaw = 1.7 - 3.8 * a; twist = 0.75 - 1.5 * a;
      } else {                                         // FOLLOW-THROUGH: liike jatkuu hitaasti
        const a = (u - 0.78) / 0.22;
        yaw = -2.1 + 0.18 * a; twist = -0.75 + 0.12 * a;
      }
      B.sh.rotation.set(-1.35, B.side * yaw, 0);
      B.el.rotation.x = -0.45;
      // tukikäsi maassa iskun aikana
      A.sh.rotation.set(0.1, 0, A.side * 0.15);
      A.el.rotation.x = -0.05;
    } else {
      // KÄDET: vain MINIMAALINEN heilahdus (golem kävelee pääosin jaloillaan).
      // HUOM: sama convention kuin jaloilla — eteen swing = NEGATIIVINEN hipR.
      A.sh.rotation.set(-sA * 0.1, 0, A.side * 0.15);
      A.el.rotation.x = -0.18;
      B.sh.rotation.set(-sB * 0.1, 0, B.side * 0.15);
      B.el.rotation.x = -0.18;
    }

    // ---- VARTALON PAINOMOTIIKKA (kasvatettu — kädet eivät heilauksellaan kompensoi) ----
    // Forward-back lurch: 2x per cycle, joka askel nykäisee runkoa eteen
    const bodyPitch = walking ? Math.sin(cyc * 4 * Math.PI) * 0.09 : 0;
    // Side roll: paino siirtyy puolelta toiselle 1x per syklillä
    const bodyRoll = walking ? Math.sin(cyc * 2 * Math.PI) * 0.16 : 0;
    this.spine.rotation.x = LEAN + bodyPitch - this._recoil * 0.5;
    this.spine.rotation.y = (walking ? bodyRoll * 0.35 : 0) + B.side * twist;
    this.spine.rotation.z = walking ? bodyRoll : 0;
    // DYNAAMINEN LANTION KORKEUS: planted-jalka pidetään maassa (ei klippausta).
    // Kummankin jalan vertikaalinen ulottuvuus polven kulmasta; pidempi jalka
    // kannattaa kehoa → lantio seuraa sitä. Tämä korvaa staattisen pelvisDipin.
    if (walking || this.state === 'attack') {
      const legH = (hr, kr) => TH * Math.cos(hr) + SH * Math.cos(hr + kr);
      const lh = legH(L.hip.rotation.x, L.kn.rotation.x);
      const rh = legH(R.hip.rotation.x, R.kn.rotation.x);
      this.pelvis.position.y = Math.max(lh, rh) + FOOT_LIFT;
    } else {
      this.pelvis.position.y = PELVIS_Y;
    }

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

    // ---- IK: nosta runko niin että alempi (planted) jalkaterä koskee maata ----
    // Päästään eroon "ilmassa kävely" -bugista: aiemmin FOOT_LIFT-vakio kalibrointiin
    // tasaiseen maahan, mutta rinteillä lantio jää korkeammalle koska runko kallistuu
    // (vertikaalinen pudotus = legH * cos(slope)). Tässä haetaan kummankin nilkan
    // todellinen maailmapositio ja maaston korkeus sen alla, ja siirretään runko
    // pystysuunnassa niin että alempi nilkka on ANK_OFFSET maaston päällä.
    if (h && (this.state === 'walk' || this.state === 'attack' || this.state === 'emerge')) {
      this.group.updateMatrixWorld(true);
      this.legL.ank.getWorldPosition(_ikL);
      this.legR.ank.getWorldPosition(_ikR);
      const ANK_OFFSET = 0.65;   // nilkkalohkareen/jalkaterän ulottuvuus maan päälle
      const lTerr = h(_ikL.x, _ikL.z);
      const rTerr = h(_ikR.x, _ikR.z);
      // alempi jalka määrää korkeuden: positiivinen adj nostaa runkoa (estää klippauksen)
      const adj = Math.max((lTerr + ANK_OFFSET) - _ikL.y, (rTerr + ANK_OFFSET) - _ikR.y);
      this.group.position.y += adj;
    }
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
