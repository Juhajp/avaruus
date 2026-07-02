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
const FOOT_SOLE_CLEARANCE = 0.008;   // millimetriluokan turvaväli; senttiluokka näkyy leijumisena
const FOOT_DEFAULT_SOLE_OFFSET = -0.14;
const FOOT_SAMPLE_R = 0.04;          // vain pieni antialias-näyte, ei rinteellä nostavaa "max around" -footprintiä
const FOOT_IK_UP = 0.7;
const FOOT_IK_DOWN = 0.55;
const LIVE_MAX_TILT = 0.42;          // runko kallistuu rinteeseen, mutta ei kaadu visuaalisesti yli
const BLOOD_POOL = 200;              // aktiivisia veripisaroita kerralla (tiheämpi sumu)
const BLOOD_PUDDLE_POOL = 4;         // kuolinjäljet jäävät näkyviin, mutta pooli estää kasvun
const TARGET_HEIGHT = 2.8;           // skaalataan glb tähän korkeuteen (m)
const HP_BAR_W = 1.0;                // HP-palkin leveys (m, world-koordinaateissa)
const HP_BAR_H = 0.10;
const HP_BAR_OFFSET = 0.35;          // bbox.max.y:stä ylöspäin
const RECOIL_KICK = 0.34;            // koko vartalon kevyt takanykäys (m)
const RECOIL_LIFT = 0.04;            // hyvin pieni ylösnyykähdys, ettei osuma näytä liu'ulta
const RECOIL_DECAY_RATE = 0.75;      // hitaampi palautuminen: _recoil → 0 ~1.3 s
const RECOIL_WALK_SLOW = 0.95;       // walkAction.timeScale *= (1 - _recoil*tämä)
const RECOIL_MOVE_SLOW = 0.97;       // varsinainen gx/gz eteneminen hidastuu myös suoraan
const TWITCH_DECAY = 0.82;           // osumakohdan luu palautuu vielä selvästi, mutta napakammin
const HEAD_DMG_MULT = 2.2;           // pääosumalle ylimääräinen vahinkokerroin
const OUTLINE_THICKNESS = 0.024;     // ääriviivan paksuus maailmametreinä (cell-shade)

