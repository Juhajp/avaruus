/* ---------------- Vihollinen: Regolith-mato (Regolith Worm) ----------------
   Suuri maanalainen väijyttäjä Marsin pinnalla. Erillinen entiteetti (oma
   moduuli/luokka) — jokainen vihollistyyppi saa oman tiedostonsa. Mato pysyy
   piilossa maan alla ja jäljittää pelaajaa värähtelyn perusteella: maa tärisee,
   pinnalle ilmestyy liikkuva harjanne (mound). Kun mato iskee, se purkautuu
   maasta pelaajan lähellä, puree (raskas vahinko) ja sukeltaa takaisin.

   Mato on segmentoitu: kiilamainen pää + ympyrämäinen kita koukkuhampaineen +
   limittäisistä kivilevyistä koostuva runko. Cell-shading (toon + ääriviivat),
   kuten muutkin pinnan kappaleet. Vahingoitettavissa hakulla TAI aseella.

   Tila kulkee callbackien kautta (surface.js kytkee):
     cbs.bite(dmg)              — pelaajaan osunut purema
     cbs.burst(x,y,z,big,mat)   — pöly/sirupurske maasta (purkaus/sukellus/kuolema)
   Julkinen API: update(dt,px,pz,camera), takeDamage(amount,point),
   get tremor(), forceStrike(), reset(), dispose(). */
import * as THREE from 'three';
import { toonMat, addOutlines } from './toon.js';

const N_SEG = 11;          // pää (0) + runkosegmentit
const SEG_R = 1.15;        // pään/etusegmentin säde
const SEG_LEN = 1.9;       // segmentin pituus (limittyy hieman)
const HEAD_H = 8.5;        // kuinka korkealle pää nousee purkauksessa
const LEAN = 5.0;          // kuinka pitkälle pää kurottaa pelaajaa kohti
const TAIL_DEPTH = 7;      // hännän syvyys maan alla (kiinnityspiste)
const WRITHE = 0.5;        // sivuttainen kiemurtelu

const HP_MAX = 12;
const BITE_DMG = 0.34;     // ~3 puremaa tappaa pelaajan
const BITE_RANGE = 5.5;    // vaakaetäisyys jolla purema osuu
const STRIKE_RANGE = 55;   // tällä etäisyydellä mato uskaltautuu iskemään
const LURK_DIST = 9;       // jäljittäessä pysyttelee vähintään tämän päässä

// tilojen kestot (s)
const WARN_T = 1.15, EMERGE_T = 0.42, BITE_HOLD = 0.22, RETRACT_T = 0.75, COOL_T = 3.5, DEAD_T = 1.6, RESPAWN_T = 14;

const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(), _perp = new THREE.Vector3(), _q = new THREE.Quaternion();
const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();

function bez(p0, p1, p2, t, out){
  const u = 1 - t;
  out.set(
    u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z);
  return out;
}

export class RegolithWorm {
  constructor(scene, heightFn, cbs){
    this.scene = scene;
    this.heightFn = heightFn;
    this.cbs = cbs || {};
    this.hp = HP_MAX;
    this.state = 'cooldown';   // alkaa lepotilasta → ensimmäinen jäljitys hetken päästä
    this.t = 0;
    this.rise = 0;
    this._tremor = 0;
    this._flash = 0;
    this.huntDur = 3 + Math.random() * 3;
    // jäljityspiste maan alla + lukittu iskupiste
    this.gx = 0; this.gz = 0;
    this._strike = new THREE.Vector3();
    this._base = new THREE.Vector3();
    this._toPlayer = new THREE.Vector3(0, 0, 1);
    this._bit = false;
    this._respawn = 0;
    this._pos = []; for (let i = 0; i < N_SEG; i++) this._pos.push(new THREE.Vector3());
    this._build();
  }

