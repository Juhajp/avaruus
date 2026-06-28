/* ---------------- Vihollinen: glb-malliin perustuva entiteetti ----------------
   Lataa Mixamo/glTF-mallin ja toistaa sen animaatiota AnimationMixerillä.
   API yhtenee SandGolemin kanssa (drop-in surface.js:ssä): constructor / update
   / takeDamage / reset / get tremor / get alive / dispose.

   Suunnitteluvalinnat (ero SandGolemiin):
   - EI raajojen irrotusta — kestää vain kokonais-HP:tä
   - Osumassa VEREN ROISKE iskukohtaan (punaiset hiukkaset, painovoima)
   - Kuolemassa kaatuu selälleen MAAHAN ja JÄÄ siihen
   - LIIKE AJETAAN JALAN ANIMAATIOSTA (foot-driven locomotion):
     joka ruutu lasketaan jalan paikallinen z-muutos kehyksen yli; runko etenee
     maailmassa sen verran että planted-jalan world-positio pysyy paikallaan
     → ei liu'utusta riippumatta animaation luonnollisesta tahdista.
   - SLOPE-IK: kummankin jalan world-Y verrataan maaston korkeuteen niiden
     vaaka-positiossa; runkoa nostetaan pystysuoraan että alempi jalka koskee
     juuri maata → ei klippausta eikä leijumista rinteillä. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const HP_MAX = 22;
const BITE_DMG = 0.32;
const ATTACK_RANGE = 3.0;
const ANIM_TIMESCALE = 0.18;         // hidasta zombi-tahti (klipin luontainen ~8.4 m/s)
const EMERGE_T = 2.5;
const DEAD_T = 1.2;                  // kaatumisen kesto (selälleen)
const ATTACK_T = 1.4;
const FOOT_OFFSET = 0.05;            // jalka koskettaa maata kun bone on tämä metri maan päällä
const BLOOD_POOL = 64;               // aktiivisia veripisaroita kerralla
const TARGET_HEIGHT = 2.8;           // skaalataan glb tähän korkeuteen (m)

let _draco = null;
function getDraco(){
  if (_draco) return _draco;
  _draco = new DRACOLoader();
  _draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  return _draco;
}

const _wp = new THREE.Vector3();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _bbox = new THREE.Box3();

export class GlbEnemy {
  constructor(scene, heightFn, cbs, opts){
    this.scene = scene; this.heightFn = heightFn; this.cbs = cbs || {};
    this.opts = opts || {};
    this.hp = HP_MAX;
    this.state = 'loading'; this.t = 0;
    this.gx = 0; this.gz = 0; this.facing = 0;
    this._tremor = 0; this._recoil = 0; this._respawn = 0;
    this._atkCd = 0; this._bitDone = false;
    this._dieAngle = 0;
    this.fallen = false;
    this.bones = {};
    this.partBones = {};
    this.mixer = null;
    this.walkAction = null;
    this.lFootBone = null;
    this.rFootBone = null;
    this.hipsBone = null;
    this._restHip = null;
    this._lastHip = null;                            // root motion -tracker (edell. ruudun hipin lokaali XYZ)
    this._animDx = 0; this._animDz = 0;              // per-ruudun rotaation lokaali XZ-delta
    this.bloods = [];
    this.ready = false;
    this._loadAsync();
  }

  async _loadAsync(){
    const url = this.opts.url || 'models/zombie.glb';
    const loader = new GLTFLoader().setDRACOLoader(getDraco());
    let gltf;
    try { gltf = await loader.loadAsync(url); }
    catch (e) { console.error('[glbEnemy] load failed:', e); return; }
    const model = gltf.scene;

    // skaalaa siten että hahmo on ~TARGET_HEIGHT korkea
    const box = new THREE.Box3().setFromObject(model);
    const h = (box.max.y - box.min.y) || 1;
    const s = (this.opts.height || TARGET_HEIGHT) / h;
    model.scale.setScalar(s);

    model.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.userData.enemy = this; }
      if (o.isBone) this.bones[o.name] = o;
      if (o.isSkinnedMesh && !this.skinned) this.skinned = o;
    });

    if (gltf.animations && gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      const walkClip = gltf.animations.find(c => /walk|run|loco/i.test(c.name)) || gltf.animations[0];
      this.walkAction = this.mixer.clipAction(walkClip);
      this.walkAction.setLoop(THREE.LoopRepeat, Infinity);
      this.walkAction.timeScale = ANIM_TIMESCALE;
      this.walkAction.play();
    }

    // nivelten haku — pieni säilytetään raycast-osumakuvauksia varten
    const findBone = (re) => { for (const n in this.bones) if (re.test(n)) return this.bones[n]; return null; };
    this.partBones = {
      head:  findBone(/Head$|head$/i),
      torso: findBone(/Spine2|Spine1|Spine$|Chest|spine/i),
      larm:  findBone(/LeftShoulder$|LeftArm$|left_arm/i),
      rarm:  findBone(/RightShoulder$|RightArm$|right_arm/i),
    };
    this.lFootBone = findBone(/LeftFoot$|leftfoot/i) || findBone(/LeftAnkle/i) || findBone(/LeftToe/i);
    this.rFootBone = findBone(/RightFoot$|rightfoot/i) || findBone(/RightAnkle/i) || findBone(/RightToe/i);
    // Hips (root) bone — käsittelee root motion -animaation translaation
    this.hipsBone = findBone(/^mixamorigHips$/i) || findBone(/Hips$/i) || findBone(/Root$/i);
    if (this.hipsBone) {
      this._restHip = this.hipsBone.position.clone();   // lepoasento (animaation track-baseline)
    }

    // talleta luiden alkuasennot (attack arm-swing override palauttaa lepoasentoon)
    this._restRot = new Map();
    for (const k in this.partBones) {
      const b = this.partBones[k]; if (b) this._restRot.set(b, b.rotation.clone());
    }

    // veriroiskeen partikkelipooli (THREE.Points olisi GPU-tehokkaampi, mutta tämä riittää)
    this._initBlood();

    this.group = new THREE.Group();
    this.group.add(model);
    this.model = model;
    this.scene.add(this.group);
    this.group.visible = false;
    this.ready = true;
    this._respawn = 0.5;
    this._setState('gone');
  }

  _initBlood(){
    // verihiukkasten pooli — pienet punaiset pallot, additiivinen alpha tippumiseen ei tarvita
    this.bloods = [];
    const geo = new THREE.SphereGeometry(0.04, 4, 3);
    const mat = new THREE.MeshBasicMaterial({ color: 0x8a0a0a });
    for (let i = 0; i < BLOOD_POOL; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.castShadow = false;
      this.scene.add(m);
      this.bloods.push({ m, vel: new THREE.Vector3(), life: 0, max: 0 });
    }
    this._bloodHead = 0;
  }

  _setState(s){ this.state = s; this.t = 0; }

  _spawn(px, pz){
    if (!this.ready) return;
    this.hp = HP_MAX; this.fallen = false; this._dieAngle = 0;
    const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 14;
    this.gx = px + Math.cos(a) * r; this.gz = pz + Math.sin(a) * r;
    this.group.visible = true;
    this.group.scale.setScalar(1);
    this._emergeY = -2.5;
    this._lastHip = null; this._animDx = 0; this._animDz = 0;
    this._setState('emerge');
  }

  update(dt, px, pz, camera){
    if (!this.ready) return;
    this.t += dt; this._tremor = 0;
    if (this._recoil > 0) this._recoil = Math.max(0, this._recoil - dt * 4);
    // animaatio — paitsi kuoltuna jossa pose jäätyy
    if (this.mixer && this.state !== 'dead') {
      this.mixer.update(dt);
      // ---- ROOT MOTION: tämä klippi animoi Hipsin eteenpäin (translaatio
      // baseline-koordinaatistossa). Otetaan delta talteen, sitten resetoidaan
      // hipin XZ-positio lepoasentoon → näkyvä hahmo pysyy paikallaan body-framessa
      // ja delta käytetään liikuttamaan ryhmää maailmassa.
      if (this.hipsBone && this._restHip) {
        const cur = this.hipsBone.position;
        if (this._lastHip == null) {
          this._lastHip = cur.clone();
          this._animDx = 0; this._animDz = 0;
        } else {
          const dx = cur.x - this._lastHip.x;
          const dz = cur.z - this._lastHip.z;
          this._lastHip.set(cur.x, cur.y, cur.z);
          // diskontinuiteetin (klipin loopin sauma) kapaus
          if (Math.abs(dx) > 2 || Math.abs(dz) > 2) { this._animDx = 0; this._animDz = 0; }
          else { this._animDx = dx; this._animDz = dz; }
        }
        // resetoi hipin XZ lepoasentoon — näkyvä hahmo pysyy body-keskellä
        cur.x = this._restHip.x;
        cur.z = this._restHip.z;
      }
    }

    const dist = Math.hypot(this.gx - px, this.gz - pz);
    switch (this.state) {
      case 'emerge': this._emerge(dt, px, pz); break;
      case 'walk':   this._walk(dt, px, pz, dist); break;
      case 'attack': this._attack(dt, px, pz, dist); break;
      case 'dead':   this._dead(dt); break;
      case 'gone':   this._respawn -= dt; if (this._respawn <= 0) this._spawn(px, pz); break;
    }

    this._apply();
    this._updateBlood(dt);
  }

  _emerge(dt, px, pz){
    const p = Math.min(1, this.t / EMERGE_T);
    this._emergeY = -2.5 * (1 - p);
    this._face(px, pz, dt * 1.5);
    if (p >= 1) { this._emergeY = 0; this._setState('walk'); this._lfz_prev = null; this._rfz_prev = null; }
  }

  _walk(dt, px, pz, dist){
    if (this.walkAction && !this.walkAction.isRunning()) this.walkAction.play();
    this._face(px, pz, dt * 2.2);
    if (this.fallen) return;
    if (dist > ATTACK_RANGE) {
      // ---- ROOT MOTION -POHJAINEN LOCOMOTION ----
      // Hipsin per-ruudun delta (body-frame) muunnetaan world-suuntaan facingin
      // mukaan ja sovelletaan gx/gz:ään. Tämä SYNKKAA TÄYDELLISESTI animaation
      // kanssa: jalat eivät liu'u koska runko etenee tarkalleen sen verran kuin
      // animaatio "kävelee" eteenpäin.
      const ms = this.model.scale.x;
      const bx = this._animDx * ms, bz = this._animDz * ms;
      const cosF = Math.cos(this.facing), sinF = Math.sin(this.facing);
      this.gx += bx * cosF + bz * sinF;
      this.gz += -bx * sinF + bz * cosF;
    } else if (this._atkCd <= 0) {
      this._bitDone = false; this._setState('attack');
    }
    this._atkCd = Math.max(0, this._atkCd - dt);
  }

  _attack(dt, px, pz, dist){
    this._face(px, pz, dt * 1.5);
    if (this.fallen) { this._setState('walk'); return; }
    if (this.walkAction) this.walkAction.timeScale = ANIM_TIMESCALE * 0.15;
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
    if (!this._bitDone && this.t >= ATTACK_T * 0.55) {
      this._bitDone = true;
      if (dist < ATTACK_RANGE + 0.8 && this.cbs.bite) {
        this.cbs.bite(BITE_DMG); this._tremor = 0.13;
      }
    }
    if (this.t >= ATTACK_T) {
      this._atkCd = 1.2;
      if (arm && rest) arm.rotation.copy(rest);
      if (this.walkAction) this.walkAction.timeScale = ANIM_TIMESCALE;
      this._lfz_prev = null; this._rfz_prev = null;   // resetoi tracker
      this._setState('walk');
    }
  }

  _dead(dt){
    // KUOLEMA: kaatuu selälleen ja jää ikuisesti maahan
    if (this._dieAngle < Math.PI / 2 * 0.95) {
      this._dieAngle = Math.min(Math.PI / 2 * 0.95, this._dieAngle + dt * 2.2);
    }
    // EI gone-tilaan siirtymistä — ruumis jää näkyviin
  }

  _face(px, pz, rate){
    const want = Math.atan2(px - this.gx, pz - this.gz);
    let d = want - this.facing;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.facing += d * Math.min(1, rate);
  }

  _apply(){
    if (!this.ready || !this.group) return;
    const h = this.heightFn;
    const gy = h ? h(this.gx, this.gz) : 0;
    this.group.position.set(this.gx, gy + (this._emergeY || 0), this.gz);
    const yaw = this.facing;
    // KUOLEMA: kallista selälleen (-X-akselin ympäri taakse). Lisäksi maaston normaalin
    // mukainen kallistus tuntuu epämääräiseltä → ruumis vain selällään yawin suuntaan.
    if (this.state === 'dead') {
      this.group.rotation.set(-this._dieAngle, yaw, 0);
    } else {
      this.group.rotation.set(0, yaw, 0);
    }

    // ---- MAA-IK: bbox.min.y on mallin todellinen alapinta (jalkojen alapuoli) ----
    // Ei käytetä foot-bonejen worldposia: tässä riggissä foot-bonen pivot on
    // lantion korkeudella (kummallinen mixamo-binding), skin-painot tekevät
    // jalan näkymästä oikean. bbox.min.y on alapisteen tosi paikka maailmassa.
    if (h && (this.state === 'walk' || this.state === 'attack' || this.state === 'emerge' || this.state === 'dead')) {
      this.group.updateMatrixWorld(true);
      _bbox.setFromObject(this.model);
      const bottomY = _bbox.min.y;
      // näytteistä maasto bbox-keskuksen alta (rinteet huomioiden alemman jalan kohdalla)
      _bbox.getCenter(_v3);
      const terr = h(_v3.x, _v3.z);
      const adj = (terr + FOOT_OFFSET) - bottomY;
      this.group.position.y += adj;
    }
  }

  // ---- vahinko + VERIROISKE ----
  takeDamage(amount, hit){
    if (!this.ready || !this.group.visible) return false;
    if (this.state === 'dead' || this.state === 'gone' || this.state === 'loading') return false;
    this._recoil = 1;
    this._tremor = 0.05;
    this.hp -= amount;
    if (hit && hit.point) this._spawnBlood(hit.point);
    if (this.hp <= 0) { this._die(); return true; }
    return false;
  }

  _spawnBlood(point){
    if (!this.bloods.length) return;
    const N = 8 + (Math.random() * 4 | 0);
    for (let k = 0; k < N; k++) {
      const i = this._bloodHead; this._bloodHead = (this._bloodHead + 1) % this.bloods.length;
      const b = this.bloods[i];
      b.m.position.copy(point);
      b.m.visible = true;
      b.vel.set(
        (Math.random() - 0.5) * 4,
        1.5 + Math.random() * 2,
        (Math.random() - 0.5) * 4
      );
      b.life = b.max = 0.6 + Math.random() * 0.4;
      const sc = 0.7 + Math.random() * 0.6;
      b.m.scale.setScalar(sc);
    }
  }

  _updateBlood(dt){
    for (const b of this.bloods) {
      if (b.life <= 0) { if (b.m.visible) b.m.visible = false; continue; }
      b.life -= dt;
      if (b.life <= 0) { b.m.visible = false; continue; }
      b.vel.y -= 18 * dt;
      b.m.position.addScaledVector(b.vel, dt);
      const gy = this.heightFn ? this.heightFn(b.m.position.x, b.m.position.z) : 0;
      if (b.m.position.y < gy + 0.02) { b.m.position.y = gy + 0.02; b.vel.set(0, 0, 0); }
    }
  }

  _die(){
    this.hp = 0;
    this._dieAngle = 0;
    this._setState('dead');
    if (this.walkAction) this.walkAction.stop();
  }

  get tremor(){ return this._tremor; }
  get alive(){ return this.ready && this.state !== 'gone' && this.state !== 'dead' && this.state !== 'loading'; }

  reset(){
    if (this.group) { this.group.visible = false; this.group.scale.setScalar(1); this.group.rotation.set(0, 0, 0); }
    for (const b of this.bloods) { b.m.visible = false; b.life = 0; }
    this._respawn = 1.0;
    this._lfz_prev = null; this._rfz_prev = null;
    if (this.ready) this._setState('gone');
    this.fallen = false; this._dieAngle = 0;
    this.hp = HP_MAX;
  }

  dispose(){
    if (this.group) this.scene.remove(this.group);
    for (const b of this.bloods) this.scene.remove(b.m);
    this.bloods = [];
  }
}
