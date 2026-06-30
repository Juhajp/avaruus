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
import { expandGeo } from './toon.js';

const HP_MAX = 22;
const BITE_DMG = 0.32;
const ATTACK_RANGE = 3.0;
const ANIM_TIMESCALE = 1.2;          // zombi-vauhti (~2 m/s, kohtuullinen brisk walk)
const EMERGE_T = 2.5;
const DEAD_T = 1.2;                  // kaatumisen kesto (selälleen)
const ATTACK_T = 1.4;
const FOOT_OFFSET = 0.05;            // jalka koskettaa maata kun bone on tämä metri maan päällä
const BLOOD_POOL = 200;              // aktiivisia veripisaroita kerralla (tiheämpi sumu)
const TARGET_HEIGHT = 2.8;           // skaalataan glb tähän korkeuteen (m)
const HP_BAR_W = 1.0;                // HP-palkin leveys (m, world-koordinaateissa)
const HP_BAR_H = 0.10;
const HP_BAR_OFFSET = 0.35;          // bbox.max.y:stä ylöspäin
const RECOIL_KICK = 0.65;            // takanyykähdyksen amplitudi (m) täydellä _recoililla
const RECOIL_LIFT = 0.18;            // pieni ylösnyykähdys (m) täydellä _recoililla
const RECOIL_DECAY_RATE = 1.8;       // _recoil → 0 ~0.55 s (näkyvämpi)
const RECOIL_WALK_SLOW = 0.85;       // walkAction.timeScale *= (1 - _recoil*tämä) → täydellä recoililla 15% nopeudesta
const TWITCH_DECAY = 0.55;           // luu-nykäyksen kesto (s) ennen lerppausta nollaan
const HEAD_DMG_MULT = 2.2;           // pääosumalle ylimääräinen vahinkokerroin
const OUTLINE_THICKNESS = 0.024;     // ääriviivan paksuus maailmametreinä (cell-shade)

// Per-osuma-aluetiltit: kun osumakohta on lähinnä tämän luun keskipistettä,
// kyseinen luu saa lyhyen rotaation. Euler-kulmat kokeellisia Mixamo-konventiolla.
// boneKey viittaa this._deathBones-mapin avaimeen.
// Per-osa-alueen twitchin amplitudi radiaaneina; rotaatioakseli lasketaan
// dynaamisesti luodin suunnasta (takeDamage). Bone-tipin Y-akseli kääntyy kohti
// luodin world-suuntaa → osuma-alue nykäisee aina luodin liikesuuntaan.
const PART_TWITCH = {
  head:  { boneKey: 'head',  mag: 1.35 },
  torso: { boneKey: 'spine', mag: 0.80 },
  larm:  { boneKey: 'larmU', mag: 1.50 },
  rarm:  { boneKey: 'rarmU', mag: 1.50 },
  lleg:  { boneKey: 'luplg', mag: 1.25 },
  rleg:  { boneKey: 'ruplg', mag: 1.25 },
};