  _build(){
    const g = new THREE.Group();
    this.group = g;
    // jaetut materiaalit (emissive-välähdys osumassa)
    this.bodyMat = toonMat({ color: 0x8a4230 });   // punertava kiviruho
    this.plateMat = toonMat({ color: 0x4a261c });   // tummat mineraaliharjut
    const toothMat = toonMat({ color: 0xd8c8b6 });
    this.mats = [this.bodyMat, this.plateMat];
    this.segs = [];
    for (let i = 0; i < N_SEG; i++) {
      const sg = new THREE.Group();
      const r = SEG_R * (1 - 0.5 * (i / (N_SEG - 1)));
      if (i === 0) this._buildHead(sg, r, toothMat);
      else this._buildSegment(sg, r);
      g.add(sg);
      this.segs.push({ grp: sg, r });
    }
    // tunnista raycastissa: kaikki osat → tämä entiteetti
    g.traverse(o => { if (o.isMesh) o.userData.enemy = this; });
    g.visible = false;
    this.scene.add(g);
    // maanalaisen jäljityksen merkki: pinnalle työntyvä harjanne (mound)
    this._buildMound();
  }

  _buildSegment(sg, r){
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, SEG_LEN, 9), this.bodyMat);
    sg.add(seg);
    // limittäiset kivilevyt/harjut selkäpuolelle
    for (let k = 0; k < 3; k++) {
      const a = (k - 1) * 0.7;
      const pl = new THREE.Mesh(new THREE.BoxGeometry(r * 0.5, r * 0.32, SEG_LEN * 0.7), this.plateMat);
      pl.position.set(Math.sin(a) * r * 0.7, Math.cos(a) * r * 0.7, 0);
      pl.rotation.z = -a;
      sg.add(pl);
    }
    addOutlines(sg, 0.045);
  }

  _buildHead(sg, r, toothMat){
    // kiilamainen pää (kartio, kärki = etu = +Y)
    const head = new THREE.Mesh(new THREE.ConeGeometry(r * 1.15, SEG_LEN * 2.0, 10), this.bodyMat);
    head.position.y = SEG_LEN * 0.2;
    sg.add(head);
    // selkäharjat
    for (let k = 0; k < 4; k++) {
      const a = (k - 1.5) * 0.5;
      const pl = new THREE.Mesh(new THREE.BoxGeometry(r * 0.45, r * 0.4, SEG_LEN * 0.9), this.plateMat);
      pl.position.set(Math.sin(a) * r * 0.85, Math.cos(a) * r * 0.85 - SEG_LEN * 0.2, 0);
      pl.rotation.z = -a;
      sg.add(pl);
    }
    addOutlines(sg, 0.05);   // ääriviiva ennen hampaita (hampaita ei ääriviivoiteta)
    // ympyrämäinen kita pään kärkeen (+Y)
    const mawY = SEG_LEN * 1.15;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.78, r * 0.2, 8, 16), this.plateMat);
    ring.position.y = mawY; ring.rotation.x = Math.PI / 2;   // rengas osoittaa +Y
    sg.add(ring);
    const gullet = new THREE.Mesh(new THREE.CircleGeometry(r * 0.7, 16),
      new THREE.MeshBasicMaterial({ color: 0x1a0805, side: THREE.DoubleSide }));
    gullet.position.y = mawY - r * 0.1; gullet.rotation.x = -Math.PI / 2;
    sg.add(gullet);
    // koukkuhampaat renkaan ympärille, kallistuvat sisään+eteen
    const teeth = 12;
    for (let k = 0; k < teeth; k++) {
      const a = k / teeth * Math.PI * 2;
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(r * 0.11, r * 0.6, 6), toothMat);
      tooth.position.set(Math.cos(a) * r * 0.78, mawY + r * 0.18, Math.sin(a) * r * 0.78);
      // osoita ylös+keskelle (koukku)
      tooth.lookAt(0, mawY + r * 1.1, 0);
      tooth.rotateX(Math.PI / 2);
      sg.add(tooth);
    }
  }

  _buildMound(){
    // litistetty kivikumpu joka työntyy pinnasta (jäljityksen merkki)
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 1), this.bodyMat);
    m.scale.set(1, 0.32, 1);
    m.userData.enemy = this;   // ei vahingoiteta maan alla, mutta tagi yhtenäisyyden vuoksi
    this.mound = m;
    m.visible = false;
    this.scene.add(m);
  }

  // ---- tilakone ----
  update(dt, px, pz, camera){
    this.t += dt;
    this._tremor = 0;
    const dist = Math.hypot(this.gx - px, this.gz - pz);
    switch (this.state) {
      case 'hunt': this._hunt(dt, px, pz, dist); break;
      case 'warn': this._warn(dt, px, pz); break;
      case 'emerge': this._emerge(dt, px, pz); break;
      case 'retract': this._retract(dt); break;
      case 'cooldown': this._cool(dt, px, pz); break;
      case 'dead': this._dead(dt); break;
      case 'gone': this._respawn -= dt; if (this._respawn <= 0) { this.hp = HP_MAX; this._setState('cooldown'); this.t = COOL_T - 0.5; } break;
    }
    // osumavälähdys (emissive) laantuu
    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 5);
      const e = this._flash;
      for (const m of this.mats) m.emissive.setRGB(e * 1.3, e * 0.25, e * 0.05);
    }
    this._layoutMound(dt);
    if (this.group.visible) this._layout(camera ? camera.position : null);
  }

  _setState(s){ this.state = s; this.t = 0; }

  _hunt(dt, px, pz, dist){
    // jäljitä pelaajaa maan alla, mutta pysyttele vähän etäämmällä (väijyy)
    const dx = px - this.gx, dz = pz - this.gz, d = Math.hypot(dx, dz) || 1;
    const target = Math.max(0, d - LURK_DIST);
    const step = Math.min(target, 7 * dt);
    this.gx += dx / d * step; this.gz += dz / d * step;
    this.mound.visible = true;
    // tärinä voimistuu läheisyyden mukaan
    this._tremor = 0.02 + 0.06 * Math.max(0, 1 - dist / 30);
    if (this.t > this.huntDur && dist <= STRIKE_RANGE) {
      // lukitse iskupiste pelaajan nykysijaintiin (telegraph) → kumpu ryntää sinne
      this._strike.set(px, 0, pz);
      this._setState('warn');
    }
  }

  _warn(dt, px, pz){
    // kumpu ryntää lukittuun iskupisteeseen — pelaaja ehtii väistää astumalla pois
    const k = Math.min(1, dt * 6);
    this.gx += (this._strike.x - this.gx) * k;
    this.gz += (this._strike.z - this.gz) * k;
    this.mound.visible = true;
    this._tremor = 0.12 + 0.18 * (this.t / WARN_T);
    if (this.t >= WARN_T) {
      // pohjusta purkaus iskupisteeseen
      this._base.set(this._strike.x, this.heightFn(this._strike.x, this._strike.z), this._strike.z);
      _v.set(px - this._base.x, 0, pz - this._base.z);
      if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
      this._toPlayer.copy(_v).normalize();
      this._bit = false;
      this.group.visible = true;
      this.mound.visible = false;
      if (this.cbs.burst) this.cbs.burst(this._base.x, this._base.y, this._base.z, true, this.bodyMat);
      this._setState('emerge');
    }
  }

  _emerge(dt, px, pz){
    // pää purkautuu maasta kaarella; lähellä huippua → purema
    const p = Math.min(1, this.t / EMERGE_T);
    this.rise = (1 - Math.pow(1 - p, 3)) * 1.06;   // ease-out + pieni ylitys
    this._tremor = 0.4 * (1 - p);
    if (p >= 1) {
      // pidä huipulla hetki ja pure
      if (this.t >= EMERGE_T + BITE_HOLD) { this._setState('retract'); return; }
      this._tryBite(px, pz);
    }
  }

  _tryBite(px, pz){
    if (this._bit) return;
    const hx = this._pos[0].x, hz = this._pos[0].z;
    if (Math.hypot(hx - px, hz - pz) < BITE_RANGE) {
      this._bit = true;
      if (this.cbs.bite) this.cbs.bite(BITE_DMG);
      this._tremor = 0.5;
    }
  }

  _retract(dt){
    const p = Math.min(1, this.t / RETRACT_T);
    this.rise = (1 - p) * 1.06;
    if (p > 0.5 && !this._retDust) {
      this._retDust = true;
      if (this.cbs.burst) this.cbs.burst(this._base.x, this._base.y, this._base.z, false, this.bodyMat);
    }
    if (p >= 1) {
      this.group.visible = false; this._retDust = false;
      this._setState('cooldown');
    }
  }

  _cool(dt, px, pz){
    this.mound.visible = false;
    if (this.t >= COOL_T) {
      // aloita uusi jäljitys: ilmesty kohtuuetäisyydelle pelaajan ympärille
      const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 16;
      this.gx = px + Math.cos(a) * r; this.gz = pz + Math.sin(a) * r;
      this.huntDur = 3 + Math.random() * 3;
      this._setState('hunt');
    }
  }

  _dead(dt){
    // kiemurtele alas ja vajoa
    const p = Math.min(1, this.t / DEAD_T);
    this.rise = Math.max(0, (1 - p)) * 1.06;
    this._tremor = 0.25 * (1 - p);
    if (p >= 1) {
      this.group.visible = false;
      this._respawn = RESPAWN_T;
      this._setState('gone');
    }
  }

  // ---- vahinko (hakku/ase) ----
  takeDamage(amount, point){
    if (!this.group.visible || this.state === 'dead' || this.state === 'gone') return false;
    this.hp -= amount;
    this._flash = 1;
    if (this.hp <= 0) {
      if (this.cbs.burst) {
        const pt = point || this._pos[0];
        for (let k = 0; k < 3; k++) this.cbs.burst(pt.x, pt.y, pt.z, true, this.bodyMat);
      }
      this._setState('dead');
      return true;
    }
    return false;
  }

  // ---- sijoittelu ----
  _layout(camPos){
    // Bézier-selkäranka: pää (ulkona) → kontrolli → häntä (maan alla)
    const r = this.rise;
    const P0 = _p0.set(
      this._base.x + this._toPlayer.x * LEAN * r,
      this._base.y + HEAD_H * r,
      this._base.z + this._toPlayer.z * LEAN * r);
    const P1 = _p1.set(
      this._base.x + this._toPlayer.x * LEAN * 0.25 * r,
      this._base.y + HEAD_H * 0.35 * r,
      this._base.z + this._toPlayer.z * LEAN * 0.25 * r);
    const P2 = _p2.set(this._base.x, this._base.y - TAIL_DEPTH, this._base.z);
    for (let i = 0; i < N_SEG; i++) {
      const t = i / (N_SEG - 1);
      bez(P0, P1, P2, t, this._pos[i]);
      // sivuttainen kiemurtelu (enemmän häntäpäässä, this.t:stä)
      const wob = Math.sin(this.t * 6 + i * 0.7) * WRITHE * r * t;
      _perp.set(this._toPlayer.z, 0, -this._toPlayer.x);   // vaakaperp
      this._pos[i].addScaledVector(_perp, wob);
    }
    // aseta segmentit + suuntaa pää-suuntaan
    for (let i = 0; i < N_SEG; i++) {
      const sg = this.segs[i].grp;
      sg.position.copy(this._pos[i]);
      const ahead = (i === 0) ? this._pos[0] : this._pos[i - 1];
      const behind = (i === 0) ? this._pos[1] : this._pos[i];
      _fwd.copy(ahead).sub(behind);
      if (_fwd.lengthSq() < 1e-6) _fwd.copy(_up);
      _fwd.normalize();
      _q.setFromUnitVectors(_up, _fwd);
      sg.quaternion.copy(_q);
    }
  }

  _layoutMound(dt){
    if (!this.mound.visible) return;
    const y = this.heightFn(this.gx, this.gz);
    this.mound.position.set(this.gx, y - 0.5, this.gz);   // suurin osa maan alla, harja näkyy
    const pulse = 1 + Math.sin(this.t * 9) * 0.08;
    this.mound.scale.set(pulse, 0.32 * pulse, pulse);
    this.mound.rotation.y += dt * 0.6;
  }

  get tremor(){ return this._tremor; }
  get alive(){ return this.state !== 'gone' && this.state !== 'dead'; }

  // testaus: pakota välitön isku pelaajaa kohti
  forceStrike(px, pz){
    if (this.state === 'gone' || this.state === 'dead') { this.hp = HP_MAX; }
    this._strike.set(px, 0, pz);
    this.gx = px; this.gz = pz;
    this._setState('warn');
    this.t = WARN_T - 0.05;
  }

  reset(){
    this.hp = HP_MAX;
    this.group.visible = false;
    this.mound.visible = false;
    this.rise = 0; this._flash = 0; this._respawn = 0;
    for (const m of this.mats) m.emissive.setRGB(0, 0, 0);
    this._setState('cooldown');
  }

  dispose(){
    this.scene.remove(this.group);
    this.scene.remove(this.mound);
  }
}
