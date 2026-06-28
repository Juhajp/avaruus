/* ---------------- Vihollinen: glb-malliin perustuva entiteetti ----------------
   Lataa Mixamo/glTF-mallin ja toistaa sen animaatiota AnimationMixerillä.
   API ja tilakone yhtenevät SandGolemin kanssa (drop-in surface.js:ssä):
   constructor(scene, heightFn, cbs) → update / takeDamage / reset /
   get tremor / get alive / dispose.

   Raajat ja vahinko (SAMA kuin SandGolemissa):
   - Per-osa HP (3–4 osumaa → irtoaa); raaja irrotetaan piilottamalla luunivel
     (bone.scale → 0). Mesh painottuu nivelten kautta → koko raaja katoaa.
   - Lentävä siru spawnataan irtoamispisteestä, painovoima maahan.
   - Regrow ~9 s, jalan irrotessa kaatuu, palautuu jalan kasvettua takaisin.
   - Osumakohdasta etsitään lähin nivel (luuluettelo `partBones`) → osa-tagi.
   - Pää-/vartalo-osumat eivät irrota, mutta vähentävät kokonais-HP:ta. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// vakiot — samat kuin SandGolemissa, mutta hieman kevyemmät kun ihmismuotoinen
const HP_MAX = 26;
const BITE_DMG = 0.32;
const ATTACK_RANGE = 3.2;
const SPEED = 1.4;
const EMERGE_T = 2.8, DEAD_T = 2.0, RESPAWN_T = 16;
const REGROW_T = 9;
const ATTACK_T = 1.45;

const _wp = new THREE.Vector3();

let _draco = null;
function getDraco(){
  if (_draco) return _draco;
  _draco = new DRACOLoader();
  _draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  return _draco;
}

export class GlbEnemy {
  constructor(scene, heightFn, cbs, opts){
    this.scene = scene; this.heightFn = heightFn; this.cbs = cbs || {};
    this.opts = opts || {};
    this.hp = HP_MAX;
    this.state = 'loading'; this.t = 0;
    this.gx = 0; this.gz = 0; this.facing = 0;
    this._tremor = 0; this._recoil = 0; this._respawn = 0;
    this._atkCd = 0; this._bitDone = false;
    this.fallen = false;
    this.chunks = [];
    this.bones = {};
    this.partBones = {};
    this.parts = null;
    this.mixer = null;
    this.walkAction = null;
    this.ready = false;
    this._spawnPending = false;     // ensimmäinen update kutsuu _spawn
    this._loadAsync();
  }

  async _loadAsync(){
    const url = this.opts.url || 'models/zombie.glb';
    const loader = new GLTFLoader().setDRACOLoader(getDraco());
    let gltf;
    try { gltf = await loader.loadAsync(url); }
    catch (e) { console.error('[glbEnemy] load failed:', e); return; }
    const model = gltf.scene;

    // skaalaa siten että hahmon korkeus on ~3 m (vertailukelpoinen SandGolemin kanssa)
    const box = new THREE.Box3().setFromObject(model);
    const h = (box.max.y - box.min.y) || 1;
    const targetH = this.opts.height || 2.8;
    const s = targetH / h;
    model.scale.setScalar(s);

    // varjot pois oletuksena vastaanottaen (sileä iho varjostaisi itseään matalalla auringolla)
    model.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.userData.enemy = this; }
      if (o.isBone) this.bones[o.name] = o;
      if (o.isSkinnedMesh && !this.skinned) this.skinned = o;
    });

    // animaatio (Mixamo-tyylinen yksittäinen klippi tai useita)
    if (gltf.animations && gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      const walkClip = gltf.animations.find(c => /walk|run|loco/i.test(c.name)) || gltf.animations[0];
      this.walkAction = this.mixer.clipAction(walkClip);
      this.walkAction.setLoop(THREE.LoopRepeat, Infinity);
      this.walkAction.play();
    }

    // Mixamo-nimien karkea kartoitus osa-tageiksi (regex → ensimmäinen sopiva)
    const findBone = (re) => { for (const n in this.bones) if (re.test(n)) return this.bones[n]; return null; };
    this.partBones = {
      head:  findBone(/Head$|head$/),
      torso: findBone(/Spine2|Spine1|Spine$|Chest|spine/),
      larm:  findBone(/LeftArm$|leftarm$|LeftShoulder$|left_arm/i),
      rarm:  findBone(/RightArm$|rightarm$|RightShoulder$|right_arm/i),
      lleg:  findBone(/LeftUpLeg$|LeftHip$|LeftLeg$|leftupleg$|left_upleg/i),
      rleg:  findBone(/RightUpLeg$|RightHip$|RightLeg$|rightupleg$|right_upleg/i),
    };
    // osa-rekisteri (irrotettavat: 4 raajaa; pää/vartalo eivät irtoa)
    this.parts = {
      larm: { bone: this.partBones.larm, hits: 0, detachAt: 3 + ((Math.random() < 0.5) ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: false },
      rarm: { bone: this.partBones.rarm, hits: 0, detachAt: 3 + ((Math.random() < 0.5) ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: false },
      lleg: { bone: this.partBones.lleg, hits: 0, detachAt: 3 + ((Math.random() < 0.5) ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: true },
      rleg: { bone: this.partBones.rleg, hits: 0, detachAt: 3 + ((Math.random() < 0.5) ? 0 : 1), gone: false, regrow: 0, grow: 1, leg: true },
    };

    // talleta luiden alkuasennot (palauttaakseen "attack arm" -override:n jälkeen)
    this._restRot = new Map();
    for (const k in this.partBones) {
      const b = this.partBones[k]; if (b) this._restRot.set(b, b.rotation.clone());
    }

    this.group = new THREE.Group();
    this.group.add(model);
    this.model = model;
    this.scene.add(this.group);
    this.group.visible = false;
    this.ready = true;
    this._respawn = 0.5;
    this._setState('gone');                  // ensimmäinen update kutsuu _spawn(px,pz)
  }

  _setState(s){ this.state = s; this.t = 0; }

  _spawn(px, pz){
    if (!this.ready) return;
    this.hp = HP_MAX; this.fallen = false;
    for (const k in this.parts) {
      const p = this.parts[k];
      p.gone = false; p.hits = 0; p.grow = 1; p.regrow = 0;
      if (p.bone) p.bone.scale.setScalar(1);
    }
    const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 14;
    this.gx = px + Math.cos(a) * r; this.gz = pz + Math.sin(a) * r;
    this.group.visible = true;
    this._emergeY = -2.5;
    this._setState('emerge');
  }

  // ---- tilakone ----
  update(dt, px, pz, camera){
    if (!this.ready) return;
    this.t += dt; this._tremor = 0;
    if (this._recoil > 0) this._recoil = Math.max(0, this._recoil - dt * 4);
    if (this.mixer && this.state !== 'attack') this.mixer.update(dt);
    this._regrowTick(dt);

    const dist = Math.hypot(this.gx - px, this.gz - pz);

    switch (this.state) {
      case 'emerge': this._emerge(dt, px, pz); break;
      case 'walk':   this._walk(dt, px, pz, dist); break;
      case 'attack': this._attack(dt, px, pz, dist); break;
      case 'dead':   this._dead(dt); break;
      case 'gone':   this._respawn -= dt; if (this._respawn <= 0) this._spawn(px, pz); break;
    }

    this._apply();
    this._updateChunks(dt);
  }

  _emerge(dt, px, pz){
    const p = Math.min(1, this.t / EMERGE_T);
    this._emergeY = -2.5 * (1 - p);
    this._face(px, pz, dt * 1.5);
    if (p >= 1) { this._emergeY = 0; this._setState('walk'); }
  }

  _walk(dt, px, pz, dist){
    if (this.walkAction && !this.walkAction.isRunning()) this.walkAction.play();
    if (this.walkAction) this.walkAction.timeScale = 1;
    this._face(px, pz, dt * 2.2);
    if (!this.fallen) {
      if (dist > ATTACK_RANGE) {
        const dx = px - this.gx, dz = pz - this.gz, d = Math.hypot(dx, dz) || 1;
        this.gx += dx / d * SPEED * dt;
        this.gz += dz / d * SPEED * dt;
      } else if (this._atkCd <= 0) {
        this._bitDone = false; this._setState('attack');
      }
    }
    this._atkCd = Math.max(0, this._atkCd - dt);
  }

  _attack(dt, px, pz, dist){
    this._face(px, pz, dt * 1.5);
    if (this.fallen) { this._setState('walk'); return; }
    // kävelyanimaation aika hidastetaan iskuksi (jätetään mixer "frozen" → procedural override)
    if (this.walkAction) this.walkAction.timeScale = 0.15;
    if (this.mixer) this.mixer.update(dt);

    // PROCEDURAL ARM-SWING (sama kuin SandGolem _attack):
    // hidas anticipation (kiihtyvä) → nopea snap → follow-through
    const arm = this.partBones.rarm;
    const rest = arm ? this._restRot.get(arm) : null;
    if (arm && rest) {
      const u = Math.min(1, this.t / ATTACK_T);
      let yaw;
      if (u < 0.42) { const a = u / 0.42, ae = a * a; yaw = 1.7 * ae; }
      else if (u < 0.78) { const a = (u - 0.42) / 0.36; yaw = 1.7 - 3.8 * a; }
      else { const a = (u - 0.78) / 0.22; yaw = -2.1 + 0.18 * a; }
      arm.rotation.set(rest.x - 1.35, rest.y + yaw, rest.z);
    }

    // isku osuu ~55 % swingistä
    if (!this._bitDone && this.t >= ATTACK_T * 0.55) {
      this._bitDone = true;
      if (dist < ATTACK_RANGE + 0.8 && this.cbs.bite) {
        this.cbs.bite(BITE_DMG);
        this._tremor = 0.13;
      }
    }
    if (this.t >= ATTACK_T) {
      this._atkCd = 1.2;
      if (arm && rest) arm.rotation.copy(rest);   // palauta lepoasento
      this._setState('walk');
    }
  }

  _dead(dt){
    const p = Math.min(1, this.t / DEAD_T);
    this._sink = -2.0 * p;
    this.group.scale.setScalar(Math.max(0.01, 1 - p * 0.4));
    if (p > 0.1 && Math.random() < dt * 6 && this.cbs.burst) {
      this.group.getWorldPosition(_wp);
      this.cbs.burst(_wp.x + (Math.random() - 0.5) * 1.2, _wp.y + Math.random() * 1.5, _wp.z + (Math.random() - 0.5) * 1.2, false, null);
    }
    if (p >= 1) {
      this.group.visible = false;
      this.group.scale.setScalar(1);
      this._sink = 0;
      this._respawn = RESPAWN_T;
      this._setState('gone');
    }
  }

  _face(px, pz, rate){
    const want = Math.atan2(px - this.gx, pz - this.gz);
    let d = want - this.facing;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.facing += d * Math.min(1, rate);
  }

  _apply(){
    if (!this.ready) return;
    const gy = this.heightFn ? this.heightFn(this.gx, this.gz) : 0;
    this.group.position.set(this.gx, gy + (this._emergeY || 0) + (this._sink || 0), this.gz);
    // kaatuminen: kallista runko maahan, älä uppoa
    const yaw = this.facing;
    const tilt = this.fallen ? Math.PI / 2 * 0.95 : 0;
    this.group.rotation.set(tilt, yaw, 0);
  }

  // ---- vahinko ----
  takeDamage(amount, hit){
    if (!this.ready || !this.group.visible) return false;
    if (this.state === 'dead' || this.state === 'gone' || this.state === 'cooldown') return false;
    const part = this._findHitPart(hit && hit.point);
    this._recoil = 1;
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

  // löytää lähimmän nivelen osumapisteestä → osa-tagi
  _findHitPart(worldPoint){
    if (!worldPoint) return null;
    let best = null, bestD = Infinity;
    const wp = new THREE.Vector3();
    for (const k in this.partBones) {
      const b = this.partBones[k]; if (!b) continue;
      b.getWorldPosition(wp);
      const d = wp.distanceTo(worldPoint);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  _detach(key){
    const p = this.parts[key]; if (!p || p.gone || !p.bone) return;
    p.gone = true; p.regrow = REGROW_T;
    p.bone.getWorldPosition(_wp);
    p.bone.scale.setScalar(0.001);              // piilota nivelpuusto → mesh painottuu pisteeseen
    if (this.cbs.burst) for (let k = 0; k < 6; k++)
      this.cbs.burst(_wp.x + (Math.random() - 0.5) * 0.6, _wp.y + (Math.random() - 0.5) * 0.6, _wp.z + (Math.random() - 0.5) * 0.6, k < 2, null);
    this._spawnChunk(_wp, p.leg);
    if (p.leg) this.fallen = true;
  }

  _regrowTick(dt){
    for (const k in this.parts) {
      const p = this.parts[k];
      if (p.gone) {
        p.regrow -= dt;
        if (p.regrow <= 0) {
          p.gone = false; p.hits = 0; p.grow = 0;
          if (p.bone) p.bone.scale.setScalar(0.001);   // alkuun pieni, kasvaa
        }
      } else if (p.grow < 1) {
        p.grow = Math.min(1, p.grow + dt / 1.5);
        if (p.bone) p.bone.scale.setScalar(p.grow);
      }
    }
    if (this.fallen && !this.parts.lleg.gone && !this.parts.rleg.gone) this.fallen = false;
  }

  _spawnChunk(worldPos, isLeg){
    const geo = new THREE.CapsuleGeometry(isLeg ? 0.18 : 0.14, isLeg ? 0.5 : 0.45, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a3a2e, roughness: 0.85 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(worldPos); m.castShadow = true;
    this.scene.add(m);
    this.chunks.push({
      m,
      vel: new THREE.Vector3((Math.random() - 0.5) * 3.5, 2 + Math.random() * 3, (Math.random() - 0.5) * 3.5),
      spin: new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7),
      t: 0, max: 2.6
    });
  }

  _updateChunks(dt){
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]; c.t += dt;
      c.vel.y -= 12 * dt; c.m.position.addScaledVector(c.vel, dt);
      const gy = this.heightFn ? this.heightFn(c.m.position.x, c.m.position.z) : 0;
      if (c.m.position.y < gy + 0.15) { c.m.position.y = gy + 0.15; c.vel.set(0, 0, 0); }
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt; c.m.rotation.z += c.spin.z * dt;
      if (c.t > c.max) {
        const s = Math.max(0.01, 1 - (c.t - c.max) / 0.6);
        c.m.scale.setScalar(s);
        if (s <= 0.02) { this.scene.remove(c.m); c.m.geometry.dispose(); c.m.material.dispose(); this.chunks.splice(i, 1); }
      }
    }
  }

  _die(){ this.hp = 0; this._setState('dead'); this._sink = 0; }

  get tremor(){ return this._tremor; }
  get alive(){ return this.ready && this.state !== 'gone' && this.state !== 'dead' && this.state !== 'loading'; }

  reset(){
    if (this.group) { this.group.visible = false; this.group.scale.setScalar(1); }
    for (const c of this.chunks) { this.scene.remove(c.m); c.m.geometry.dispose(); c.m.material.dispose(); }
    this.chunks = [];
    this._respawn = RESPAWN_T * 0.4;
    if (this.ready) this._setState('gone');
    this.fallen = false;
  }

  dispose(){
    if (this.group) this.scene.remove(this.group);
    for (const c of this.chunks) this.scene.remove(c.m);
    this.chunks = [];
  }
}