// Osuma-alueen luut: kun osuma kirjautuu, etsitään lähin näistä luista
// (world-positioiden L2-etäisyys hit-pisteeseen) → robusti aluetunnistus
// ilman päällekkäisiä laatikkokuvuja, ei "miss"-tilanteita.
const PART_REGIONS = ['head', 'torso', 'larm', 'rarm', 'lleg', 'rleg'];

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
const _worldUp = new THREE.Vector3(0, 1, 0);
const _qTilt = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qLocal = new THREE.Quaternion();
const _vPos = new THREE.Vector3();
const _vNormal = new THREE.Vector3();
const _qTarget = new THREE.Quaternion();
const _qFinal = new THREE.Quaternion();
const _eulerTmp = new THREE.Euler();
const _tiltMat = new THREE.Matrix4();
const _qIdentity = new THREE.Quaternion();
const _vBullet = new THREE.Vector3();

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
    this._twitches = new Map();      // bone → { ex, ey, ez, age } — osumakohtainen luu-nykäys
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

    // Cell-shade-ääriviiva: jokaiselle SkinnedMeshille käänteinen kuori (BackSide)
    // jonka verteksit työnnetään hitsattuja normaaleja pitkin ulos. Ääriviiva
    // itse on SkinnedMesh sidottuna samaan luurankoon → seuraa animaatiota.
    // OUTLINE_THICKNESS on maailmametreinä; jaetaan model.scale.x:llä jotta
    // expansio on geometrian lokaalissa avaruudessa oikein.
    const outlineThick = OUTLINE_THICKNESS / s;
    const skinned = [];
    model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
    for (const sm of skinned) {
      if (!sm.geometry.attributes.normal) continue;
      const og = expandGeo(sm.geometry, outlineThick);
      const om = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
      const outline = new THREE.SkinnedMesh(og, om);
      outline.bind(sm.skeleton, sm.bindMatrix);
      outline.castShadow = false; outline.receiveShadow = false;
      outline.frustumCulled = false;          // sama kuin alkuperäisen — animaatio voi venyttää bbox:n ulos
      sm.parent.add(outline);
    }

    if (gltf.animations && gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      const walkClip = gltf.animations.find(c => /walk|run|loco/i.test(c.name)) || gltf.animations[0];
      this.walkAction = this.mixer.clipAction(walkClip);
      this.walkAction.setLoop(THREE.LoopRepeat, Infinity);
      this.walkAction.timeScale = ANIM_TIMESCALE;
      this.walkAction.play();
    }

    // Kuolema- ja hyökkäysanimaatiot erillisistä glb:istä — sama Mixamo-luuranko,
    // joten klipit sitoutuvat mainin mixeriin nimien perusteella. Ladataan
    // asynkronisesti; jos ei ehdi, _die() jähmettää ja _attack() käyttää
    // proseduraalista olkapään heilautusta varalla.
    this._loadDeath();
    this._loadAttack();

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

    // Kuoleman lerp-luut: pää/niska/selkä + ylä- ja alaraajojen luut. Kerää
    // REST-quaterniot (mixer.update():a ei vielä kutsuttu → bonet bind-asennossa).
    // Kuolemassa lerppataan animoidusta poseesta tähän ragdoll-tyyliseen relaxed-
    // asentoon → raajat tippuvat luonnollisesti painovoiman vaikutuksesta.
    this._deathBones = {
      head:   findBone(/Head$/i),
      neck:   findBone(/Neck$/i),
      spine:  findBone(/Spine$/i) || findBone(/Spine1$/i),
      spine2: findBone(/Spine2$/i),
      larmU:  findBone(/LeftArm$/i),
      rarmU:  findBone(/RightArm$/i),
      larmF:  findBone(/LeftForeArm$/i),
      rarmF:  findBone(/RightForeArm$/i),
      luplg:  findBone(/LeftUpLeg$/i),
      ruplg:  findBone(/RightUpLeg$/i),
      lleg:   findBone(/LeftLeg$/i),
      rleg:   findBone(/RightLeg$/i),
    };
    this._restRotQ = new Map();
    for (const k in this._deathBones) {
      const b = this._deathBones[k];
      if (b) this._restRotQ.set(b, b.quaternion.clone());
    }

    // Maaston tarkistusluut "max-clearance"-noston pohjaksi:
    // - Walk: jalat + alaraajat (polvet). Jyrkillä ylämäillä polvi voi osua
    //   maahan ennen jalkaa → polven sample estää clippingin.
    // - Dead: koko vartalo (pää, niska, selkä, kädet, jalat, polvet). Death-
    //   animaatio kääntää bonet vapaasti; Box3.setFromObject käyttää SkinnedMeshin
    //   bind-pose-bbox:ia eikä peittäisi animoitua vartaloa. Per-bone-sample
    //   takaa että ruumiin alin piste on aina maan päällä.
    this._groundBonesWalk = [];
    if (this.lFootBone) this._groundBonesWalk.push(this.lFootBone);
    if (this.rFootBone) this._groundBonesWalk.push(this.rFootBone);
    if (this._deathBones.lleg) this._groundBonesWalk.push(this._deathBones.lleg);
    if (this._deathBones.rleg) this._groundBonesWalk.push(this._deathBones.rleg);
    this._groundBonesDead = [];
    for (const k in this._deathBones) {
      const b = this._deathBones[k];
      if (b) this._groundBonesDead.push(b);
    }
    if (this.lFootBone) this._groundBonesDead.push(this.lFootBone);
    if (this.rFootBone) this._groundBonesDead.push(this.rFootBone);

    // veriroiskeen partikkelipooli (THREE.Points olisi GPU-tehokkaampi, mutta tämä riittää)
    this._initBlood();

    this.group = new THREE.Group();
    this.group.add(model);
    this.model = model;
    this.scene.add(this.group);
    this.group.visible = false;

    // Yksi näkymätön bbox-osumavolyymi: kaikki osumat tulevat tähän. Osuma-
    // alueen tunnistus tehdään hit-pisteen perusteella _triggerTwitchissä
    // (etsii lähimmän PART_REGIONS-luun) → ei päällekkäisten kuvujen virheitä.
    const hitMat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0, depthWrite: false });
    this.hitVol = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hitMat);
    this.hitVol.userData.enemy = this;
    this.hitVol.castShadow = false; this.hitVol.receiveShadow = false;
    this.hitVol.visible = false;
    this.scene.add(this.hitVol);

    // HP-palkki: tumma tausta + värimuuttuva etupalkki, billboardattu kameran
    // suuntaan. Sijoitetaan joka ruutu mallin bbox.max.y:n yläpuolelle.
    // fg-geometrian pivot vasempaan reunaan → kutistuu oikealta vasemmalle HP:n
    // mukana. depthTest:false → palkki näkyy aina vihollisen päällä.
    const hpBgGeo = new THREE.PlaneGeometry(1, 1);
    const hpFgGeo = new THREE.PlaneGeometry(1, 1);
    hpFgGeo.translate(0.5, 0, 0);
    this.hpBarBg = new THREE.Mesh(hpBgGeo,
      new THREE.MeshBasicMaterial({ color: 0x0a0a0c, transparent: true, opacity: 0.72, depthWrite: false, depthTest: false }));
    this.hpBarFg = new THREE.Mesh(hpFgGeo,
      new THREE.MeshBasicMaterial({ color: 0x33cc33, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }));
    this.hpBarBg.renderOrder = 100; this.hpBarFg.renderOrder = 101;
    this.hpBarFg.position.set(-HP_BAR_W * 0.5, 0, 0.001);
    this.hpBar = new THREE.Group();
    this.hpBar.add(this.hpBarBg, this.hpBarFg);
    this.hpBar.visible = false;
    this.scene.add(this.hpBar);

    this.ready = true;
    this._respawn = 0.5;
    this._setState('gone');
  }

  async _loadDeath(){
    try {
      const loader = new GLTFLoader().setDRACOLoader(getDraco());
      const gltf = await loader.loadAsync(this.opts.deathUrl || 'models/zombie_death_small.glb');
      if (!this.mixer || !gltf.animations || !gltf.animations.length) return;
      const clip = gltf.animations[0];
      this.deathAction = this.mixer.clipAction(clip);
      this.deathAction.setLoop(THREE.LoopOnce, 1);
      this.deathAction.clampWhenFinished = true;   // viim. ruutu jää näkyviin → ruumis maassa
    } catch (e) { console.warn('[glbEnemy] death anim failed:', e); }
  }

  async _loadAttack(){
    try {
      const loader = new GLTFLoader().setDRACOLoader(getDraco());
      const gltf = await loader.loadAsync(this.opts.attackUrl || 'models/zombie_attack_small.glb');
      if (!this.mixer || !gltf.animations || !gltf.animations.length) return;
      const clip = gltf.animations[0];
      this.attackAction = this.mixer.clipAction(clip);
      this.attackAction.setLoop(THREE.LoopOnce, 1);
      this.attackAction.clampWhenFinished = false;
      this.attackDur = clip.duration;
    } catch (e) { console.warn('[glbEnemy] attack anim failed:', e); }
  }

  _initBlood(){
    // verihiukkasten pooli — pienet punaiset pallot. Pienempi geometria + suurempi
    // pooli → sumumainen veriroiske jossa monta hienovaraista pisaraa.
    this.bloods = [];
    const geo = new THREE.SphereGeometry(0.018, 4, 3);
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
    this.hp = HP_MAX; this.fallen = false;
    this._deadT = 0;
    const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 14;
    this.gx = px + Math.cos(a) * r; this.gz = pz + Math.sin(a) * r;
    this.group.visible = true;
    this.group.scale.setScalar(1);
    this._emergeY = -2.5;
    this._lastHip = null; this._animDx = 0; this._animDz = 0;
    // Reset animaatiotilat: edellisen kuoleman jälkeen walkAction täytyy ajaa puhtaalta
    if (this.deathAction)  { this.deathAction.stop(); this.deathAction.reset(); }
    if (this.attackAction) { this.attackAction.stop(); this.attackAction.reset(); }
    this._attackStarted = false;
    if (this.walkAction)   { this.walkAction.reset(); this.walkAction.play(); }
    this._setState('emerge');
  }

  update(dt, px, pz, camera){
    if (!this.ready) return;
    this.t += dt; this._tremor = 0;
    this._lastPx = px; this._lastPz = pz; this._camera = camera;
    if (this._recoil > 0) this._recoil = Math.max(0, this._recoil - dt * RECOIL_DECAY_RATE);
    // animaatio: walk/attack/emerge ajaa walkActionia, dead ajaa deathActionia
    if (this.mixer) {
      this.mixer.update(dt);
      if (this.hipsBone && this._restHip) {
        const cur = this.hipsBone.position;
        // Walk-locomotion root motion -kerääminen (vain elossa)
        if (this.state !== 'dead' && this.walkAction) {
          const curT = this.walkAction.time;
          const looped = (this._lastMixerT != null) && (curT < this._lastMixerT - 0.1);
          if (this._lastHip == null || looped) {
            if (this._lastHip == null) this._lastHip = cur.clone();
            else this._lastHip.set(cur.x, cur.y, cur.z);
            this._animDx = 0; this._animDz = 0;
          } else {
            this._animDx = cur.x - this._lastHip.x;
            this._animDz = cur.z - this._lastHip.z;
            this._lastHip.set(cur.x, cur.y, cur.z);
          }
          this._lastMixerT = curT;
        }
        // Aina pinnaa hipin XZ lepoasentoon → vihollinen pysyy gx,gz:ssä myös
        // death-animaation aikana (kuoleman pose hoituu bone-rotaatioilla; Y voi
        // muuttua → ruumis voi vajota maahan animaation mukana).
        cur.x = this._restHip.x;
        cur.z = this._restHip.z;
      }
    }

    // Osumakohtaiset luu-nykäykset: laantuvat ~0,28 s aikana animaation päälle
    this._applyTwitches(dt);

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
    if (this.walkAction) {
      if (!this.walkAction.isRunning()) this.walkAction.play();
      // Recoil hidastaa kävelyä: täydellä _recoililla (1.0) timeScale tipahtaa
      // ~15 %:iin (tönäisee vihollisen pysähdykseen) ja palautuu ~0,55 s aikana
      // normaaliksi. Koska locomotion johdetaan walkAction.timesta, hidastunut
      // klippi → pienempi gx/gz-edistys → vihollinen pysähtyy näkyvästi.
      const slow = Math.max(0.15, 1 - this._recoil * RECOIL_WALK_SLOW);
      this.walkAction.timeScale = ANIM_TIMESCALE * slow;
    }
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
      this._bitDone = false; this._attackStarted = false; this._setState('attack');
    }
    this._atkCd = Math.max(0, this._atkCd - dt);
  }

  _attack(dt, px, pz, dist){
    this._face(px, pz, dt * 1.5);
    if (this.fallen) { this._setState('walk'); return; }

    // Käytä attack-klippiä jos ladattu, muuten proseduraalinen olkapään heilautus
    if (this.attackAction) {
      const dur = this.attackDur || ATTACK_T;
      if (!this._attackStarted) {
        if (this.walkAction) this.walkAction.fadeOut(0.1);
        this.attackAction.reset();
        this.attackAction.fadeIn(0.1).play();
        this._attackStarted = true;
      }
      if (!this._bitDone && this.t >= dur * 0.55) {
        this._bitDone = true;
        if (dist < ATTACK_RANGE + 0.8 && this.cbs.bite) {
          this.cbs.bite(BITE_DMG); this._tremor = 0.13;
        }
      }
      if (this.t >= dur) {
        this._atkCd = 1.2;
        this._attackStarted = false;
        this.attackAction.fadeOut(0.15);
        if (this.walkAction) { this.walkAction.reset(); this.walkAction.fadeIn(0.15).play(); }
        this._lfz_prev = null; this._rfz_prev = null;
        this._setState('walk');
      }
      return;
    }

    // Fallback: proseduraalinen oikean käden heilautus (kun attack-klippi ei ladattu)
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
      this._lfz_prev = null; this._rfz_prev = null;
      this._setState('walk');
    }
  }

  _dead(dt){
    // Mixer ajaa deathActionia (clampWhenFinished → viim. ruutu jää näkyviin).
    // Bbox-pohjainen sijoitus _apply():ssa pitää ruumiin maassa.
    this._deadT = (this._deadT ?? 0) + dt;
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

    // Hit recoil: nykäys poispäin pelaajasta + lievä ylösnyykähdys. Vain visuaalinen
    // offset group.positioniin (gx/gz pysyvät) — laantuu nopeasti (~0,25 s).
    if (this._recoil > 0 && this._lastPx != null && this.state !== 'dead' && this.state !== 'gone') {
      const dx = this.gx - this._lastPx, dz = this.gz - this._lastPz;
      const len = Math.hypot(dx, dz) || 1;
      const k = this._recoil * RECOIL_KICK;
      this.group.position.x += (dx / len) * k;
      this.group.position.z += (dz / len) * k;
      this.group.position.y += this._recoil * RECOIL_LIFT;
    }

    const yaw = this.facing;
    // KUOLEMA rinteellä: kallista ryhmä siten että local Y = maaston normaali,
    // jolloin selälleen kaatunut ruumis makaa yhdensuuntaisesti maaston kanssa
    // (ei jää vaakaan leijumaan). Muulloin pelkkä yaw — pinta-IK hoitaa
    // jalkapohjien kallistuksen erikseen.
    if (this.state === 'dead' && h) {
      const dd = 0.6;
      const hL = h(this.gx - dd, this.gz), hR = h(this.gx + dd, this.gz);
      const hD = h(this.gx, this.gz - dd), hU = h(this.gx, this.gz + dd);
      _vNormal.set((hL - hR) / (2 * dd), 1, (hD - hU) / (2 * dd)).normalize();
      // Halutaan: local-Y = normaali, local-Z (facing) = vaakaa facing projisoituna
      // kohtisuoraan normaalia vastaan. Sitten local-X = Y × Z.
      _v3.set(Math.sin(yaw), 0, Math.cos(yaw));
      _v3.addScaledVector(_vNormal, -_v3.dot(_vNormal)).normalize();
      _v2.crossVectors(_vNormal, _v3).normalize();
      _tiltMat.makeBasis(_v2, _vNormal, _v3);
      this.group.quaternion.setFromRotationMatrix(_tiltMat);
    } else {
      this.group.rotation.set(0, yaw, 0);
    }

    const liveState = (this.state === 'walk' || this.state === 'attack');
    // ---- MAX-CLEARANCE GROUND-LIFT ----
    // Robusti per-bone-sample: jokaiselle relevantille luulle lasketaan paljonko
    // runkoa pitää nostaa että luu olisi FOOT_OFFSET m maan päällä. Sitten otetaan
    // SUURIN positiivinen tarvittava nosto → mikään luu ei jää maan alle.
    // Walk: jalat + polvet (jyrkillä ylämäillä polvi voi clipata ennen jalkaa).
    // Dead: koko vartalo (kuoleman pose levittää bonet → kysytään monelta luulta).
    if (h && liveState && this._groundBonesWalk && this._groundBonesWalk.length) {
      this.model.updateMatrixWorld(true);
      const adj = this._maxGroundClearance(this._groundBonesWalk, FOOT_OFFSET);
      this.group.position.y += adj;
      this.model.updateMatrixWorld(true);
      // Slope-IK: kierrä nilkat maaston normaaliin yhdensuuntaiseksi
      this._tiltFoot(this.lFootBone);
      this._tiltFoot(this.rFootBone);
      this.model.updateMatrixWorld(true);
    } else if (h && this.state === 'dead' && this._groundBonesDead && this._groundBonesDead.length) {
      this.model.updateMatrixWorld(true);
      const adj = this._maxGroundClearance(this._groundBonesDead, 0.05);
      this.group.position.y += adj;
      this.model.updateMatrixWorld(true);
    } else if (h && this.state === 'emerge') {
      // Emerge nostaa ruumiin maan alta animaation kautta (_emergeY); bbox-pohjainen
      // sijoitus täällä riittää koska rest-pose on lähellä lopullista pose-asentoa.
      this.group.updateMatrixWorld(true);
      _bbox.setFromObject(this.model);
      const bottomY = _bbox.min.y;
      _bbox.getCenter(_v3);
      const terr = h(_v3.x, _v3.z);
      const adj = (terr + FOOT_OFFSET) - bottomY;
      this.group.position.y += adj;
      this.model.updateMatrixWorld(true);
    }

    // Osumavolyymi: kääritään animoidun bbox:n ympärille (world coords).
    // Näkyvissä vain live-tiloissa → kuollutta zombia ei voi tappaa uudelleen.
    if (this.hitVol) {
      if (liveState || this.state === 'emerge') {
        _bbox.setFromObject(this.model);
        const cx = (_bbox.max.x + _bbox.min.x) * 0.5;
        const cy = (_bbox.max.y + _bbox.min.y) * 0.5;
        const cz = (_bbox.max.z + _bbox.min.z) * 0.5;
        const sx = Math.max(0.4, _bbox.max.x - _bbox.min.x);
        const sy = Math.max(0.4, _bbox.max.y - _bbox.min.y);
        const sz = Math.max(0.4, _bbox.max.z - _bbox.min.z);
        this.hitVol.position.set(cx, cy, cz);
        this.hitVol.scale.set(sx, sy, sz);
        this.hitVol.visible = true;
      } else {
        this.hitVol.visible = false;
      }
    }

    // HP-palkki: bbox.max.y:n yläpuolella, lookAt-kameran suuntaan, etupalkki
    // skaalautuu HP-fraktion mukaan vasemmasta reunasta (pivot translatoitiin).
    if (this.hpBar) {
      const alive = (liveState || this.state === 'emerge');
      if (alive) {
        _bbox.setFromObject(this.model);
        const cx = (_bbox.max.x + _bbox.min.x) * 0.5;
        const cz = (_bbox.max.z + _bbox.min.z) * 0.5;
        const topY = _bbox.max.y + HP_BAR_OFFSET;
        this.hpBar.position.set(cx, topY, cz);
        if (this._camera) { _vPos.copy(this._camera.position); this.hpBar.lookAt(_vPos); }
        this.hpBarBg.scale.set(HP_BAR_W, HP_BAR_H, 1);
        const f = Math.max(0, Math.min(1, this.hp / HP_MAX));
        this.hpBarFg.scale.set(HP_BAR_W * f, HP_BAR_H * 0.78, 1);
        // Vihreä → keltainen → punainen HP:n laskiessa
        const r = f < 0.5 ? 1 : (1 - (f - 0.5) * 2);
        const g = f > 0.5 ? 1 : f * 2;
        this.hpBarFg.material.color.setRGB(r, g, 0.1);
        this.hpBar.visible = true;
      } else {
        this.hpBar.visible = false;
      }
    }
  }

  // Suurin tarvittava ylösnosto että MIKÄÄN annettu luu ei jää maan alle.
  // Lasketaan jokaiselle luulle delta = (terrain + offset) − bone.y. Palautetaan
  // max(deltas) — voi olla myös negatiivinen (kaikki luut maan päällä → vartalo
  // saa laskeutua tämän verran kohti maata). Tämä on robustimpi kuin keskiarvo,
  // koska estää clippingin riippumatta yksittäisten luiden korkeuseroista.
  _maxGroundClearance(bones, offset){
    const h = this.heightFn;
    if (!h) return 0;
    let maxDelta = -Infinity;
    for (const bone of bones) {
      if (!bone) continue;
      bone.getWorldPosition(_vPos);
      const t = h(_vPos.x, _vPos.z);
      const delta = (t + offset) - _vPos.y;
      if (delta > maxDelta) maxDelta = delta;
    }
    return (maxDelta === -Infinity) ? 0 : maxDelta;
  }

  // Kiertää nilkkaluun niin että jalkapohja on yhdensuuntaisesti maan kanssa.
  // Toiminta: kvaternio q_tilt = (world-up → maan normaali) sovelletaan world-
  // kehyksessä animoituun bone-orientaatioon. Konvertoidaan parent-kehykseen
  // ja premultiply, koska bone.quaternion on parent-relative.
  _tiltFoot(bone){
    if (!bone || !this.heightFn) return;
    bone.getWorldPosition(_vPos);
    const h = this.heightFn;
    const d = 0.5;
    // Maaston normaali keskidifferenssistä — sileä, riittävä loiville rinteille.
    const hL = h(_vPos.x - d, _vPos.z), hR = h(_vPos.x + d, _vPos.z);
    const hD = h(_vPos.x, _vPos.z - d), hU = h(_vPos.x, _vPos.z + d);
    _vNormal.set((hL - hR) / (2 * d), 1, (hD - hU) / (2 * d)).normalize();
    // q_tilt: rotaatio joka kääntää world-up maan normaaliin (world-kehyksessä)
    _qTilt.setFromUnitVectors(_worldUp, _vNormal);
    const parent = bone.parent;
    if (!parent) { bone.quaternion.premultiply(_qTilt); return; }
    // Parent world quat → ilmaise q_tilt parentin local-kehyksessä:
    // q_local = parent^-1 * q_tilt * parent
    parent.matrixWorld.decompose(_v1, _qParent, _v2);
    _qLocal.copy(_qParent).invert().multiply(_qTilt).multiply(_qParent);
    bone.quaternion.premultiply(_qLocal);
  }

  // ---- vahinko + VERIROISKE ----
  takeDamage(amount, hit){
    if (!this.ready || !this.group.visible) return false;
    if (this.state === 'dead' || this.state === 'gone' || this.state === 'loading') return false;
    this._recoil = 1;
    this._tremor = 0.05;
    // Tunnista osuma-alue ennen vahinkoa → pääosuma kerryttää HEAD_DMG_MULT-kertaa.
    const region = (hit && hit.point) ? this._detectRegion(hit.point) : null;
    const dmg = (region === 'head') ? amount * HEAD_DMG_MULT : amount;
    this.hp -= dmg;
    if (hit && hit.point) this._spawnBlood(hit.point);
    if (region) {
      // Luodin world-suunta: kamera → hit-piste. Twitch kääntyy tähän suuntaan.
      let bDir = null;
      if (hit && hit.point && this._camera) {
        _vBullet.copy(hit.point).sub(this._camera.position);
        if (_vBullet.lengthSq() > 1e-6) { _vBullet.normalize(); bDir = _vBullet; }
      }
      this._applyTwitch(region, bDir);
    }
    if (this.hp <= 0) { this._die(); return true; }
    return false;
  }

  // Lähin osa-alue-luu siihen PELAAJAN AMPUMASÄTEESEEN joka kulkee kamerasta
  // hit-pisteen kautta. Pelkkä hit.pointin nearest-bone antaisi väärän alueen
  // koska hitVol-bbox:n etupinnalla osuma on aina lähinnä rinta/pää-luita.
  _detectRegion(point){
    if (!this._deathBones || !this.model || !this._camera) return null;
    this.model.updateMatrixWorld(true);
    _v2.copy(this._camera.position);
    _v3.subVectors(point, _v2);
    const len = _v3.length();
    if (len < 1e-3) return null;
    _v3.divideScalar(len);
    let bestKey = null, bestDist2 = Infinity;
    for (const key of PART_REGIONS) {
      const def = PART_TWITCH[key];
      const bone = this._deathBones[def.boneKey];
      if (!bone) continue;
      bone.getWorldPosition(_v1);
      _vPos.subVectors(_v1, _v2);
      const tRay = _vPos.dot(_v3);
      if (tRay < 0) continue;
      _vNormal.copy(_v3).multiplyScalar(tRay).add(_v2);
      const d2 = _v1.distanceToSquared(_vNormal);
      if (d2 < bestDist2) { bestDist2 = d2; bestKey = key; }
    }
    return bestKey;
  }

  // Aktivoi alueen luu-twitchin niin että luun "tipin" suunta (bone-local +Y)
  // kääntyy world-kehyksessä kohti luodin suuntaa. Rotaatioakseli = boneDir ×
  // bulletDir → bone nykähtää aina luodin liikesuuntaan riippumatta tulokulmasta.
  _applyTwitch(region, bulletDir){
    const def = PART_TWITCH[region];
    if (!def || !this._deathBones) return;
    const bone = this._deathBones[def.boneKey];
    if (!bone) return;
    this.model.updateMatrixWorld(true);
    // bone world-Y-akseli = luulta tip-päähän osoittava suunta
    bone.matrixWorld.decompose(_v1, _qParent, _v2);
    _v3.set(0, 1, 0).applyQuaternion(_qParent).normalize();
    // Akseli world-kehyksessä; fallback (ei luotia): pyörähdys ylös (taakse)
    const bDir = bulletDir || _worldUp;
    _vNormal.crossVectors(_v3, bDir);
    let axisLen = _vNormal.length();
    if (axisLen < 1e-4) {
      // boneDir ja bulletDir samansuuntaiset — käytä mielivaltaista kohtisuoraa
      _vNormal.set(1, 0, 0);
      if (Math.abs(_v3.x) > 0.9) _vNormal.set(0, 1, 0);
      _vNormal.crossVectors(_v3, _vNormal).normalize();
      axisLen = 1;
    } else {
      _vNormal.divideScalar(axisLen);
    }
    // qWorld = rotaatio akselin ympäri kulmalla def.mag — talletetaan twitchiin
    _qTarget.setFromAxisAngle(_vNormal, def.mag);
    this._twitches.set(bone, { qWorld: _qTarget.clone(), age: 0 });
  }

  // Skaalattu (slerp identityyn) world-twitch konvertoidaan parent-localiin ja
  // premultiplikoidaan bonen päälle joka ruutu. Amplitudi laantuu TWITCH_DECAY:n
  // aikana nollaan, jolloin twitch poistetaan setistä.
  _applyTwitches(dt){
    if (!this._twitches || this._twitches.size === 0) return;
    if (this.state === 'dead') { this._twitches.clear(); return; }
    for (const [bone, t] of this._twitches) {
      t.age += dt;
      const k = Math.max(0, 1 - t.age / TWITCH_DECAY);
      if (k <= 0) { this._twitches.delete(bone); continue; }
      // Skaalattu rotaatio: slerp identityista qWorldiin osuudella k
      _qTarget.copy(_qIdentity).slerp(t.qWorld, k);
      // Konvertoi parent-localiin: q_local = parent^-1 * q_world * parent
      const parent = bone.parent;
      if (parent) {
        parent.matrixWorld.decompose(_v1, _qParent, _v2);
        _qLocal.copy(_qParent).invert().multiply(_qTarget).multiply(_qParent);
        bone.quaternion.premultiply(_qLocal);
      } else {
        bone.quaternion.premultiply(_qTarget);
      }
    }
  }

  _spawnBlood(point){
    if (!this.bloods.length) return;
    // Tiheämpi sumu: 22–32 pientä hiukkasta per osuma, varjeleva nopeusjakauma
    // (suurin osa pieniä, muutama isompi pisara erottuvuuden vuoksi)
    const N = 22 + (Math.random() * 10 | 0);
    for (let k = 0; k < N; k++) {
      const i = this._bloodHead; this._bloodHead = (this._bloodHead + 1) % this.bloods.length;
      const b = this.bloods[i];
      b.m.position.copy(point);
      b.m.visible = true;
      b.vel.set(
        (Math.random() - 0.5) * 5,
        1.2 + Math.random() * 2.4,
        (Math.random() - 0.5) * 5
      );
      b.life = b.max = 0.5 + Math.random() * 0.5;
      // Suurin osa todella pieniä; ~15 % isompia → sumumainen, ei homogeeninen
      const sc = (Math.random() < 0.15) ? (1.0 + Math.random() * 0.6) : (0.55 + Math.random() * 0.5);
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
    this._deadT = 0;
    this._setState('dead');
    // Crossfade walk → death. Jos deathAction ei vielä latautunut, walkAction
    // pysähtyy ja zombi jähmettyy viimeiseen poseen (graceful fallback).
    if (this.deathAction) {
      this.deathAction.reset();
      this.deathAction.timeScale = 1.0;
      if (this.walkAction) this.walkAction.crossFadeTo(this.deathAction.play(), 0.2, false);
      else this.deathAction.play();
    } else if (this.walkAction) {
      this.walkAction.stop();
    }
  }

  get tremor(){ return this._tremor; }
  get alive(){ return this.ready && this.state !== 'gone' && this.state !== 'dead' && this.state !== 'loading'; }

  reset(){
    if (this.group) { this.group.visible = false; this.group.scale.setScalar(1); this.group.rotation.set(0, 0, 0); }
    if (this.hitVol) this.hitVol.visible = false;
    if (this.hpBar) this.hpBar.visible = false;
    if (this._twitches) this._twitches.clear();
    if (this.deathAction)  { this.deathAction.stop(); this.deathAction.reset(); }
    if (this.attackAction) { this.attackAction.stop(); this.attackAction.reset(); }
    this._attackStarted = false;
    for (const b of this.bloods) { b.m.visible = false; b.life = 0; }
    this._respawn = 1.0;
    this._lfz_prev = null; this._rfz_prev = null;
    if (this.ready) this._setState('gone');
    this.fallen = false;
    this.hp = HP_MAX;
  }

  dispose(){
    if (this.group) this.scene.remove(this.group);
    if (this.hitVol) this.scene.remove(this.hitVol);
    if (this.hpBar) this.scene.remove(this.hpBar);
    for (const b of this.bloods) this.scene.remove(b.m);
    this.bloods = [];
  }
}