// Per-osuma-aluetiltit: kun osumakohta on lähinnä tämän luun keskipistettä,
// kyseinen luu saa lyhyen rotaation. Euler-kulmat kokeellisia Mixamo-konventiolla.
// boneKey viittaa this._deathBones-mapin avaimeen.
// Per-osa-alueen twitchin amplitudi radiaaneina; rotaatioakseli lasketaan
// dynaamisesti luodin suunnasta (takeDamage). Bone-tipin Y-akseli kääntyy kohti
// luodin world-suuntaa → osuma-alue nykäisee aina luodin liikesuuntaan.
const PART_TWITCH = {
  head:  { boneKey: 'head',  mag: 1.25, push: 0.14, bodyKey: 'spine2', bodyMag: 0.20, bodyDynamicSign: true },
  torso: { boneKey: 'spine', mag: 1.25, push: 0.16 },
  larm:  { boneKey: 'larmU', mag: 0.85, push: 0.045, bodyKey: 'spine2', bodyMag: 0.24, bodySign:  1 },
  rarm:  { boneKey: 'rarmU', mag: 0.85, push: 0.045, bodyKey: 'spine2', bodyMag: 0.24, bodySign: -1 },
  lleg:  { boneKey: 'luplg', mag: 0.62, push: 0.040, bodyKey: 'spine2', bodyMag: 0.16, bodySign:  1 },
  rleg:  { boneKey: 'ruplg', mag: 0.62, push: 0.040, bodyKey: 'spine2', bodyMag: 0.16, bodySign: -1 },
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
const _gibColorA = new THREE.Color(0x310404);
const _gibColorB = new THREE.Color(0x8f1512);
const _gibColorC = new THREE.Color(0xd08b68);

function tintGibGeo(geo){
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const minY = geo.boundingBox ? geo.boundingBox.min.y : -1;
  const maxY = geo.boundingBox ? geo.boundingBox.max.y : 1;
  const span = Math.max(0.001, maxY - minY);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = (pos.getY(i) - minY) / span;
    c.copy(_gibColorA).lerp(_gibColorB, Math.min(1, y * 1.25));
    if (i % 7 === 0) c.lerp(_gibColorC, 0.35);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
}

let _puddleTex = null;
function bloodPuddleTexture(){
  if (_puddleTex) return _puddleTex;
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, s, s);
  const g = c.createRadialGradient(s * 0.48, s * 0.52, 4, s * 0.50, s * 0.52, s * 0.48);
  g.addColorStop(0.00, 'rgba(115,0,0,0.88)');
  g.addColorStop(0.45, 'rgba(74,0,0,0.78)');
  g.addColorStop(0.78, 'rgba(38,0,0,0.44)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.beginPath();
  for (let i = 0; i < 40; i++) {
    const a = i * Math.PI * 2 / 40;
    const r = s * (0.34 + 0.11 * Math.sin(i * 2.31) + 0.06 * Math.sin(i * 5.7));
    const x = s * 0.5 + Math.cos(a) * r;
    const y = s * 0.52 + Math.sin(a) * r * 0.72;
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath(); c.fill();
  c.globalCompositeOperation = 'screen';
  c.fillStyle = 'rgba(180,20,18,0.22)';
  for (let i = 0; i < 9; i++) {
    c.beginPath();
    c.ellipse(s * (0.28 + Math.random() * 0.44), s * (0.34 + Math.random() * 0.35),
      s * (0.035 + Math.random() * 0.05), s * (0.012 + Math.random() * 0.03), Math.random() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 18; i++) {
    const x = s * (0.22 + Math.random() * 0.56);
    const y = s * (0.30 + Math.random() * 0.42);
    const rx = s * (0.012 + Math.random() * 0.030);
    const ry = s * (0.008 + Math.random() * 0.024);
    c.fillStyle = i % 4 === 0 ? 'rgba(190,92,70,0.72)' : 'rgba(58,4,4,0.78)';
    c.beginPath();
    c.ellipse(x, y, rx, ry, Math.random() * Math.PI, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(18,0,0,0.45)';
    c.lineWidth = 1;
    c.stroke();
  }
  _puddleTex = new THREE.CanvasTexture(cv);
  _puddleTex.colorSpace = THREE.SRGBColorSpace;
  return _puddleTex;
}

export class GlbEnemy {
  constructor(scene, heightFn, cbs, opts){
    this.scene = scene; this.heightFn = heightFn; this.cbs = cbs || {};
    this.opts = opts || {};
    this.hp = HP_MAX;
    this.state = 'loading'; this.t = 0;
    this.gx = 0; this.gz = 0; this.facing = 0;
    this._tremor = 0; this._recoil = 0; this._respawn = 0;
    this._blastVX = 0; this._blastVZ = 0; this._blastY = 0; this._blastVY = 0;
    this._blastT = 0; this._blastDur = 0; this._blastK = 0; this._blastYaw = 0; this._blastDead = false;
    this._atkCd = 0; this._bitDone = false;
    this._dieAngle = 0;
    this.fallen = false;
    this.bones = {};
    this.partBones = {};
    this.mixer = null;
    this.walkAction = null;
    this.fallAction = null;
    this.lFootBone = null;
    this.rFootBone = null;
    this._footInfos = [];
    this.hipsBone = null;
    this._restHip = null;
    this._lastHip = null;                            // root motion -tracker (edell. ruudun hipin lokaali XYZ)
    this._animDx = 0; this._animDz = 0;              // per-ruudun rotaation lokaali XZ-delta
    this.bloods = [];
    this.gibs = [];
    this.rigGibs = [];
    this.bloodPuddles = [];
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
    this._calibrateFootGrounding(model);

    // veriroiskeen partikkelipooli (THREE.Points olisi GPU-tehokkaampi, mutta tämä riittää)
    this._initBlood();
    this._initGibs();
    this._initBloodPuddles();

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
      const clip = gltf.animations.reduce((best, c) => c.duration > best.duration ? c : best, gltf.animations[0]);
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
      const clip = gltf.animations.reduce((best, c) => c.duration > best.duration ? c : best, gltf.animations[0]);
      this.attackAction = this.mixer.clipAction(clip);
      this.attackAction.setLoop(THREE.LoopOnce, 1);
      this.attackAction.clampWhenFinished = false;
      this.attackDur = clip.duration;
    } catch (e) { console.warn('[glbEnemy] attack anim failed:', e); }
  }

  async _loadFall(){
    try {
      const loader = new GLTFLoader().setDRACOLoader(getDraco());
      const gltf = await loader.loadAsync(this.opts.fallUrl || 'models/zombie_fall_small.glb');
      if (!this.mixer || !gltf.animations || !gltf.animations.length) return;
      const clip = gltf.animations.reduce((best, c) => c.duration > best.duration ? c : best, gltf.animations[0]);
      this.fallAction = this.mixer.clipAction(clip);
      this.fallAction.setLoop(THREE.LoopOnce, 1);
      this.fallAction.clampWhenFinished = true;
      this.fallDur = clip.duration;
    } catch (e) { console.warn('[glbEnemy] fall anim failed:', e); }
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

  _initGibs(){
    this.gibs = [];
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide
    });
    const geos = [
      new THREE.SphereGeometry(0.16, 7, 5),
      new THREE.BoxGeometry(0.34, 0.22, 0.24),
      new THREE.CylinderGeometry(0.08, 0.10, 0.55, 7),
      new THREE.CylinderGeometry(0.075, 0.09, 0.48, 7),
      new THREE.BoxGeometry(0.18, 0.42, 0.18),
    ];
    for (const geo of geos) tintGibGeo(geo);
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(geos[i % geos.length], mat);
      m.visible = false;
      m.castShadow = true;
      m.receiveShadow = false;
      m.userData.debris = true;
      this.scene.add(m);
      this.gibs.push({
        m,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        life: 0,
        max: 0,
      });
    }
    this._gibHead = 0;
  }

  _initBloodPuddles(){
    this.bloodPuddles = [];
    const geo = new THREE.PlaneGeometry(1, 1, 28, 20);
    const mat = new THREE.MeshBasicMaterial({
      map: bloodPuddleTexture(), transparent: true, opacity: 0.9,
      depthWrite: false, side: THREE.DoubleSide
    });
    for (let i = 0; i < BLOOD_PUDDLE_POOL; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 3;
      m.userData.debris = true;
      this.scene.add(m);
      this.bloodPuddles.push(m);
    }
    this._puddleHead = 0;
  }

  _setState(s){ this.state = s; this.t = 0; }

  _spawn(px, pz){
    if (!this.ready) return;
    this.hp = HP_MAX; this.fallen = false;
    this._deadT = 0;
    this._blastVX = 0; this._blastVZ = 0; this._blastY = 0; this._blastVY = 0;
    this._blastT = 0; this._blastDur = 0; this._blastK = 0; this._blastDead = false;
    const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 14;
    this.gx = px + Math.cos(a) * r; this.gz = pz + Math.sin(a) * r;
    this.group.visible = true;
    this.group.scale.setScalar(1);
    this._emergeY = -2.5;
    this._lastHip = null; this._animDx = 0; this._animDz = 0;
    // Reset animaatiotilat: edellisen kuoleman jälkeen walkAction täytyy ajaa puhtaalta
    if (this.deathAction)  { this.deathAction.stop(); this.deathAction.reset(); }
    if (this.attackAction) { this.attackAction.stop(); this.attackAction.reset(); }
    if (this.fallAction)   { this.fallAction.stop(); this.fallAction.reset(); }
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

    // Osumakohtaiset luu-nykäykset: voimakas isku, hidas palautuminen animaation päälle
    this._applyTwitches(dt);

    const dist = Math.hypot(this.gx - px, this.gz - pz);
    switch (this.state) {
      case 'emerge': this._emerge(dt, px, pz); break;
      case 'walk':   this._walk(dt, px, pz, dist); break;
      case 'attack': this._attack(dt, px, pz, dist); break;
      case 'blast':  this._blast(dt); break;
      case 'dead':   this._dead(dt); break;
      case 'gone':   this._respawn -= dt; if (this._respawn <= 0) this._spawn(px, pz); break;
    }

    this._apply();
    this._updateBlood(dt);
    this._updateGibs(dt);
    this._updateRigGibs(dt);
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
      // Recoil hidastaa sekä animaatiota että varsinaista gx/gz-etenemistä.
      // Täydellä osumalla vihollinen lähes pysähtyy ja palautuu yli sekunnissa.
      const slow = Math.max(0.05, 1 - this._recoil * RECOIL_WALK_SLOW);
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
      const moveSlow = Math.max(0.03, 1 - this._recoil * RECOIL_MOVE_SLOW);
      this.gx += (bx * cosF + bz * sinF) * moveSlow;
      this.gz += (-bx * sinF + bz * cosF) * moveSlow;
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

  applyBlast(center, opts = {}){
    if (!this.ready || !this.group || !this.group.visible) return false;
    if (this.state === 'dead' || this.state === 'gone' || this.state === 'loading') return false;
    this.hp = 0;
    this._blastVX = 0;
    this._blastVZ = 0;
    this._blastVY = 0;
    this._blastY = 0;
    this._blastT = 0;
    this._blastDur = 0;
    this._blastK = 0;
    this._blastDead = true;
    this.fallen = true;
    this._tremor = Math.max(this._tremor, 0.12);
    this._atkCd = 1.5;
    if (this.attackAction) this.attackAction.stop();
    if (this.fallAction) this.fallAction.stop();
    if (this.walkAction) this.walkAction.stop();
    if (this.deathAction) {
      this.deathAction.stop();
      this.deathAction.reset();
      this.deathAction.timeScale = 1.0;
      this.deathAction.fadeIn(0.04).play();
    }
    if (this.hpBar) this.hpBar.visible = false;
    this._deadT = 0;
    this._setState('dead');
    return true;
  }

  _blast(dt){
    this._blastT += dt;
    this._blastY = 0;
    this._blastVY = 0;
    if (this._blastT >= this._blastDur) {
      if (this._blastDead || this.hp <= 0) {
        this.hp = 0;
        this._blastVX = 0; this._blastVZ = 0; this._blastY = 0; this._blastVY = 0;
        this._deadT = 0;
        this.fallen = true;
        if (this.walkAction) this.walkAction.stop();
        if (this.attackAction) this.attackAction.stop();
        if (this.hpBar) this.hpBar.visible = false;
        this._setState('dead');
      } else {
        this.fallen = false;
        this._lfz_prev = null; this._rfz_prev = null;
        if (this.fallAction) this.fallAction.fadeOut(0.12);
        if (this.walkAction) {
          this.walkAction.reset();
          this.walkAction.timeScale = ANIM_TIMESCALE;
          this.walkAction.fadeIn(0.16).play();
        }
        this._setState('walk');
      }
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
    const liveState = (this.state === 'walk' || this.state === 'attack');
    if (h && this.state === 'dead') {
      this._setGroundRotation(yaw, null);
    } else if (this.state === 'blast') {
      this.group.rotation.set(0, yaw, 0);
    } else {
      // Elävä vihollinen pysyy pystysuorassa; vain jalkaterät mukautuvat rinteen
      // normaaliin. Koko rigging-ryhmän kallistus tekee hahmosta luonnottoman.
      this.group.rotation.set(0, yaw, 0);
    }

    // ---- FOOTPRINT GROUND-LIFT + FOOT IK ----
    // Runko nostetaan ensin jalkapohjien footprintin mukaan, ei yksittäisen
    // keskipisteen. Sen jälkeen kumpikin nilkka saa oman world-Y-korjauksen, jotta
    // rinteellä toinen jalka ei jää ilmaan eikä toinen uppoa maahan.
    // Dead: koko vartalo (kuoleman pose levittää bonet → kysytään monelta luulta).
    if (h && liveState && this._groundBonesWalk && this._groundBonesWalk.length) {
      this._resetFootHeight();
      this.model.updateMatrixWorld(true);
      const adj = this._liveFootprintLift();
      this.group.position.y += adj;
      this.model.updateMatrixWorld(true);
      this._applyFootHeight(this._footInfos[0]);
      this._applyFootHeight(this._footInfos[1]);
      this.model.updateMatrixWorld(true);
      const safety = Math.max(0, this._maxGroundClearance(this._groundBonesWalk, FOOT_SOLE_CLEARANCE));
      if (safety > 0) {
        this.group.position.y += safety;
        this.model.updateMatrixWorld(true);
      }
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

  _calibrateFootGrounding(model){
    this._footInfos = [];
    if (!model) return;
    model.updateMatrixWorld(true);
    _bbox.setFromObject(model);
    const bottomY = _bbox.min.y;
    const add = (bone) => {
      if (!bone) return;
      bone.getWorldPosition(_vPos);
      let soleOffset = bottomY - _vPos.y;
      if (!Number.isFinite(soleOffset) || soleOffset > 0.08 || soleOffset < -0.6) {
        soleOffset = FOOT_DEFAULT_SOLE_OFFSET;
      }
      this._footInfos.push({ bone, soleOffset, restPos: bone.position.clone() });
    };
    add(this.lFootBone);
    add(this.rFootBone);
  }

  _resetFootHeight(){
    if (!this._footInfos) return;
    for (const info of this._footInfos) {
      if (info && info.bone && info.restPos) info.bone.position.copy(info.restPos);
    }
  }

  _terrainHeightMax(x, z, r){
    const h = this.heightFn;
    if (!h) return 0;
    if (!(r > 0)) return h(x, z);
    return Math.max(
      h(x, z),
      h(x - r, z),
      h(x + r, z),
      h(x, z - r),
      h(x, z + r)
    );
  }

  _terrainNormalAt(x, z, r, out){
    const h = this.heightFn;
    if (!h) return out.copy(_worldUp);
    const d = Math.max(0.05, r || 0.6);
    const hL = h(x - d, z), hR = h(x + d, z);
    const hD = h(x, z - d), hU = h(x, z + d);
    return out.set((hL - hR) / (2 * d), 1, (hD - hU) / (2 * d)).normalize();
  }

  _setGroundRotation(yaw, maxTilt){
    if (!this.heightFn) { this.group.rotation.set(0, yaw, 0); return; }
    this._terrainNormalAt(this.group.position.x, this.group.position.z, 0.75, _vNormal);
    if (maxTilt != null) {
      const angle = Math.acos(Math.max(-1, Math.min(1, _vNormal.y)));
      if (angle > maxTilt) {
        _qTilt.setFromUnitVectors(_worldUp, _vNormal);
        _qTarget.copy(_qIdentity).slerp(_qTilt, maxTilt / angle);
        _vNormal.copy(_worldUp).applyQuaternion(_qTarget).normalize();
      }
    }
    _v3.set(Math.sin(yaw), 0, Math.cos(yaw));
    _v3.addScaledVector(_vNormal, -_v3.dot(_vNormal));
    if (_v3.lengthSq() < 1e-8) _v3.set(Math.sin(yaw), 0, Math.cos(yaw));
    _v3.normalize();
    _v2.crossVectors(_vNormal, _v3).normalize();
    _tiltMat.makeBasis(_v2, _vNormal, _v3);
    this.group.quaternion.setFromRotationMatrix(_tiltMat);
  }

  _liveFootprintLift(){
    if (!this._footInfos || this._footInfos.length === 0) {
      return this._maxGroundClearance(this._groundBonesWalk, FOOT_SOLE_CLEARANCE);
    }
    let maxDelta = -Infinity;
    for (const info of this._footInfos) {
      if (!info || !info.bone) continue;
      info.bone.getWorldPosition(_vPos);
      const terr = this._terrainHeightMax(_vPos.x, _vPos.z, FOOT_SAMPLE_R);
      const soleY = _vPos.y + info.soleOffset;
      maxDelta = Math.max(maxDelta, terr + FOOT_SOLE_CLEARANCE - soleY);
    }
    return maxDelta === -Infinity ? 0 : maxDelta;
  }

  _applyFootHeight(info){
    if (!info || !info.bone || !this.heightFn) return;
    const bone = info.bone;
    bone.getWorldPosition(_vPos);
    const terr = this._terrainHeightMax(_vPos.x, _vPos.z, FOOT_SAMPLE_R);
    let delta = terr + FOOT_SOLE_CLEARANCE - (_vPos.y + info.soleOffset);
    delta = Math.max(-FOOT_IK_DOWN, Math.min(FOOT_IK_UP, delta));
    if (Math.abs(delta) < 0.004) return;
    const parent = bone.parent;
    if (!parent) { bone.position.y += delta; return; }
    _v1.copy(_vPos);
    _v2.copy(_vPos); _v2.y += delta;
    parent.worldToLocal(_v1);
    parent.worldToLocal(_v2);
    bone.position.add(_v2.sub(_v1));
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
    this._recoil = Math.min(1.2, this._recoil + 0.95);
    this._tremor = 0.08;
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
    const old = this._twitches.get(bone);
    if (old && old.basePos) bone.position.copy(old.basePos);
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
    const pushWorld = (bulletDir || _worldUp).clone().multiplyScalar(def.push || 0.14);
    this._twitches.set(bone, {
      qWorld: _qTarget.clone(),
      pushWorld,
      basePos: bone.position.clone(),
      age: 0,
    });
    if (def.bodyKey && def.bodyMag) {
      const body = this._deathBones[def.bodyKey] || this._deathBones.spine;
      if (body && body !== bone) {
        const oldBody = this._twitches.get(body);
        if (oldBody && oldBody.basePos) body.position.copy(oldBody.basePos);
        body.matrixWorld.decompose(_v1, _qParent, _v2);
        _v3.set(0, 1, 0).applyQuaternion(_qParent).normalize();
        let bodySign = def.bodySign || 1;
        if (def.bodyDynamicSign && bulletDir) {
          _v2.set(1, 0, 0).applyQuaternion(_qParent).normalize();
          bodySign = bulletDir.dot(_v2) >= 0 ? 1 : -1;
        }
        _qTarget.setFromAxisAngle(_v3, def.bodyMag * bodySign);
        this._twitches.set(body, {
          qWorld: _qTarget.clone(),
          pushWorld: null,
          basePos: body.position.clone(),
          age: 0,
        });
      }
    }
  }

  // Skaalattu (slerp identityyn) world-twitch konvertoidaan parent-localiin ja
  // premultiplikoidaan bonen päälle joka ruutu. Amplitudi laantuu TWITCH_DECAY:n
  // aikana nollaan, jolloin twitch poistetaan setistä.
  _applyTwitches(dt){
    if (!this._twitches || this._twitches.size === 0) return;
    if (this.state === 'dead') {
      for (const [bone, t] of this._twitches) if (t.basePos) bone.position.copy(t.basePos);
      this._twitches.clear();
      return;
    }
    for (const [bone, t] of this._twitches) {
      t.age += dt;
      const u = Math.min(1, t.age / TWITCH_DECAY);
      const k = Math.max(0, 1 - u * u);   // nopea isku, hidas selkeä palautuminen
      if (t.basePos) bone.position.copy(t.basePos);
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
      if (t.pushWorld) {
        const parent = bone.parent;
        if (parent) {
          bone.getWorldPosition(_v1);
          _v2.copy(_v1).addScaledVector(t.pushWorld, k);
          parent.worldToLocal(_v1);
          parent.worldToLocal(_v2);
          bone.position.add(_v2.sub(_v1));
        } else {
          bone.position.addScaledVector(t.pushWorld, k);
        }
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

  _spawnGib(pos, center, power = 1){
    if (!this.gibs.length) return;
    const i = this._gibHead; this._gibHead = (this._gibHead + 1) % this.gibs.length;
    const g = this.gibs[i];
    g.m.position.copy(pos);
    g.m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    g.m.scale.setScalar(0.72 + Math.random() * 0.65);
    g.m.visible = true;
    _v1.copy(pos).sub(center);
    if (_v1.lengthSq() < 1e-5) _v1.set(Math.random() - 0.5, 0.4, Math.random() - 0.5);
    _v1.normalize();
    g.vel.copy(_v1).multiplyScalar(4.8 + Math.random() * 5.8 * power);
    g.vel.y += 2.6 + Math.random() * 4.2 * power;
    g.spin.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
    g.life = g.max = 4.2 + Math.random() * 1.8;
  }

  _updateGibs(dt){
    if (!this.gibs || !this.gibs.length) return;
    for (const g of this.gibs) {
      if (g.life <= 0) { if (g.m.visible) g.m.visible = false; continue; }
      g.life -= dt;
      if (g.life <= 0) { g.m.visible = false; continue; }
      g.vel.y -= 14 * dt;
      g.m.position.addScaledVector(g.vel, dt);
      g.m.rotation.x += g.spin.x * dt;
      g.m.rotation.y += g.spin.y * dt;
      g.m.rotation.z += g.spin.z * dt;
      const gy = this.heightFn ? this.heightFn(g.m.position.x, g.m.position.z) : 0;
      if (g.m.position.y < gy + 0.05) {
        g.m.position.y = gy + 0.05;
        g.vel.multiplyScalar(0.28);
        g.vel.y = Math.max(0, g.vel.y) * 0.18;
        g.spin.multiplyScalar(0.55);
      }
    }
  }

  _spawnBloodPuddle(center){
    if (!this.bloodPuddles || !this.bloodPuddles.length) return;
    const m = this.bloodPuddles[this._puddleHead || 0];
    this._puddleHead = ((this._puddleHead || 0) + 1) % this.bloodPuddles.length;
    const gy = this.heightFn ? this.heightFn(center.x, center.z) : center.y;
    m.position.set(center.x, gy + 0.018, center.z);
    const sc = 2.25 + Math.random() * 1.10;
    m.scale.set(sc * (1.35 + Math.random() * 0.48), sc * (0.86 + Math.random() * 0.28), 1);
    if (this.heightFn) {
      this._terrainNormalAt(center.x, center.z, 0.45, _vNormal);
      _qTarget.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _vNormal);
      _qLocal.setFromAxisAngle(_vNormal, Math.random() * Math.PI * 2);
      m.quaternion.copy(_qLocal).multiply(_qTarget);
    } else {
      m.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    }
    m.visible = true;
  }

  _dominantSkinBone(skinIndex, skinWeight, vi){
    if (!skinIndex || !skinWeight) return -1;
    let best = -1, bestW = -1;
    const ids = [skinIndex.getX(vi), skinIndex.getY(vi), skinIndex.getZ(vi), skinIndex.getW(vi)];
    const ws = [skinWeight.getX(vi), skinWeight.getY(vi), skinWeight.getZ(vi), skinWeight.getW(vi)];
    for (let i = 0; i < 4; i++) {
      if (ws[i] > bestW) { bestW = ws[i]; best = ids[i]; }
    }
    return best;
  }

  _spawnRigGib(label, tests, center, power = 1){
    const sm = this.skinned;
    if (!sm || !sm.geometry || !sm.skeleton || !sm.geometry.attributes.position || typeof sm.boneTransform !== 'function') return false;
    const bones = sm.skeleton.bones || [];
    const boneSet = new Set();
    for (let i = 0; i < bones.length; i++) {
      const name = bones[i] ? bones[i].name : '';
      if (tests.some(re => re.test(name))) boneSet.add(i);
    }
    if (!boneSet.size) return false;

    sm.updateMatrixWorld(true);
    if (sm.skeleton && sm.skeleton.update) sm.skeleton.update();
    const geo = sm.geometry;
    const pos = geo.attributes.position;
    const skinIndex = geo.attributes.skinIndex;
    const skinWeight = geo.attributes.skinWeight;
    const idx = geo.index ? geo.index.array : null;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.count / 3);
    const maxTris = label === 'torso' ? 620 : 460;
    const stride = Math.max(1, Math.ceil(triCount / maxTris));
    const verts = [];
    const colors = [];
    const world = [];
    let used = 0;

    for (let t = 0; t < triCount; t += stride) {
      const a = idx ? idx[t * 3] : t * 3;
      const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ba = this._dominantSkinBone(skinIndex, skinWeight, a);
      const bb = this._dominantSkinBone(skinIndex, skinWeight, b);
      const bc = this._dominantSkinBone(skinIndex, skinWeight, c);
      const hits = (boneSet.has(ba) ? 1 : 0) + (boneSet.has(bb) ? 1 : 0) + (boneSet.has(bc) ? 1 : 0);
      if (hits < 2) continue;
      for (const vi of [a, b, c]) {
        _v1.fromBufferAttribute(pos, vi);
        sm.boneTransform(vi, _v1);
        sm.localToWorld(_v1);
        world.push(_v1.x, _v1.y, _v1.z);
      }
      used++;
      if (used >= maxTris) break;
    }
    if (used < 8) return false;

    _v2.set(0, 0, 0);
    for (let i = 0; i < world.length; i += 3) _v2.add(_v3.set(world[i], world[i + 1], world[i + 2]));
    _v2.multiplyScalar(3 / world.length);
    for (let i = 0; i < world.length; i += 3) {
      const x = world[i] - _v2.x, y = world[i + 1] - _v2.y, z = world[i + 2] - _v2.z;
      verts.push(x, y, z);
      const k = Math.max(0, Math.min(1, (y + 0.45) / 0.9));
      const cc = new THREE.Color().copy(_gibColorA).lerp(_gibColorB, k);
      if ((i / 3) % 11 === 0) cc.lerp(_gibColorC, 0.42);
      colors.push(cc.r, cc.g, cc.b);
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    out.computeVertexNormals();
    out.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0,
      side: THREE.DoubleSide, flatShading: false
    });
    const m = new THREE.Mesh(out, mat);
    m.castShadow = true;
    m.receiveShadow = false;
    m.userData.debris = true;
    m.position.copy(_v2);
    m.quaternion.copy(_qIdentity);
    this.scene.add(m);

    _v1.copy(_v2).sub(center);
    if (_v1.lengthSq() < 1e-5) _v1.set(Math.random() - 0.5, 0.45, Math.random() - 0.5);
    _v1.normalize();
    const vel = _v1.clone().multiplyScalar(5.2 + Math.random() * 5.4 * power);
    vel.y += 3.0 + Math.random() * 4.8 * power;
    this.rigGibs.push({
      m, vel,
      spin: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12),
      life: 9.5 + Math.random() * 3.5,
      settled: false,
    });
    return true;
  }

  _clearRigGibs(){
    if (!this.rigGibs) { this.rigGibs = []; return; }
    for (const g of this.rigGibs) {
      this.scene.remove(g.m);
      if (g.m.geometry) g.m.geometry.dispose();
      if (g.m.material) g.m.material.dispose();
    }
    this.rigGibs = [];
  }

  _updateRigGibs(dt){
    if (!this.rigGibs || !this.rigGibs.length) return;
    for (const g of this.rigGibs) {
      if (g.life <= 0) { if (g.m.visible) g.m.visible = false; continue; }
      g.life -= dt;
      if (g.life <= 0) { g.m.visible = false; continue; }
      if (!g.settled) {
        g.vel.y -= 13 * dt;
        g.m.position.addScaledVector(g.vel, dt);
        g.m.rotation.x += g.spin.x * dt;
        g.m.rotation.y += g.spin.y * dt;
        g.m.rotation.z += g.spin.z * dt;
        const gy = this.heightFn ? this.heightFn(g.m.position.x, g.m.position.z) : 0;
        if (g.m.position.y < gy + 0.06) {
          g.m.position.y = gy + 0.06;
          g.vel.multiplyScalar(0.18);
          g.spin.multiplyScalar(0.35);
          if (g.vel.lengthSq() < 0.25) g.settled = true;
        }
      }
    }
  }

  explode(hit){
    if (!this.ready || !this.group || !this.group.visible) return false;
    const center = (hit && hit.point) ? hit.point.clone() : this.group.position.clone();
    this.model.updateMatrixWorld(true);
    this._clearRigGibs();
    this._spawnBloodPuddle(center);

    const rigParts = [
      ['head',  [/Head$/i, /Neck$/i], 1.45],
      ['larm',  [/LeftArm$/i, /LeftForeArm$/i, /LeftHand$/i, /LeftShoulder$/i], 1.25],
      ['rarm',  [/RightArm$/i, /RightForeArm$/i, /RightHand$/i, /RightShoulder$/i], 1.25],
      ['lleg',  [/LeftUpLeg$/i, /LeftLeg$/i, /LeftFoot$/i, /LeftToe/i], 1.18],
      ['rleg',  [/RightUpLeg$/i, /RightLeg$/i, /RightFoot$/i, /RightToe/i], 1.18],
      ['torso', [/Hips$/i, /Spine$/i, /Spine1$/i, /Spine2$/i], 1.05],
    ];
    let rigN = 0;
    for (const [label, tests, power] of rigParts) {
      if (this._spawnRigGib(label, tests, center, power)) rigN++;
    }

    const keys = ['head', 'spine2', 'spine', 'larmU', 'rarmU', 'larmF', 'rarmF', 'luplg', 'ruplg', 'lleg', 'rleg'];
    let n = 0;
    for (const k of keys) {
      const b = this._deathBones && this._deathBones[k];
      if (!b) continue;
      b.getWorldPosition(_v2);
      this._spawnGib(_v2, center, rigN ? 0.85 : 1.25);
      n++;
    }
    while (n++ < 10) {
      _v2.copy(center).add(_v3.set(Math.random() - 0.5, Math.random() * 1.8, Math.random() - 0.5).multiplyScalar(0.75));
      this._spawnGib(_v2, center, 1.15);
    }

    for (let i = 0; i < 9; i++) {
      _v2.copy(center).add(_v3.set(Math.random() - 0.5, Math.random() * 1.2, Math.random() - 0.5).multiplyScalar(0.45));
      this._spawnBlood(_v2);
    }
    this.hp = 0;
    this._tremor = 0.22;
    this.group.visible = false;
    if (this.hitVol) this.hitVol.visible = false;
    if (this.hpBar) this.hpBar.visible = false;
    if (this.walkAction) this.walkAction.stop();
    if (this.deathAction) this.deathAction.stop();
    if (this.attackAction) this.attackAction.stop();
    if (this.fallAction) this.fallAction.stop();
    if (this._twitches) this._twitches.clear();
    this._respawn = 5.5;
    this._setState('gone');
    return true;
  }

  _die(){
    this.hp = 0;
    this._deadT = 0;
    this._setState('dead');
    if (this.fallAction) { this.fallAction.stop(); this.fallAction.reset(); }
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
    if (this._twitches) {
      for (const [bone, t] of this._twitches) if (t.basePos) bone.position.copy(t.basePos);
      this._twitches.clear();
    }
    if (this.deathAction)  { this.deathAction.stop(); this.deathAction.reset(); }
    if (this.attackAction) { this.attackAction.stop(); this.attackAction.reset(); }
    if (this.fallAction)   { this.fallAction.stop(); this.fallAction.reset(); }
    this._attackStarted = false;
    this._blastVX = 0; this._blastVZ = 0; this._blastY = 0; this._blastVY = 0;
    this._blastT = 0; this._blastDur = 0; this._blastK = 0; this._blastDead = false;
    for (const b of this.bloods) { b.m.visible = false; b.life = 0; }
    for (const g of this.gibs) { g.m.visible = false; g.life = 0; }
    this._clearRigGibs();
    for (const p of this.bloodPuddles) p.visible = false;
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
    for (const g of this.gibs) {
      this.scene.remove(g.m);
      if (g.m.geometry) g.m.geometry.dispose();
      if (g.m.material) g.m.material.dispose();
    }
    this._clearRigGibs();
    for (const p of this.bloodPuddles) {
      this.scene.remove(p);
      if (p.geometry) p.geometry.dispose();
      if (p.material) p.material.dispose();
    }
    this.bloods = [];
    this.gibs = [];
    this.bloodPuddles = [];
  }
}
