/* ---------------- Pintalouhinta + jalostus (ei taloutta) ----------------
   Marsin pinnalla (kävelymoodi) on hehkuvia mineraaliesiintymiä, joita kerätään
   kävelemällä niiden yli. Kerätyt raaka-aineet voi jalostaa (C = jalostuspaneeli)
   tuotteiksi. Varasto on jaetussa tilassa `S.inv`. Esiintymät ovat kevyt
   kierrätyspooli (kuten muu sirote) — vain lähimmät pidetään pelaajan ympärillä,
   kerätty siirtyy uuteen paikkaan, joten louhittavaa riittää loputtomasti. */
import * as THREE from 'three';
import { camera } from './core.js';
import { S } from './state.js';
import { toonMat, addOutlines } from './toon.js';

export const ITEM_NAMES = {
  rauta: 'Rautaoksidi', silikaatti: 'Silikaatit', jaa: 'Vesijää',
  // kiviplaneettojen ja Kuun realistiset mineraalit
  pyriitti: 'Pyriitti', ilmeniitti: 'Ilmeniitti', anortiitti: 'Anortiitti',
  teras: 'Teräs', happi: 'Happisäiliö', komposiitti: 'Komposiitti', paneeli: 'Runkopaneeli',
};
// jalostusreseptit: kuluttaa varastosta in-osat, tuottaa out-tuotteen varastoon.
// Happisäiliö ja Runkopaneeli ovat käyttötuotteita: ne varastoidaan ja käytetään
// erikseen (J/K tai HUD-napit, resources.js) aluksen hapen/rungon täyttöön.
export const RECIPES = [
  // teräksen lähteet: malmin rikkauden mukaan eri määrä → 1 teräs
  // (hematiitti tehokkain 2, ilmeniitti 3, pyriitti heikoin 4)
  { out: 'teras',       in: { rauta: 2 } },
  { out: 'teras',       in: { ilmeniitti: 3 } },
  { out: 'teras',       in: { pyriitti: 4 } },
  { out: 'komposiitti', in: { silikaatti: 3 } },
  { out: 'komposiitti', in: { anortiitti: 3 } },
  { out: 'happi',       in: { jaa: 2 } },
  { out: 'paneeli',     in: { teras: 2, komposiitti: 1 } },
];
const RAW = ['rauta', 'silikaatti', 'jaa', 'pyriitti', 'ilmeniitti', 'anortiitti'];
const MADE = ['teras', 'komposiitti', 'happi', 'paneeli'];

// esiintymätyypit: väri, emissio (hehku) ja suhteellinen yleisyys
// kivimäisiä esiintymiä: sama tekstuuri kuin tavallisilla kivillä, mutta hillitty
// tunnusväri (kerrotaan kivitekstuurilla) erottaa lajit toisistaan ja kivistä
// esiintymäsetit planeetoittain (väri = hillitty tunnusvivahde kivitekstuurin päällä)
const ORE_SETS = {
  Merkurius: [
    { type: 'rauta',      col: 0xc86a42, w: 0.45 },   // rautapitoinen regoliitti
    { type: 'silikaatti', col: 0xbcbcae, w: 0.35 },   // vaalean harmaa
    { type: 'jaa',        col: 0x9ec6de, w: 0.20 },    // napakraattereiden vesijää
  ],
  Venus: [
    { type: 'pyriitti',   col: 0xb89a4e, w: 0.45 },   // metallinen "huurre" ylängöillä
    { type: 'silikaatti', col: 0xbcbcae, w: 0.55 },   // basalttitasangot
  ],
  Mars: [
    { type: 'rauta',      col: 0xc86a42, w: 0.42 },   // ruosteenpunainen vivahde
    { type: 'silikaatti', col: 0xbcbcae, w: 0.38 },   // vaalean harmaa
    { type: 'jaa',        col: 0x9ec6de, w: 0.20 },    // sinertävä
  ],
  Kuu: [
    { type: 'ilmeniitti', col: 0x4f4a47, w: 0.40 },   // tumma rauta-titaanioksidi (maaria)
    { type: 'anortiitti', col: 0xdad6cd, w: 0.36 },   // vaalea maasälpä (ylängöt)
    { type: 'jaa',        col: 0x9ec6de, w: 0.24 },    // napakraattereiden vesijää
  ],
};
let ORE = ORE_SETS.Mars;   // aktiivinen setti (valitaan initMiningissä)
function pickOre(){ const r = Math.random(); let a = 0, tot = 0; for (const o of ORE) tot += o.w; for (const o of ORE) { a += o.w / tot; if (r < a) return o; } return ORE[0]; }

const COUNT = 26, NEAR = 25, FAR = 150;   // esiintymäpooli levitetty laajemmalle alueelle
// hakun kantama (3D-etäisyys silmästä kohteen tähtäyspisteeseen): lyhyt, kuten
// hakulla kuuluu — täytyy seistä kohteen vieressä. Silmä on ~2,4 m maasta, joten
// viereisen (törmäyssäde 1,5 m) esiintymän etäisyys on jo ~2,2 m → 4 m antaa varan
// mutta estää louhinnan metrien päästä.
const REACH = 4, AIM_COS = 0.975;   // kantama (m, 3D), tähtäyskartio ~13°
// louhinta-aika riippuu mineraalista: mitä ENEMMÄN jalostukseen tarvitaan, sitä
// nopeampi louhia (käänteinen suhde). Hitain (jalostustarve 2) = 3,6 s ≈ 3×
// vanhasta (1,2 s), nopein (tarve 4) = 1,8 s. Yhteisaika per jaloste pysyy ~7,2 s.
const REFINE_AMT = { rauta: 2, jaa: 2, silikaatti: 3, ilmeniitti: 3, anortiitti: 3, pyriitti: 4 };
const mineTime = (type) => 7.2 / (REFINE_AMT[type] || 3);
const COLLIDE_R = 1.5;                                 // esiintymän törmäyssäde (ei voi kävellä läpi)
const _col = [0, 0];
let deposits = [];
let scene = null, heightFn = null, active = false, planetName = null;
let oreGeo = null, oreMats = null;   // luodaan per pintakäynti (scene-dispose hävittää)
let mineralEnv = null;               // taivaan IBL-kartta heijastuksiin (surface.js asettaa)
let rockMap = null, rockNor = null;  // planeetan kivitekstuuri + normaalikartta (surface.js asettaa)

// surface.js kutsuu kun taivaan ympäristökartta on valmis. CELL SHADING:
// MeshToonMaterial ei käytä ympäristökarttaa → tallennetaan vain viite (ei
// aseteta envMappia, joka kaataisi renderöijän — toonilla ei ole envMap-uniformia)
export function setMineralEnv(tex){
  mineralEnv = tex;
}

// surface.js kutsuu kun kivitekstuuri on ladattu → esiintymät käyttävät sitä
export function setMineralRock(diff, nor){
  if (diff) rockMap = diff;
  if (nor) rockNor = nor;
  if (oreMats) for (const k in oreMats) {
    if (diff) oreMats[k].map = diff;
    if (nor) oreMats[k].normalMap = nor;
    oreMats[k].needsUpdate = true;
  }
}

// kivimäinen epäsäännöllinen lohkare (ikosaedri + paikkahash-siirtymä, kuten kivet)
function makeOreRockGeo(){
  const g = new THREE.IcosahedronGeometry(0.8, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = Math.abs(Math.sin(x * 12.9 + y * 78.2 + z * 37.7) * 43758.5) % 1;
    const s = 1 + (h - 0.5) * 0.4;
    p.setXYZ(i, x * s, y * s, z * s);
  }
  g.computeVertexNormals();
  return g;
}
// murtumispurske + iskusirut: jaettu kivensirupooli (sinkoutuvat osuman värissä)
const BURST_POOL = 44, BURST_G = 8;
let bursts = [], burstGeo = null;
const _bd = new THREE.Vector3();
let _lmb = false;                    // hiiren vasen pohjassa (= louhi)
let _triggerPressed = false, _triggerReleased = false, _prevSpace = false;
let mineTarget = null, mineProg = 0; // nykyinen louhintakohde ja edistymä
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();
const _ray = new THREE.Raycaster();  // hakun isku → mitä edessä (kivi/mineraali/objekti)
const STRIKE_RATE = 2.6;             // iskuja/s (sama kuin updateToolin animaatio)
let _prevPh = 0;                     // edellinen iskuvaihe (impaktin tunnistus)
// ISO loppupurske kun mineraali murtuu (enemmän + isompia + nopeampia siruja)
const FINAL_BURST  = { count: 24, scaleMin: 0.9, scaleRng: 1.6, speedMin: 2.4, speedRng: 4.2, lifeMin: 0.6, lifeRng: 0.5, spread: 0.35 };
// pienet sirut joka hakuniskulla (kivi/mineraali/objekti) — PIENET sirpaleet
const STRIKE_BURST = { count: 5,  scaleMin: 0.12, scaleRng: 0.22, speedMin: 1.1, speedRng: 1.9, lifeMin: 0.3, lifeRng: 0.3, spread: 0.16 };

// ---- aseet: hakku → laser → plasma-tykki ----
const TOOL_PICK = 0, TOOL_LASER = 1, TOOL_PLASMA = 2;
let toolMode = TOOL_PICK;
let weaponMode = false;             // yhteensopivuus vanhaan isWeapon()-kyselyyn
let sniperMode = false;             // oikea hiiren nappi: zoomattu tähtäystila aseelle
let recoil = 0, _gunT = 0;          // rekyyli (vaikuttaa VAIN aseeseen) + huojunta-aika
let _fireCd = 0, _prevLaserFire = false; // laserin jäähtymisaika + edellinen liipaisin (semi-auto = nouseva reuna)
const FLASH_LIFE = 0.16;   // suuliekin valon/kipinöiden elinaika
const SPARK_POOL = 64;             // hehkuvat pistehiukkaset (suuliekin kipinäpuska)
const GUN_DMG = 1, DEP_HP = 3;     // laserin vahinko per laukaus + mineraalin piilo-osumapisteet
const PLASMA_DMG = 40;
const PLASMA_CHARGE_T = 1.15;
const PLASMA_MIN_CHARGE = 0.34;
const PLASMA_SPEED = 58;
const PLASMA_POOL = 6;
const PLASMA_SMOKE_POOL = 12;
const PLASMA_GROUND_MARK_POOL = 16;
let flashLight = null, _flLife = 0, _flMax = 0, _flPeak = 5;        // suuliekin hetkellinen valo (valaisee lähiympäristön pimeässä)
const FLASH_LIGHT_INT = 5;                              // valon huippukirkkaus (candela, decay 2)
let sparks = null, sparkGeo = null, sparkMat = null;   // suuliekin kipinät (THREE.Points)
let _spkPos = null, _spkVel = null, _spkLife = null, _spkMax = null, _spkSize = null, _spkHead = 0;
let _gunHitHandler = null;          // surface.js rekisteröi kivien/sukkulan osumakäsittelyn
export function setGunHitHandler(fn){ _gunHitHandler = fn; }
let _pickHitHandler = null;         // surface.js rekisteröi vihollisen hakkuosuman
export function setPickaxeHitHandler(fn){ _pickHitHandler = fn; }
const GUN_POS = new THREE.Vector3(0.34, -0.40, -0.55);
const GUN_ROT = new THREE.Vector3(0.03, -0.12, 0.0);
const GUN_AIM_POS = new THREE.Vector3(0.06, -0.35, -0.72);
const GUN_AIM_ROT = new THREE.Vector3(0.0, -0.02, 0.0);
const PLASMA_POS = new THREE.Vector3(0.38, -0.38, -0.58);
const PLASMA_ROT = new THREE.Vector3(0.02, -0.20, 0.02);
const SURFACE_FOV = 65;
const SNIPER_FOV = 20;
const SNIPER_LOOK_MUL = 0.38;
let sniperAmt = 0, scopeEl = null;
let plasmaGun = null, plasmaMeter = null, plasmaCore = null;
let plasmaCharge = 0, plasmaCharging = false, plasmaCd = 0;
let plasmaShots = [];
let plasmaTex = null;
let plasmaSmokeTex = null, plasmaPuffs = [];
let plasmaGroundTex = null, plasmaGroundMarks = [], plasmaGroundMarkHead = 0;
let plasmaTargets = [], plasmaTargetRefresh = 0;
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4(), _muz = new THREE.Vector3(), _segDir = new THREE.Vector3(), _plNext = new THREE.Vector3(), _plHit = new THREE.Vector3();
const _plGroundN = new THREE.Vector3(), _plGroundPlaneN = new THREE.Vector3(0, 0, 1);

/* ---- ensimmäisen persoonan louhintatyökalu (kameran lapsi) ----
   Octagonaalinen metallihakku oikeassa alakulmassa; heiluu kaarella kun
   louhitaan (Minecraft-tyylinen hakkuanimaatio). Näkyy kiviplaneetoilla ja
   Kuulla kävelymoodissa. Realistiset PBR-metallitekstuurit Poly Havenista. */
const TOOL_POS = new THREE.Vector3(0.42, -0.46, -0.95);
const TOOL_ROT = new THREE.Vector3(-0.30, 0.62, 0.35);
let swingT = 0, swingAmt = 0;
let toolMats = [];   // työkalun materiaalit
// realistiset metallitekstuurit Poly Havenilta (diff + normaali + karheus + metallisuus)
const PH_TOOL = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/';
function loadToolTex(mat, slug, ru, rv){
  const L = new THREE.TextureLoader();
  const load = (map, key, srgb) => L.load(`${PH_TOOL}${slug}/${slug}_${map}_1k.jpg`, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(ru, rv); t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    mat[key] = t; mat.needsUpdate = true;
  });
  // toon-materiaali tukee vain map + normalMap (ei rough/metal/env-karttoja)
  load('diff', 'map', true);
  load('nor_gl', 'normalMap', false);
}
/* "Otsalamppu" VAIN tämän materiaalin shaderissa: lisää kiinteän katselijan
   suuntaisen valon emissioon (näkymäavaruuden normaali, z+ = kohti katselijaa).
   Antaa muotovarjostuksen ja näkyvyyden kaikissa valoissa EIKÄ vaikuta muihin
   objekteihin (toisin kuin scenen PointLight, jota three.js soveltaisi kaikkeen).
   Käyttää diffuseColoria → tekstuuri säilyy eikä huuhtoudu. */
function addToolHeadlamp(mat){
  mat.customProgramCacheKey = () => 'toolHeadlamp';
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       float _hl = clamp(dot(normalize(normal), normalize(vec3(0.35, 0.45, 0.82))), 0.0, 1.0);
       totalEmissiveRadiance += diffuseColor.rgb * (0.55 + 0.85 * _hl);`
    );
  };
  mat.needsUpdate = true;
}
function buildTool(){
  const g = new THREE.Group();
  // kahva: octagonaalinen metalli (metal_plate_02), terä/kaulus: teräs (metal_plate)
  // CELL SHADING: toon-materiaali (porrastettu valaistus) + tekstuurit (säilyy)
  const handleMat = toonMat({ color: 0x9298a0 });
  loadToolTex(handleMat, 'metal_plate_02', 1, 4);
  const steel = toonMat({ color: 0x8c929a });
  loadToolTex(steel, 'metal_plate', 1, 1);
  toolMats = [handleMat, steel];
  // OTSALAMPPU pelkästään näiden materiaalien shaderissa (ei scenen valonlähdettä,
  // joten EI valaise muita objekteja): kiinteä katselijan suuntainen valo lisätään
  // emissioon → työkalu saa muotovarjostuksen ja pysyy näkyvänä KAIKISSA valoissa,
  // vaikka aurinko olisi takana. Näkymäavaruuden normaali (z+ = kohti katselijaa).
  addToolHeadlamp(handleMat); addToolHeadlamp(steel);
  // varsi: 8-särmäinen (octagoni) metallikahva
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.6, 8), handleMat);
  handle.position.set(0, -0.1, 0); g.add(handle);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.042, 0.07, 8), steel);
  collar.position.set(0, 0.18, 0); g.add(collar);
  // pää: kaksipäinen teräskärki poikittain varteen nähden (klassinen hakku)
  const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), steel);
  head.scale.set(0.78, 0.1, 0.12);            // pitkä X-suunnassa, ohut → kaksi kärkeä
  head.position.set(0, 0.205, 0.015);
  head.rotation.set(0.22, Math.PI / 2 - 0.35, 0);   // 90° − 20°, kallistus eteen-alas
  g.add(head);
  addOutlines(g, 0.012);   // cell shading: musta ääriviiva (käänteinen kuori)
  g.traverse(o => { if (o.isMesh) o.userData.viewmodel = true; });   // hakun iskuraycast ohittaa itsensä
  g.position.copy(TOOL_POS);
  g.rotation.set(TOOL_ROT.x, TOOL_ROT.y, TOOL_ROT.z);
  g.visible = false;
  camera.add(g);
  return g;
}
const tool = buildTool();
function updateTool(dt, swinging){
  swingAmt += ((swinging ? 1 : 0) - swingAmt) * Math.min(1, dt * 10);
  swingT += dt;
  // epäsymmetrinen isku: windup (nosto taakse) → nopea isku alas → palautus, ~2,6 iskua/s
  const ph = (swingT * STRIKE_RATE) % 1;
  let strike;
  if (ph < 0.34)      strike = -(ph / 0.34) * 0.45;            // windup taakse/ylös
  else if (ph < 0.5)  strike = -0.45 + ((ph - 0.34) / 0.16) * 1.45;   // nopea isku → +1
  else                strike = 1 - (ph - 0.5) / 0.5;           // palautus 1→0
  const k = strike * swingAmt;
  const idle = (1 - swingAmt);   // joutilaana kevyt hengitysmäinen huojunta
  tool.position.set(
    TOOL_POS.x + Math.sin(swingT * 1.3) * 0.006 * idle,
    TOOL_POS.y - Math.max(0, k) * 0.13 + Math.sin(swingT * 1.7) * 0.007 * idle,
    TOOL_POS.z - Math.max(0, k) * 0.18
  );
  tool.rotation.set(
    TOOL_ROT.x - k * 1.3,
    TOOL_ROT.y + Math.sin(swingT * 1.3) * 0.02 * idle,
    TOOL_ROT.z + k * 0.5
  );
}

/* ---- laserase (kameran lapsi, vaihtoehto hakulle) ----
   Realistinen sci-fi-laserkivääri (bittikarttatekstuuri + cell-shading). Ampuu
   semiautomaattisesti (laukaus per liipaisinpainallus) katkonaisia, lattamaisia
   lasersäteitä. Rekyyli liikuttaa VAIN asetta (ei pelaajaa). */
// suuliekki: pehmeä hehkuydin + tähtipiikit (tähtisädemäinen välähdys). Satunnainen
// kierto per laukaus tekee piikeistä elävät. Ilman tätä litteä quad näkyisi laatikkona.
let _flashTex = null;
function flashTex(){
  if (_flashTex) return _flashTex;
  const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d'), cx = s / 2, cy = s / 2;
  c.globalCompositeOperation = 'lighter';
  c.filter = 'blur(1.1px)';
  const core = c.createRadialGradient(cx, cy, 0, cx, cy, s * 0.16);
  core.addColorStop(0.00, 'rgba(255,255,255,0.82)');
  core.addColorStop(0.45, 'rgba(255,205,130,0.30)');
  core.addColorStop(1.00, 'rgba(255,150,70,0)');
  c.fillStyle = core; c.fillRect(0, 0, s, s);
  c.translate(cx, cy);
  const spikes = 9;
  for (let i = 0; i < spikes; i++) {
    c.rotate(Math.PI * 2 / spikes + Math.random() * 0.2);
    const len = s * (0.18 + Math.random() * 0.18), w = s * (0.010 + Math.random() * 0.012);
    const lg = c.createLinearGradient(0, 0, 0, -len);
    lg.addColorStop(0, 'rgba(255,235,180,0.52)'); lg.addColorStop(0.55, 'rgba(255,170,80,0.20)'); lg.addColorStop(1, 'rgba(255,170,80,0)');
    c.fillStyle = lg;
    c.beginPath(); c.moveTo(-w, 0); c.lineTo(0, -len); c.lineTo(w, 0); c.closePath(); c.fill();
  }
  _flashTex = new THREE.CanvasTexture(cv);
  _flashTex.colorSpace = THREE.SRGBColorSpace;
  _flashTex.minFilter = THREE.LinearFilter;
  _flashTex.magFilter = THREE.LinearFilter;
  return _flashTex;
}
function muzzleDepthMat(){
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uAlpha: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vP;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){
        vP = position;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      varying vec3 vP;
      uniform float uAlpha;
      uniform float uTime;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      float hash(vec3 p){
        p = fract(p * vec3(17.13, 31.71, 47.57));
        p += dot(p, p.yzx + 19.19);
        return fract((p.x + p.y) * p.z);
      }
      float noise(vec3 p){
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));
        float nx00 = mix(n000, n100, f.x);
        float nx10 = mix(n010, n110, f.x);
        float nx01 = mix(n001, n101, f.x);
        float nx11 = mix(n011, n111, f.x);
        return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
      }
      void main(){
        #include <logdepthbuf_fragment>
        vec3 p = vP / 0.075;
        float r = length(p.xy);
        float shell = smoothstep(1.05, 0.18, r) * smoothstep(1.0, 0.05, abs(p.z));
        float wisps = noise(p * vec3(4.0, 4.0, 8.5) + vec3(0.0, 0.0, uTime * 16.0));
        float streak = smoothstep(0.43, 0.92, wisps + sin(p.z * 7.5 + atan(p.y, p.x) * 4.0 + uTime * 23.0) * 0.18);
        float edgeBreak = smoothstep(1.1, 0.25, r + noise(p * 6.0 + uTime) * 0.25);
        float a = (shell * 0.16 + streak * edgeBreak * 0.20) * uAlpha;
        vec3 col = mix(vec3(1.0, 0.40, 0.12), vec3(1.0, 0.86, 0.45), streak);
        gl_FragColor = vec4(col, a);
      }`,
  });
}
let _rifleTex = null;
function rifleTex(){
  if (_rifleTex) return _rifleTex;
  _rifleTex = new THREE.TextureLoader().load('assets/rifle.webp', t => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  });
  return _rifleTex;
}
function plasmaSpriteTexture(){
  if (plasmaTex) return plasmaTex;
  const s = 192, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d'), cx = s / 2, cy = s / 2;
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, s * 0.48);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.10, 'rgba(120,255,255,0.95)');
  g.addColorStop(0.28, 'rgba(78,102,255,0.68)');
  g.addColorStop(0.52, 'rgba(255,58,230,0.42)');
  g.addColorStop(0.78, 'rgba(255,205,65,0.18)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, s, s);
  c.globalCompositeOperation = 'screen';
  for (let i = 0; i < 18; i++) {
    const a = i * Math.PI * 2 / 18;
    const r = 18 + (i % 5) * 6;
    c.strokeStyle = i % 3 === 0 ? 'rgba(255,240,90,0.13)' : 'rgba(85,245,255,0.14)';
    c.lineWidth = 1.0 + (i % 3) * 0.45;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    c.quadraticCurveTo(cx + Math.cos(a + 0.55) * 36, cy + Math.sin(a + 0.55) * 36,
      cx + Math.cos(a + 0.18) * 82, cy + Math.sin(a + 0.18) * 82);
    c.stroke();
  }
  plasmaTex = new THREE.CanvasTexture(cv);
  plasmaTex.colorSpace = THREE.SRGBColorSpace;
  return plasmaTex;
}
function plasmaSmokeTexture(){
  if (plasmaSmokeTex) return plasmaSmokeTex;
  const s = 160, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d'), cx = s / 2, cy = s / 2;
  for (let i = 0; i < 8; i++) {
    const ox = (Math.random() - 0.5) * s * 0.20, oy = (Math.random() - 0.5) * s * 0.16;
    const r = s * (0.18 + Math.random() * 0.18);
    const g = c.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
    g.addColorStop(0.00, 'rgba(12,11,10,0.58)');
    g.addColorStop(0.45, 'rgba(18,16,14,0.30)');
    g.addColorStop(1.00, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(cx + ox, cy + oy, r, 0, Math.PI * 2); c.fill();
  }
  const core = c.createRadialGradient(cx, cy, 0, cx, cy, s * 0.46);
  core.addColorStop(0, 'rgba(0,0,0,0.55)');
  core.addColorStop(0.55, 'rgba(25,21,18,0.26)');
  core.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = core; c.fillRect(0, 0, s, s);
  plasmaSmokeTex = new THREE.CanvasTexture(cv);
  plasmaSmokeTex.colorSpace = THREE.SRGBColorSpace;
  return plasmaSmokeTex;
}
function plasmaGroundTexture(){
  if (plasmaGroundTex) return plasmaGroundTex;
  const s = 192, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d'), cx = s / 2, cy = s / 2;
  c.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = s * (0.04 + Math.random() * 0.18);
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    const r = s * (0.16 + Math.random() * 0.20);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0.00, 'rgba(3,2,2,0.86)');
    g.addColorStop(0.48, 'rgba(7,5,4,0.55)');
    g.addColorStop(0.78, 'rgba(21,15,12,0.20)');
    g.addColorStop(1.00, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r0 = s * (0.25 + Math.random() * 0.18);
    const x = cx + Math.cos(a) * r0, y = cy + Math.sin(a) * r0;
    c.fillStyle = `rgba(78,61,48,${0.08 + Math.random() * 0.08})`;
    c.beginPath();
    c.ellipse(x, y, s * (0.018 + Math.random() * 0.035), s * (0.010 + Math.random() * 0.025), a, 0, Math.PI * 2);
    c.fill();
  }
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = 'rgba(0,0,0,0.30)';
  c.lineWidth = 2;
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, r0 = s * (0.16 + Math.random() * 0.22);
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    c.lineTo(cx + Math.cos(a + (Math.random() - 0.5) * 0.45) * (r0 + s * (0.08 + Math.random() * 0.14)),
      cy + Math.sin(a + (Math.random() - 0.5) * 0.45) * (r0 + s * (0.08 + Math.random() * 0.14)));
    c.stroke();
  }
  plasmaGroundTex = new THREE.CanvasTexture(cv);
  plasmaGroundTex.colorSpace = THREE.SRGBColorSpace;
  return plasmaGroundTex;
}
// kipinäpooli: stateless-näköiset hehkupisteet (per-piste alfa+koko) jotka
// sinkoavat säteestä kohtisuoraan ulos ja häipyvät. Pehmeä pyöreä piste.
function makeSparks(){
  const g = new THREE.BufferGeometry();
  _spkPos = new Float32Array(SPARK_POOL * 3);
  _spkVel = new Float32Array(SPARK_POOL * 3);
  _spkLife = new Float32Array(SPARK_POOL);
  _spkMax = new Float32Array(SPARK_POOL);
  _spkSize = new Float32Array(SPARK_POOL);
  g.setAttribute('position', new THREE.BufferAttribute(_spkPos, 3));
  g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(SPARK_POOL), 1));   // alfa, alku 0 → ei näy
  g.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(SPARK_POOL), 1));   // pistekoko
  sparkMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color().setRGB(2.2, 1.05, 0.55) } },
    vertexShader: `
      attribute float aA; attribute float aS; varying float vA;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){
        vA = aA;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = clamp(aS * 90.0 / max(1.0, -mvPosition.z), 1.0, 7.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      varying float vA;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      void main(){
        #include <logdepthbuf_fragment>
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, r) * vA);
      }`,
  });
  sparks = new THREE.Points(g, sparkMat);
  sparks.frustumCulled = false; sparks.renderOrder = 6;
  sparkGeo = g; _spkHead = 0;
  return sparks;
}
// sinkoa kipinöitä PISTEESTÄ (origin) annettuun pääsuuntaan kapeana viuhkana.
// Käytetään osumakohdassa: kipinät lentävät iskupisteestä ulospäin (kimmonta).
const _sd = new THREE.Vector3();
function spawnSparksAt(ox, oy, oz, dx, dy, dz){
  if (!sparks) return;
  const aS = sparkGeo.attributes.aS.array;
  _sd.set(dx, dy, dz); if (_sd.lengthSq() < 1e-6) _sd.set(0, 1, 0); _sd.normalize();
  // kaksi kohtisuoraa akselia pääsuunnalle
  _bx.set(0, 1, 0); if (Math.abs(_sd.y) > 0.9) _bx.set(1, 0, 0);
  _bz.crossVectors(_sd, _bx).normalize(); _bx.crossVectors(_bz, _sd).normalize();
  const n = 7 + (Math.random() * 6 | 0);          // pieni purske
  for (let k = 0; k < n; k++) {
    const ang = Math.random() * 6.2832, ca = Math.cos(ang), sa = Math.sin(ang);
    const ux = _bx.x * ca + _bz.x * sa, uy = _bx.y * ca + _bz.y * sa, uz = _bx.z * ca + _bz.z * sa;   // sivusuunta
    const fwdSp = 3 + Math.random() * 6, sideSp = Math.random() * 3.2;
    const i = _spkHead; _spkHead = (_spkHead + 1) % SPARK_POOL;
    _spkPos[i * 3] = ox; _spkPos[i * 3 + 1] = oy; _spkPos[i * 3 + 2] = oz;
    _spkVel[i * 3] = _sd.x * fwdSp + ux * sideSp;
    _spkVel[i * 3 + 1] = _sd.y * fwdSp + uy * sideSp + 0.6;   // pieni nosto
    _spkVel[i * 3 + 2] = _sd.z * fwdSp + uz * sideSp;
    _spkMax[i] = _spkLife[i] = 0.12 + Math.random() * 0.20;       // lyhytikäisiä
    _spkSize[i] = 1.0 + Math.random() * 1.4;
    aS[i] = _spkSize[i];
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.aS.needsUpdate = true;
}
function updateSparks(dt){
  if (!sparks) return;
  const pos = sparkGeo.attributes.position.array, aA = sparkGeo.attributes.aA.array;
  let any = false;
  for (let i = 0; i < SPARK_POOL; i++) {
    if (_spkLife[i] <= 0) { if (aA[i] !== 0) { aA[i] = 0; any = true; } continue; }
    _spkLife[i] -= dt;
    if (_spkLife[i] <= 0) { aA[i] = 0; any = true; continue; }
    const drag = 1 - Math.min(1, 2.6 * dt);
    _spkVel[i * 3] *= drag; _spkVel[i * 3 + 1] -= 4.2 * dt; _spkVel[i * 3 + 2] *= drag;   // ilmanvastus + kevyt painovoima
    pos[i * 3] += _spkVel[i * 3] * dt; pos[i * 3 + 1] += _spkVel[i * 3 + 1] * dt; pos[i * 3 + 2] += _spkVel[i * 3 + 2] * dt;
    aA[i] = (_spkLife[i] / _spkMax[i]) * 0.7;       // himmeä (faint)
    any = true;
  }
  if (any) { sparkGeo.attributes.position.needsUpdate = true; sparkGeo.attributes.aA.needsUpdate = true; }
}
let gun = null, _rifleView = null, _muzzleFlash = null, _muzzleDepthFlash = null;
function buildGun(){
  const g = new THREE.Group();
  const rifleMat = new THREE.MeshBasicMaterial({
    map: rifleTex(),
    transparent: true,
    alphaTest: 0.03,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  rifleMat.color.setRGB(1.08, 1.08, 1.08);
  const rifle = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.542), rifleMat);
  rifle.position.set(0.12, -0.0, 0.0);
  rifle.renderOrder = 20;
  g.add(rifle);
  _rifleView = rifle;
  g.traverse(o => { if (o.isMesh) o.userData.viewmodel = true; });   // raycastit ohittavat aseen
  // suuliekki: kirkas kiekko piipun kärjessä, kääntyy katselijaa kohti, syttyy laukauksessa
  const fm = new THREE.MeshBasicMaterial({ map: flashTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0 });
  fm.color.setRGB(3.2, 1.3, 0.7);
  _muzzleFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), fm);
  _muzzleFlash.position.set(-0.17, 0.26, 0.018);
  _muzzleFlash.renderOrder = 21;
  g.add(_muzzleFlash);
  _muzzleDepthFlash = new THREE.Mesh(new THREE.SphereGeometry(0.075, 18, 10), muzzleDepthMat());
  _muzzleDepthFlash.position.set(-0.17, 0.26, -0.035);
  _muzzleDepthFlash.renderOrder = 20;
  g.add(_muzzleDepthFlash);
  g.position.copy(GUN_POS); g.rotation.set(GUN_ROT.x, GUN_ROT.y, GUN_ROT.z);
  g.visible = false; camera.add(g);
  return g;
}
gun = buildGun();
function buildPlasmaGun(){
  const g = new THREE.Group();
  const hullMat = toonMat({ color: 0x596f7e }); loadToolTex(hullMat, 'metal_plate_02', 1.6, 1);
  const darkMat = toonMat({ color: 0x252d36 }); loadToolTex(darkMat, 'metal_plate', 1, 1);
  const coilMat = toonMat({ color: 0x91a1ad }); loadToolTex(coilMat, 'metal_plate', 1, 1);
  const trimMat = toonMat({ color: 0xd0d7df }); loadToolTex(trimMat, 'metal_plate_02', 1, 1);
  const warmTrimMat = toonMat({ color: 0xd6a94f }); loadToolTex(warmTrimMat, 'metal_plate_02', 1, 1);
  addToolHeadlamp(hullMat); addToolHeadlamp(darkMat); addToolHeadlamp(coilMat); addToolHeadlamp(trimMat);
  addToolHeadlamp(warmTrimMat);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x49e8ff });
  const hotMat = new THREE.MeshBasicMaterial({ color: 0xff4df0 });
  const meterMat = new THREE.MeshBasicMaterial({ color: 0x66fff0 });
  const box = (mat, w, h, d, x, y, z, rx, ry, rz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
    g.add(m); return m;
  };
  const cyl = (mat, r1, r2, len, x, y, z, sides = 16, rx = Math.PI / 2) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, sides), mat);
    m.rotation.x = rx; m.position.set(x, y, z); g.add(m); return m;
  };

  box(hullMat, 0.24, 0.18, 0.38, 0, -0.01, 0.04);
  box(hullMat, 0.20, 0.13, 0.38, 0, 0.015, -0.27);
  box(darkMat, 0.26, 0.045, 0.36, 0, -0.12, -0.06);
  box(darkMat, 0.095, 0.28, 0.12, 0, -0.22, 0.11, -0.24);
  box(hullMat, 0.18, 0.08, 0.22, 0, -0.035, 0.36);
  box(trimMat, 0.21, 0.018, 0.30, 0, 0.092, 0.04);
  box(warmTrimMat, 0.035, 0.016, 0.22, -0.128, 0.018, 0.04, 0, 0, 0.12);
  box(warmTrimMat, 0.035, 0.016, 0.22,  0.128, 0.018, 0.04, 0, 0, -0.12);

  // Avoin plasma-kammio ja kolme magneettikelaa: selvästi eri siluetti kuin laserilla.
  cyl(darkMat, 0.050, 0.056, 0.74, 0, 0.02, -0.55, 18);
  cyl(glowMat, 0.030, 0.034, 0.52, 0, 0.02, -0.52, 16);
  for (let i = 0; i < 5; i++) {
    cyl(coilMat, 0.082, 0.082, 0.035, 0, 0.02, -0.30 - i * 0.10, 18);
    cyl(warmTrimMat, 0.087, 0.087, 0.010, 0, 0.02, -0.30 - i * 0.10 + 0.024, 18);
  }
  for (const sx of [-1, 1]) {
    cyl(trimMat, 0.022, 0.022, 0.62, sx * 0.105, 0.02, -0.53, 10);
    for (let i = 0; i < 4; i++) box(darkMat, 0.025, 0.025, 0.04, sx * 0.105, 0.02, -0.35 - i * 0.13);
    box(hullMat, 0.034, 0.105, 0.25, sx * 0.132, -0.035, -0.26, 0, 0, sx * 0.22);
    box(trimMat, 0.012, 0.022, 0.32, sx * 0.134, 0.092, -0.32, 0, sx * 0.18, 0);
  }
  cyl(trimMat, 0.075, 0.10, 0.13, 0, 0.02, -0.91, 18);
  cyl(hotMat, 0.052, 0.065, 0.03, 0, 0.02, -0.995, 18);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI * 2 / 6;
    const fin = box(trimMat, 0.018, 0.044, 0.13, Math.cos(a) * 0.088, 0.02 + Math.sin(a) * 0.088, -0.91, 0, 0, a);
    fin.lookAt(0, 0.02, -1.08);
  }

  // Kyljen kondensaattorit, paineletku ja latausmittari.
  for (const sx of [-1, 1]) {
    cyl(darkMat, 0.026, 0.026, 0.22, sx * 0.145, -0.005, -0.02, 12);
    box(trimMat, 0.025, 0.06, 0.05, sx * 0.145, 0.065, -0.18);
    for (let i = 0; i < 4; i++) box(darkMat, 0.018, 0.012, 0.09, sx * 0.074, -0.222 + i * 0.035, 0.11, -0.24);
    for (const z of [-0.08, 0.18]) cyl(warmTrimMat, 0.010, 0.010, 0.010, sx * 0.126, 0.074, z, 8);
  }
  box(darkMat, 0.055, 0.030, 0.32, 0, 0.152, -0.10);
  for (let i = 0; i < 6; i++) box(trimMat, 0.070, 0.010, 0.016, 0, 0.173, -0.24 + i * 0.058);
  cyl(darkMat, 0.030, 0.030, 0.15, 0, 0.214, -0.12, 12);
  cyl(glowMat, 0.017, 0.017, 0.155, 0, 0.214, -0.12, 12);
  const cable = new THREE.Mesh(new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.11, 0.085, 0.23),
      new THREE.Vector3(-0.16, 0.105, 0.00),
      new THREE.Vector3(-0.12, 0.075, -0.32),
      new THREE.Vector3(-0.04, 0.055, -0.48),
    ]), 16, 0.008, 6), darkMat);
  g.add(cable);
  box(darkMat, 0.17, 0.022, 0.13, 0, 0.132, 0.02);
  plasmaMeter = box(meterMat, 0.142, 0.018, 0.01, -0.071, 0.148, 0.02);
  plasmaMeter.userData.baseW = 0.142;
  plasmaMeter.scale.x = 0.05;
  plasmaCore = cyl(glowMat, 0.038, 0.038, 0.11, 0, 0.02, -0.18, 14);
  for (const sx of [-1, 1]) {
    const tube = new THREE.Mesh(new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(sx * 0.062, 0.048, 0.18),
        new THREE.Vector3(sx * 0.088, 0.074, -0.04),
        new THREE.Vector3(sx * 0.068, 0.050, -0.30),
      ]), 12, 0.004, 5), glowMat);
    g.add(tube);
  }

  addOutlines(g, 0.012);
  g.traverse(o => { if (o.isMesh) o.userData.viewmodel = true; });
  g.position.copy(PLASMA_POS); g.rotation.set(PLASMA_ROT.x, PLASMA_ROT.y, PLASMA_ROT.z);
  g.visible = false; camera.add(g);
  return g;
}
plasmaGun = buildPlasmaGun();

function ensureScope(){
  if (scopeEl) return scopeEl;
  scopeEl = document.createElement('div');
  scopeEl.id = 'sniperScope';
  scopeEl.style.cssText = 'position:fixed;inset:0;z-index:7;pointer-events:none;display:none;mix-blend-mode:screen;'
    + 'background:radial-gradient(circle at center, transparent 0 18%, rgba(0,0,0,0.12) 23%, rgba(0,0,0,0.56) 58%, rgba(0,0,0,0.82) 100%);';
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;left:50%;top:50%;width:min(54vw,54vh);aspect-ratio:1;transform:translate(-50%,-50%);'
    + 'border:1px solid rgba(160,245,255,0.62);border-radius:50%;box-shadow:0 0 14px rgba(98,232,255,0.36), inset 0 0 22px rgba(98,232,255,0.12);';
  const ring2 = document.createElement('div');
  ring2.style.cssText = 'position:absolute;left:50%;top:50%;width:min(20vw,20vh);aspect-ratio:1;transform:translate(-50%,-50%);'
    + 'border:1px solid rgba(160,245,255,0.32);border-radius:50%;';
  const h = document.createElement('div');
  h.style.cssText = 'position:absolute;left:50%;top:50%;width:min(58vw,58vh);height:1px;transform:translate(-50%,-50%);'
    + 'background:linear-gradient(90deg, transparent, rgba(180,250,255,0.75) 38%, transparent 38% 44%, rgba(180,250,255,0.95) 44% 56%, transparent 56% 62%, rgba(180,250,255,0.75) 62%, transparent);';
  const v = document.createElement('div');
  v.style.cssText = 'position:absolute;left:50%;top:50%;height:min(58vw,58vh);width:1px;transform:translate(-50%,-50%);'
    + 'background:linear-gradient(0deg, transparent, rgba(180,250,255,0.75) 38%, transparent 38% 44%, rgba(180,250,255,0.95) 44% 56%, transparent 56% 62%, rgba(180,250,255,0.75) 62%, transparent);';
  scopeEl.append(ring, ring2, h, v);
  document.body.appendChild(scopeEl);
  return scopeEl;
}
function setScopeVisible(on){
  ensureScope().style.display = on ? 'block' : 'none';
}
export function toggleSniperMode(){
  if (!active || toolMode !== TOOL_LASER) return false;
  sniperMode = !sniperMode;
  setScopeVisible(sniperMode);
  return sniperMode;
}
export function isSniperMode(){ return active && weaponMode && sniperMode; }
export function lookSensitivityMul(){ return isSniperMode() ? SNIPER_LOOK_MUL : 1; }
function updateSniper(dt){
  const target = isSniperMode() && toolMode === TOOL_LASER ? 1 : 0;
  sniperAmt += (target - sniperAmt) * Math.min(1, dt * 12);
  const fov = SURFACE_FOV + (SNIPER_FOV - SURFACE_FOV) * sniperAmt;
  if (Math.abs(camera.fov - fov) > 0.02) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  if (scopeEl) scopeEl.style.opacity = (sniperAmt * 0.96).toFixed(3);
  if (!target && sniperAmt < 0.01 && scopeEl) scopeEl.style.display = 'none';
}
function updatePlasmaGun(dt, fireInput){
  _gunT += dt;
  plasmaCd = Math.max(0, plasmaCd - dt);
  if (fireInput && plasmaCd <= 0) {
    plasmaCharging = true;
    plasmaCharge = Math.min(PLASMA_CHARGE_T, plasmaCharge + dt);
  } else if (plasmaCharging) {
    const p = plasmaCharge / PLASMA_CHARGE_T;
    if (p >= PLASMA_MIN_CHARGE && plasmaCd <= 0) firePlasma(Math.min(1, p));
    plasmaCharging = false;
    plasmaCharge = 0;
  }
  const c = Math.min(1, plasmaCharge / PLASMA_CHARGE_T);
  const pulse = 0.75 + 0.25 * Math.sin(S.simTime * 18);
  plasmaGun.position.set(
    PLASMA_POS.x,
    PLASMA_POS.y + Math.sin(_gunT * 1.3) * 0.003,
    PLASMA_POS.z + c * 0.05
  );
  plasmaGun.rotation.set(PLASMA_ROT.x - c * 0.04, PLASMA_ROT.y, PLASMA_ROT.z);
  if (plasmaMeter) {
    const w = plasmaMeter.userData.baseW || 0.142;
    plasmaMeter.scale.x = Math.max(0.05, c);
    plasmaMeter.position.x = -0.070 + w * 0.5 * c;
    plasmaMeter.material.color.setHSL(0.50 + 0.34 * c, 1, 0.42 + 0.18 * pulse);
  }
  if (plasmaCore) {
    const sc = 0.65 + c * 0.75 + pulse * c * 0.18;
    plasmaCore.scale.setScalar(sc);
    plasmaCore.material.color.setHSL(0.56 + 0.22 * c, 1, 0.45 + 0.20 * c);
  }
}
function updateGun(dt){
  _gunT += dt;
  recoil += (0 - recoil) * Math.min(1, dt * 14);   // rekyyli laantuu nopeasti
  const aim = sniperAmt;
  const viewAlpha = Math.max(0, Math.min(1, 1 - sniperAmt * 1.35));
  gun.position.set(
    GUN_POS.x + (GUN_AIM_POS.x - GUN_POS.x) * aim,
    GUN_POS.y + (GUN_AIM_POS.y - GUN_POS.y) * aim + Math.sin(_gunT * 1.6) * 0.004 * (1 - aim * 0.75),
    GUN_POS.z + (GUN_AIM_POS.z - GUN_POS.z) * aim + recoil * 0.14
  );
  gun.rotation.set(
    GUN_ROT.x + (GUN_AIM_ROT.x - GUN_ROT.x) * aim - recoil * 0.22,
    GUN_ROT.y + (GUN_AIM_ROT.y - GUN_ROT.y) * aim + Math.sin(_gunT * 1.3) * 0.006 * (1 - aim * 0.75),
    GUN_ROT.z + (GUN_AIM_ROT.z - GUN_ROT.z) * aim
  );
  if (_rifleView) {
    _rifleView.material.opacity = viewAlpha;
    _rifleView.visible = viewAlpha > 0.02;
  }
  if (_muzzleFlash) {
    // välähtää kirkkaana laukauksessa ja kutistuu nopeasti (rekyylin mukana)
    _muzzleFlash.material.opacity = Math.max(0, recoil * 1.4 - 0.15) * viewAlpha;
    const sc = 0.5 + recoil * 0.65;
    _muzzleFlash.scale.set(sc * 1.12, sc * 0.88, sc);
  }
  if (_muzzleDepthFlash) {
    _muzzleDepthFlash.material.uniforms.uAlpha.value = Math.max(0, recoil * 0.68 - 0.10) * viewAlpha;
    _muzzleDepthFlash.material.uniforms.uTime.value = S.simTime;
    const sc = 0.45 + recoil * 0.75;
    _muzzleDepthFlash.scale.set(sc * 1.08, sc * 0.90, sc * 2.8);
  }
}
function makePlasmaShot(){
  const g = new THREE.Group();
  g.userData.debris = true;
  const tex = plasmaSpriteTexture();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 18, 10),
    new THREE.MeshBasicMaterial({ color: 0x5fffff })
  );
  const outer = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 18, 10),
    new THREE.MeshBasicMaterial({ color: 0xff4df2, transparent: true, opacity: 0.50, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.035, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.018, 8, 28),
    new THREE.MeshBasicMaterial({ color: 0x72f7ff, transparent: true, opacity: 0.70, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  halo.rotation.x = Math.PI / 2;
  ring2.rotation.set(0.7, 0.2, 0.4);
  const spriteMat = new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: 0.92,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true
  });
  const aura = new THREE.Sprite(spriteMat);
  aura.scale.set(1.05, 1.05, 1);
  const trailMat = spriteMat.clone();
  trailMat.opacity = 0.48;
  trailMat.color.set(0xff6af7);
  const trail = new THREE.Sprite(trailMat);
  trail.position.z = 0.18;
  trail.scale.set(0.95, 0.55, 1);
  const light = new THREE.PointLight(0x66eaff, 0, 9, 2);
  g.add(trail, aura, outer, core, halo, ring2, light);
  g.visible = false;
  return { group: g, core, outer, halo, ring2, aura, trail, light, vel: new THREE.Vector3(), life: 0, maxLife: 0, power: 0 };
}
function initPlasmaShots(sc){
  plasmaShots = [];
  for (let i = 0; i < PLASMA_POOL; i++) {
    const s = makePlasmaShot();
    sc.add(s.group);
    plasmaShots.push(s);
  }
}
function initPlasmaPuffs(sc){
  plasmaPuffs = [];
  const tex = plasmaSmokeTexture();
  for (let i = 0; i < PLASMA_SMOKE_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex, color: 0x5f5042, transparent: true, opacity: 0,
      depthWrite: false, depthTest: true
    });
    const m = new THREE.Sprite(mat);
    m.visible = false;
    m.userData.debris = true;
    sc.add(m);
    plasmaPuffs.push({ m, vel: new THREE.Vector3(), life: 0, max: 0, base: 1, spin: 0 });
  }
}
function initPlasmaGroundMarks(sc){
  plasmaGroundMarks = [];
  plasmaGroundMarkHead = 0;
  const tex = plasmaGroundTexture();
  const geo = new THREE.PlaneGeometry(1, 1, 20, 16);
  for (let i = 0; i < PLASMA_GROUND_MARK_POOL; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.renderOrder = 2;
    m.userData.debris = true;
    sc.add(m);
    plasmaGroundMarks.push(m);
  }
}
function plasmaGroundNormal(x, z){
  if (!heightFn) return _plGroundN.set(0, 1, 0);
  const e = 0.55;
  const hl = heightFn(x - e, z), hr = heightFn(x + e, z);
  const hd = heightFn(x, z - e), hu = heightFn(x, z + e);
  return _plGroundN.set(-(hr - hl) / (2 * e), 1, -(hu - hd) / (2 * e)).normalize();
}
function spawnPlasmaGroundMark(point, power = 1){
  if (!plasmaGroundMarks.length) return;
  const m = plasmaGroundMarks[plasmaGroundMarkHead];
  plasmaGroundMarkHead = (plasmaGroundMarkHead + 1) % plasmaGroundMarks.length;
  const n = plasmaGroundNormal(point.x, point.z);
  m.position.copy(point).addScaledVector(n, 0.024);
  m.quaternion.setFromUnitVectors(_plGroundPlaneN, n);
  m.rotateZ(Math.random() * Math.PI * 2);
  const s = 2.1 + power * 1.45;
  m.scale.set(s * (1.0 + Math.random() * 0.25), s * (0.72 + Math.random() * 0.20), 1);
  m.material.opacity = 0.78;
  m.visible = true;
}
function spawnPlasmaGroundPuff(point, power = 1){
  if (!plasmaPuffs.length) return;
  let p = plasmaPuffs.find(x => x.life <= 0) || plasmaPuffs[0];
  p.m.position.copy(point);
  p.m.position.y += 0.06;
  p.m.visible = true;
  p.max = p.life = 1.15 + power * 0.32;
  p.base = 1.1 + power * 0.55;
  p.spin = (Math.random() - 0.5) * 0.9;
  p.vel.set((Math.random() - 0.5) * 0.12, 0.16 + power * 0.10, (Math.random() - 0.5) * 0.12);
  p.m.scale.setScalar(p.base * 0.28);
  p.m.material.opacity = 0.34;
  p.m.material.rotation = Math.random() * Math.PI * 2;
}
function spawnPlasmaGroundImpact(point, power = 1){
  spawnPlasmaGroundMark(point, power);
  spawnPlasmaGroundPuff(point, power);
  if (flashLight) {
    flashLight.color.setHSL(0.07, 0.65, 0.42);
    flashLight.position.copy(point);
    flashLight.position.y += 0.08;
    _flLife = _flMax = 0.18 + power * 0.08;
    _flPeak = 8 + power * 8;
    flashLight.intensity = _flPeak;
  }
}
function updatePlasmaPuffs(dt){
  for (const p of plasmaPuffs) {
    if (p.life <= 0) { if (p.m.visible) p.m.visible = false; continue; }
    p.life -= dt;
    if (p.life <= 0) { p.m.visible = false; p.m.material.opacity = 0; continue; }
    const k = 1 - p.life / p.max;
    p.vel.y += 0.06 * dt;
    p.m.position.addScaledVector(p.vel, dt);
    const sc = p.base * (0.35 + k * 1.55);
    p.m.scale.set(sc, sc * (0.72 + k * 0.25), 1);
    p.m.material.opacity = 0.34 * (1 - k) * (1 - k * 0.35);
    p.m.material.rotation += p.spin * dt;
  }
}
function hasBlockedRayFlag(o){
  let p = o;
  while (p) {
    const u = p.userData;
    if (u && (u.debris || u.terrain || u.viewmodel)) return true;
    p = p.parent;
  }
  return false;
}
function refreshPlasmaTargets(dt = 0, force = false){
  if (!scene) return;
  plasmaTargetRefresh -= dt;
  if (!force && plasmaTargetRefresh > 0) return;
  plasmaTargetRefresh = 0.35;
  const list = [];
  const seen = new Set();
  const add = (o) => {
    if (!o || seen.has(o) || hasBlockedRayFlag(o)) return;
    seen.add(o);
    list.push(o);
  };
  for (const d of deposits) if (d.mesh && d.mesh.visible && d.pop >= 0.5) add(d.mesh);
  scene.traverse(o => {
    if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) return;
    if (!o.visible || !o.material || hasBlockedRayFlag(o)) return;
    const u = o.userData || {};
    if (u.enemy || u.scatter || u.shuttle) add(o);
  });
  plasmaTargets = list;
}
function depositForObject(o){
  for (const d of deposits) {
    let p = o;
    while (p) {
      if (p === d.mesh) return d;
      p = p.parent;
    }
  }
  return null;
}
function applyPlasmaDamage(h, power){
  const dep = depositForObject(h.object);
  if (dep) {
    spawnBurst(dep.x, dep.y + 0.5, dep.z, dep.type);
    S.inv[dep.type] = (S.inv[dep.type] || 0) + 1;
    if (dep === mineTarget) { restoreMesh(mineTarget); mineTarget = null; mineProg = 0; }
    relocate(dep, camera.position.x, camera.position.z);
    renderHud(); pulse();
    return;
  }
  if (_gunHitHandler) _gunHitHandler(h, { plasma: true, amount: PLASMA_DMG * power, big: true });
}
function plasmaImpact(point, power){
  spawnSparksAt(point.x, point.y, point.z, -_fwd.x, -_fwd.y, -_fwd.z);
  for (let i = 0; i < 3; i++) emitBurst(point.x, point.y + 0.15, point.z, oreMats[ORE[0].type], FINAL_BURST);
  if (flashLight) {
    flashLight.color.setHSL(0.55 + Math.random() * 0.18, 1, 0.62);
    flashLight.position.copy(point);
    _flLife = _flMax = 0.26 + power * 0.12;
    _flPeak = 14 + power * 14;
    flashLight.intensity = _flPeak;
  }
}
function firePlasma(power){
  if (!scene) return;
  if (!plasmaTargets.length) refreshPlasmaTargets(0, true);
  camera.getWorldDirection(_fwd); camera.updateMatrixWorld();
  _muz.set(0.05, -0.10, -1.28).applyMatrix4(camera.matrixWorld);
  let s = plasmaShots.find(p => p.life <= 0);
  if (!s) s = plasmaShots[0];
  s.group.position.copy(_muz);
  s.group.scale.setScalar(0.85 + power * 0.8);
  s.group.visible = true;
  s.vel.copy(_fwd).multiplyScalar(PLASMA_SPEED * (0.78 + power * 0.38));
  s.life = s.maxLife = 1.8 + power * 0.8;
  s.power = power;
  s.light.intensity = 6 + power * 12;
  recoil = Math.max(recoil, 0.75 + power * 0.35);
  plasmaCd = 0.35;
}
function updatePlasmaShots(dt){
  if (!scene || !plasmaShots.length) return;
  let anyActive = false;
  for (const s of plasmaShots) {
    if (s.life > 0) { anyActive = true; break; }
    if (s.group.visible) s.group.visible = false;
  }
  if (!anyActive) return;
  refreshPlasmaTargets(dt);
  for (const s of plasmaShots) {
    if (s.life <= 0) { if (s.group.visible) s.group.visible = false; continue; }
    s.life -= dt;
    if (s.life <= 0) { s.group.visible = false; s.light.intensity = 0; continue; }
    const step = Math.max(0.01, s.vel.length() * dt);
    _segDir.copy(s.vel).normalize();
    _ray.set(s.group.position, _segDir);
    _ray.near = 0;
    _ray.far = step + 0.45 * s.group.scale.x;
    _ray.camera = camera;
    const hits = plasmaTargets.length ? _ray.intersectObjects(plasmaTargets, true) : [];
    let hit = null;
    for (const h of hits) {
      const o = h.object;
      if (!o.visible || !o.material) continue;
      let skip = false, p = o;
      while (p) {
        if (p.userData && (p.userData.debris || p.userData.terrain)) { skip = true; break; }
        p = p.parent;
      }
      if (skip) continue;
      if (o.material.isMeshBasicMaterial && !(o.userData && o.userData.enemy)) continue;
      hit = h; break;
    }
    if (hit) {
      plasmaImpact(hit.point, s.power);
      applyPlasmaDamage(hit, s.power);
      s.life = 0; s.group.visible = false; s.light.intensity = 0;
      continue;
    }
    _plNext.copy(s.group.position).addScaledVector(s.vel, dt);
    if (heightFn) {
      const gyNext = heightFn(_plNext.x, _plNext.z);
      if (_plNext.y <= gyNext + 0.12) {
        _plHit.copy(s.group.position);
        for (let i = 0; i < 5; i++) {
          _plHit.lerp(_plNext, 0.5);
          const gy = heightFn(_plHit.x, _plHit.z);
          if (_plHit.y > gy + 0.10) s.group.position.copy(_plHit);
          else _plNext.copy(_plHit);
        }
        _plHit.y = heightFn(_plHit.x, _plHit.z) + 0.08;
        spawnPlasmaGroundImpact(_plHit, s.power);
        s.life = 0; s.group.visible = false; s.light.intensity = 0;
        continue;
      }
    }
    s.group.position.copy(_plNext);
    s.halo.rotation.z += dt * 12;
    s.halo.rotation.y += dt * 4;
    s.ring2.rotation.x += dt * 7;
    s.ring2.rotation.z -= dt * 9;
    const hue = (S.simTime * 0.7 + s.power * 0.3) % 1;
    const age = 1 - Math.max(0, s.life / (s.maxLife || 1));
    const pulse = 0.78 + 0.22 * Math.sin(S.simTime * 34 + s.power * 5);
    s.core.material.color.setHSL(hue, 1, 0.62);
    s.outer.material.color.setHSL((hue + 0.28) % 1, 1, 0.55);
    s.outer.material.opacity = 0.38 + pulse * 0.22;
    s.halo.material.color.setHSL((hue + 0.12) % 1, 1, 0.58);
    s.halo.material.opacity = 0.58 + pulse * 0.24;
    s.ring2.material.color.setHSL((hue + 0.48) % 1, 1, 0.62);
    s.ring2.material.opacity = 0.48 + pulse * 0.22;
    s.aura.material.rotation += dt * (1.3 + s.power);
    s.trail.material.rotation -= dt * 1.7;
    s.aura.material.opacity = (0.72 + pulse * 0.25) * (1 - age * 0.2);
    s.trail.material.opacity = 0.30 + pulse * 0.20;
    s.trail.position.copy(_segDir).multiplyScalar(-0.28 - s.power * 0.16);
    s.light.color.setHSL(hue, 1, 0.62);
    s.light.intensity = (5 + s.power * 12) * (0.75 + pulse * 0.25);
  }
}
// ensimmäinen kiinteä osuma edessä (maasto/kivi/mineraali/objekti); palauttaa intersectionin
function gunRaycast(){
  _ray.set(camera.position, _fwd); _ray.near = 0.3; _ray.far = 140;
  _ray.camera = camera;
  const objs = scene.children.filter(o => o !== camera);
  const hits = _ray.intersectObjects(objs, true);
  for (const h of hits) {
    const o = h.object;
    if (!o.visible || !o.material) continue;
    if (o.userData && o.userData.debris) continue;
    if (o.material.isMeshBasicMaterial) continue;   // ääriviivat / hehkut
    return h;
  }
  return null;
}
// pieni iskupurske (kivi/mineraali) annetun materiaalin värissä — surface.js käyttää tätä kiville
export function spawnHitDebris(x, y, z, material, big){
  emitBurst(x, y, z, material, big ? FINAL_BURST : STRIKE_BURST);
}
// laserin osuma: mineraalit hoidetaan tässä (HP + tuhoutuminen + malmi), muut (kivet/sukkula)
// rekisteröidyssä käsittelijässä (surface.js)
function applyGunDamage(h){
  const dep = depositForObject(h.object);
  if (dep) { damageDeposit(dep, h.point); return; }
  if (_gunHitHandler) _gunHitHandler(h);
}
function damageDeposit(d, point){
  spawnHitDebris(point.x, point.y, point.z, oreMats[d.type], false);   // pieni malmisirupurske osumaan
  d.hp -= GUN_DMG;
  if (d.hp <= 0) {                                   // tuhoutuu → iso purske + malmi varastoon + ilmestyy muualle
    S.inv[d.type] = (S.inv[d.type] || 0) + 1;
    spawnBurst(d.x, d.y + 0.5, d.z, d.type);
    if (d === mineTarget) { restoreMesh(mineTarget); mineTarget = null; mineProg = 0; }
    relocate(d, camera.position.x, camera.position.z);
    renderHud(); pulse();
  }
}
function fireGun(){
  if (!scene) return;
  camera.getWorldDirection(_fwd); camera.updateMatrixWorld();
  _muz.set(0.22, -0.14, -1.4).applyMatrix4(camera.matrixWorld);   // suupiipun pää maailmassa
  const hit = gunRaycast();                                       // näkymätön hitscan → vahinko
  recoil = 1;   // rekyyli + suuliekki (vain aseeseen)
  if (flashLight) flashLight.color.set(0xff8a44);
  if (_muzzleFlash) _muzzleFlash.rotation.z = Math.random() * Math.PI * 2;   // satunnainen piikkikierto
  if (hit) {
    // kipinät lentävät OSUMAKOHDASTA ulospäin (takaisin ampujaa kohti = kimmonta)
    spawnSparksAt(hit.point.x, hit.point.y, hit.point.z, -_fwd.x, -_fwd.y, -_fwd.z);
    if (flashLight) { flashLight.position.copy(hit.point).addScaledVector(_fwd, -0.3); _flLife = _flMax = FLASH_LIFE; _flPeak = FLASH_LIGHT_INT; }
    applyGunDamage(hit);          // vahinko osumakohteeseen
  } else if (flashLight) {
    // ei osumaa: pelkkä suuliekin valo nokassa
    flashLight.position.copy(_muz).addScaledVector(_fwd, 0.3);
    _flLife = _flMax = FLASH_LIFE;
    _flPeak = FLASH_LIGHT_INT;
  }
}
function updateFlash(dt){
  if (flashLight && _flLife > 0) {
    _flLife -= dt;
    flashLight.intensity = _flLife > 0 ? _flPeak * (_flLife / _flMax) : 0;
  }
}
// X (pinnalla) vaihtaa aseen ja hakun välillä
export function toggleWeapon(){
  if (!active) return;
  toolMode = (toolMode + 1) % 3;
  weaponMode = toolMode !== TOOL_PICK;
  if (toolMode !== TOOL_LASER) {
    sniperMode = false;
    if (scopeEl) scopeEl.style.display = 'none';
  }
  if (toolMode !== TOOL_PLASMA) { plasmaCharging = false; plasmaCharge = 0; }
  recoil = 0;
  _prevLaserFire = false;
  _fireCd = Math.min(_fireCd, 0.04);
  if (mineTarget) { restoreMesh(mineTarget); mineTarget = null; mineProg = 0; }
}
export function isWeapon(){ return weaponMode; }

function makeDeposit(){
  const g = new THREE.Group();
  // kivimäinen lohkareklusteri (kuten tavalliset kivet), tyvi osin maan alle
  const n = 2 + Math.floor(Math.random() * 2);    // 2–3 lohkaretta
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(oreGeo, oreMats[ORE[0].type]);   // korvataan setOre:lla
    const s = 0.55 + Math.random() * 0.7;
    m.scale.setScalar(s);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    m.position.set((Math.random() - 0.5) * 1.5, s * 0.2, (Math.random() - 0.5) * 1.5);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
  addOutlines(g, 0.03);   // cell shading: musta ääriviiva (käänteinen kuori)
  return { mesh: g, type: 'rauta', x: 0, z: 0, y: 0, pop: 1, hp: DEP_HP };
}
function setOre(d, ore){
  d.type = ore.type;
  // vain kivilohkareet (toon) saavat malmin materiaalin — mustat ääriviivat
  // (MeshBasicMaterial) jätetään ennalleen
  for (const m of d.mesh.children) if (m.material.isMeshToonMaterial) m.material = oreMats[ore.type];
}
function relocate(d, px, pz){
  // syntyy pelaajan TAKAPUOLELLE/sivuille (ei näkyvään etukenttään) → ilmestymistä ei näe
  camera.getWorldDirection(_fwd);
  const behind = Math.atan2(_fwd.x, _fwd.z) + Math.PI;
  const ang = behind + (Math.random() - 0.5) * Math.PI * 1.1;   // ±99° taakse/sivulle
  const dist = NEAR + Math.random() * (FAR - NEAR);
  d.x = px + Math.sin(ang) * dist;
  d.z = pz + Math.cos(ang) * dist;
  d.y = heightFn ? heightFn(d.x, d.z) : 0;
  d.mesh.position.set(d.x, d.y, d.z);
  // ankkuroi jokainen lohkare PAIKALLISEEN maastoon (ei kellu rinteessä); keskus
  // hieman maaston yläpuolella → tyvi upoksissa mutta lohkare näkyy
  if (heightFn) for (const m of d.mesh.children) {
    const s = m.scale.x;
    m.position.y = heightFn(d.x + m.position.x, d.z + m.position.z) - d.y + s * 0.15;
  }
  setOre(d, pickOre());
  d.hp = DEP_HP;                                // nollaa piilo-osumapisteet
  d.pop = 0;                                    // kasvaa 0→1 (ilmestymisanimaatio)
  d.mesh.scale.setScalar(0.001);
}

/* kutsutaan pintascenen rakennuksesta; esiintymät Marsille ja Kuulle */
export function initMining(sc, name, hFn){
  clearMining();
  planetName = name;
  if (!ORE_SETS[name]) { renderHud(); return; }
  ORE = ORE_SETS[name];
  scene = sc; heightFn = hFn; active = true;
  oreGeo = makeOreRockGeo();
  oreMats = {};
  for (const o of ORE) {
    // CELL SHADING (kuten kivet): toon-materiaali, sama kivitekstuuri +
    // normaalikartta, väri vain hillitty tunnusvivahde
    oreMats[o.type] = toonMat({ color: o.col });
    if (rockMap) oreMats[o.type].map = rockMap;
    if (rockNor) oreMats[o.type].normalMap = rockNor;
  }
  for (let i = 0; i < COUNT; i++) {
    const d = makeDeposit();
    relocate(d, 0, 0);
    d.pop = 1; d.mesh.scale.setScalar(1);       // alussa täysikokoisia
    deposits.push(d);
    sc.add(d.mesh);
  }
  // murtumispurskeen sirupooli
  burstGeo = new THREE.OctahedronGeometry(0.13, 0);   // kidemäiset sirut
  bursts = [];
  for (let i = 0; i < BURST_POOL; i++) {
    const m = new THREE.Mesh(burstGeo, oreMats[ORE[0].type]);
    m.visible = false;
    m.userData.debris = true;   // hakun iskuraycast ohittaa omat sirut
    sc.add(m);
    bursts.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, max: 0, base: 1 });
  }
  sc.add(makeSparks());   // suuliekin kipinähiukkaset (Points)
  initPlasmaShots(sc);
  initPlasmaPuffs(sc);
  initPlasmaGroundMarks(sc);
  // suuliekin valo: yksi pysyvä PointLight (intensiteetti 0 lepotilassa → ei
  // shader-uudelleenkäännöstä per laukaus); valaisee lähiympäristön pimeässä
  flashLight = new THREE.PointLight(0xff8a44, 0, 20, 2);
  flashLight.castShadow = false;
  sc.add(flashLight);
  _flLife = 0;
  renderHud();
}
// sinkoa kivensiruja annetulla materiaalilla ja parametreilla (o = FINAL/STRIKE_BURST)
function emitBurst(x, y, z, material, o){
  if (!material || !bursts.length) return;
  let n = 0;
  for (const b of bursts) {
    if (b.life > 0) continue;
    _bd.set(Math.random() - 0.5, Math.random() * 0.8 + 0.25, Math.random() - 0.5).normalize();
    b.vel.copy(_bd).multiplyScalar(o.speedMin + Math.random() * o.speedRng);
    b.spin.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    b.max = o.lifeMin + Math.random() * o.lifeRng; b.life = b.max;
    b.base = o.scaleMin + Math.random() * o.scaleRng;
    b.mesh.material = material;
    b.mesh.position.set(x + (Math.random() - 0.5) * o.spread, y, z + (Math.random() - 0.5) * o.spread);
    b.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    b.mesh.scale.setScalar(b.base);
    b.mesh.visible = true;
    if (++n >= o.count) break;
  }
}
// ISO loppupurske mineraalin murtuessa
function spawnBurst(x, y, z, type){ emitBurst(x, y, z, oreMats[type], FINAL_BURST); }
// hakun iskuraycast: mitä on edessä kantaman sisällä (kivi/mineraali/objekti)
function raycastHit(){
  if (!scene) return null;
  camera.getWorldDirection(_fwd);
  _ray.set(camera.position, _fwd);
  _ray.near = 0.2; _ray.far = REACH;
  _ray.camera = camera;
  // EI kameran lapsia (hakku, ohjaamo, ulkomallit) eikä maastoa → vain kiinteät
  // maailman kohteet. Muuten ilmaan/maahan lyönti tai katselumallin osuma sinkoaisi siruja.
  const objs = scene.children.filter(o => o !== camera);
  const hits = _ray.intersectObjects(objs, true);
  for (const h of hits) {
    const o = h.object;
    if (!o.visible || !o.material) continue;
    if (o.userData && (o.userData.debris || o.userData.terrain)) continue;   // omat sirut / maasto
    if (o.material.isMeshBasicMaterial) continue;          // mustat ääriviivat / HUD-tasot
    return h;   // vain kiinteä kohde (kivi/mineraali/objekti) → muuten null = ei siruja (ilma/maa)
  }
  return null;
}
// pienet sirut joka hakuniskulla: mineraalia louhittaessa malmin värissä,
// muuten edessä olevan kiven/objektin pinnan materiaalilla (osuman kohdalta)
function emitStrikeDebris(){
  if (mineTarget) {
    emitBurst(mineTarget.x, mineTarget.y + 0.45, mineTarget.z, oreMats[mineTarget.type], STRIKE_BURST);
    return;
  }
  const h = raycastHit();
  if (!h) return;
  // vihollinen (esim. Regolith-mato): hoidetaan rekisteröidyssä käsittelijässä
  let o = h.object; while (o && !(o.userData && o.userData.enemy)) o = o.parent;
  if (o && _pickHitHandler) { _pickHitHandler(h); return; }
  emitBurst(h.point.x, h.point.y, h.point.z, h.object.material, STRIKE_BURST);
}
function updateBursts(dt){
  for (const b of bursts) {
    if (b.life <= 0) continue;
    b.life -= dt;
    if (b.life <= 0) { b.mesh.visible = false; continue; }
    b.vel.y -= BURST_G * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    b.mesh.rotation.x += b.spin.x * dt; b.mesh.rotation.y += b.spin.y * dt; b.mesh.rotation.z += b.spin.z * dt;
    b.mesh.scale.setScalar(b.base * (b.life / b.max));   // kutistuu loppua kohti = häipyy
  }
}
export function clearMining(){
  deposits = []; scene = null; heightFn = null; active = false; oreGeo = null; oreMats = null;
  bursts = []; burstGeo = null;
  _lmb = false; _triggerPressed = false; _triggerReleased = false; _prevSpace = false; mineTarget = null; mineProg = 0;
  swingAmt = 0; if (tool) { tool.visible = false; tool.position.copy(TOOL_POS); tool.rotation.set(TOOL_ROT.x, TOOL_ROT.y, TOOL_ROT.z); }
  // ase: nollaa tila ja palaa hakkuun seuraavalle pintakäynnille
  toolMode = TOOL_PICK; weaponMode = false; sniperMode = false; sniperAmt = 0; plasmaCharge = 0; plasmaCharging = false; recoil = 0; _prevLaserFire = false; _fireCd = 0;
  sparks = null; sparkGeo = null; sparkMat = null; _spkHead = 0;
  plasmaShots = [];
  plasmaPuffs = [];
  plasmaGroundMarks = []; plasmaGroundMarkHead = 0;
  plasmaTargets = []; plasmaTargetRefresh = 0;
  flashLight = null; _flLife = 0;
  if (scopeEl) scopeEl.style.display = 'none';
  if (gun) { gun.visible = false; gun.position.copy(GUN_POS); gun.rotation.set(GUN_ROT.x, GUN_ROT.y, GUN_ROT.z); }
  if (plasmaGun) { plasmaGun.visible = false; plasmaGun.position.copy(PLASMA_POS); plasmaGun.rotation.set(PLASMA_ROT.x, PLASMA_ROT.y, PLASMA_ROT.z); }
  renderMineBar();
  renderHud();
}
function renderMineBar(){
  const el = document.getElementById('mineBar');
  if (!el) return;
  if (active && mineTarget) {
    el.style.display = 'block';
    el.firstElementChild.style.width = Math.min(100, mineProg / mineTime(mineTarget.type) * 100) + '%';
  } else el.style.display = 'none';
}
/* louhinta = pidä hiiren vasen (tai Space) pohjassa ja TÄHTÄÄ esiintymään;
   edistymä kasvaa MINE_TIME-ajan, kappale tärisee ja kutistuu, lopulta murtuu
   ja saalis siirtyy varastoon. Pelkkä päälle käveleminen ei riitä. */
export function setMining(on){
  const next = !!on;
  if (next !== _lmb) {
    if (next) _triggerPressed = true;
    else _triggerReleased = true;
  }
  _lmb = next;
}
// törmäys: työnnä pelaaja ulos esiintymästä (ei voi kävellä mineraalin läpi)
export function resolveCollision(x, z){
  if (active) for (const d of deposits) {
    if (d.pop < 0.6) continue;
    const dx = x - d.x, dz = z - d.z, dist = Math.hypot(dx, dz);
    if (dist < COLLIDE_R) {
      if (dist > 1e-4) { x = d.x + dx / dist * COLLIDE_R; z = d.z + dz / dist * COLLIDE_R; }
      else x = d.x + COLLIDE_R;
    }
  }
  _col[0] = x; _col[1] = z; return _col;
}
// kantaman sisällä olevat esiintymät (kypäränäytön tutkalle)
export function depositsNear(x, z, r){
  if (!active) return [];
  const out = [];
  for (const d of deposits) { if (d.pop < 0.5) continue; const dd = Math.hypot(d.x - x, d.z - z); if (dd <= r) out.push({ x: d.x, z: d.z, type: d.type, d: dd }); }
  return out;
}
/* tummat halkeamat louhittaessa: kohteen kivitekstuurin päälle piirretään
   pieniä mustia halkeamia, joita tulee LISÄÄ edistymän myötä (kappale ei kutistu) */
const CRACK_MAX = 30;        // halkeamien enimmäismäärä täydellä edistymällä (enemmän)
const CRACK_SZ = 256;
function drawCrack(ctx){
  let x = Math.round(Math.random() * CRACK_SZ), y = Math.round(Math.random() * CRACK_SZ);
  let ang = Math.random() * 6.28;
  const segs = 7 + (Math.random() * 6 | 0);    // 7–12 segmenttiä (pidemmät juovat)
  const pts = [[x, y]];
  for (let s = 0; s < segs; s++) {
    ang += (Math.random() - 0.5) * 1.15;       // kulmikkaampi mutkittelu
    const len = 16 + Math.random() * 16;       // 16–32 px segmentit
    x = Math.round(x + Math.cos(ang) * len);
    y = Math.round(y + Math.sin(ang) * len);
    pts.push([x, y]);
  }

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = 'rgba(0,0,0,0.62)';
  ctx.lineWidth = 3.0 + Math.random() * 1.2;   // leveä varjo railon ympärillä
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(4,3,2,0.98)';
  ctx.lineWidth = 1.15 + Math.random() * 0.65; // terävä tumma ydin
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();

  // Pienet kovat haarat lisäävät "murtunutta" ilmettä ilman pehmeää antialias-sumua.
  ctx.lineWidth = 1;
  for (let i = 1; i < pts.length - 1; i += 2) {
    if (Math.random() > 0.65) continue;
    const bx = pts[i][0], by = pts[i][1];
    const ba = ang + (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 0.7);
    const bl = 6 + Math.random() * 12;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(Math.round(bx + Math.cos(ba) * bl), Math.round(by + Math.sin(ba) * bl));
    ctx.stroke();
  }
  ctx.restore();
}
function applyCracks(d){
  if (d._crackMats) return;
  const cv = document.createElement('canvas'); cv.width = cv.height = CRACK_SZ;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (rockMap && rockMap.image) ctx.drawImage(rockMap.image, 0, 0, CRACK_SZ, CRACK_SZ);
  else { ctx.fillStyle = '#8a8a8a'; ctx.fillRect(0, 0, CRACK_SZ, CRACK_SZ); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  if (rockMap) { tex.wrapS = rockMap.wrapS; tex.wrapT = rockMap.wrapT; tex.repeat.copy(rockMap.repeat); }
  d._crackCtx = ctx; d._crackTex = tex; d._crackN = 0;
  d._origMats = []; d._crackMats = [];
  for (const m of d.mesh.children) {
    if (!m.material.isMeshToonMaterial) continue;   // ohita mustat ääriviivat
    d._origMats.push({ m, mat: m.material });
    const cm = m.material.clone();
    cm.map = tex;                  // sama UV kuin kivitekstuurissa → halkeamat pintaan
    m.material = cm; d._crackMats.push(cm);
  }
}
function setCrackLevel(d, f){
  if (!d._crackCtx) return;
  const target = Math.floor(f * CRACK_MAX);    // halkeamia lisää edistymän myötä
  if (target <= d._crackN) return;
  while (d._crackN < target) { drawCrack(d._crackCtx); d._crackN++; }
  d._crackTex.needsUpdate = true;
}
function removeCracks(d){
  if (!d._origMats) return;
  for (const o of d._origMats) o.m.material = o.mat;
  for (const cm of d._crackMats) cm.dispose();
  if (d._crackTex) d._crackTex.dispose();
  d._origMats = d._crackMats = d._crackCtx = d._crackTex = null;
}
function restoreMesh(d){ removeCracks(d); d.mesh.position.set(d.x, d.y, d.z); d.mesh.scale.setScalar(d.pop); }
function aimedDeposit(){
  camera.getWorldDirection(_fwd);
  let best = null, bestDot = AIM_COS;
  for (const d of deposits) {
    _to.set(d.x - camera.position.x, (d.y + 0.6) - camera.position.y, d.z - camera.position.z);
    const dist = _to.length();
    if (dist > REACH || dist < 0.001) continue;
    const dot = _to.dot(_fwd) / dist;          // kuinka keskitetysti katse osuu
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}
export function updateMining(dt, px, pz){
  // työkalu/ase näkyy louhittavalla pinnalla (Mars/Kuu); X vaihtaa niiden välillä
  tool.visible = active && toolMode === TOOL_PICK;
  if (gun) gun.visible = active && toolMode === TOOL_LASER;
  if (plasmaGun) plasmaGun.visible = active && toolMode === TOOL_PLASMA;
  updateSniper(dt);
  updateFlash(dt);
  updateSparks(dt);
  updatePlasmaPuffs(dt);
  updatePlasmaShots(dt);
  const spaceDown = !!S.keys.Space;
  const triggerPressed = active && (_triggerPressed || (spaceDown && !_prevSpace));
  const triggerReleased = active && (_triggerReleased || (!spaceDown && _prevSpace));
  const fireInput = active && (_lmb || spaceDown);
  _triggerPressed = false;
  _triggerReleased = false;
  _prevSpace = spaceDown;

  if (toolMode === TOOL_LASER) {
    // ---- LASER ----
    updateGun(dt);
    _fireCd -= dt;
    if ((triggerPressed || (fireInput && !_prevLaserFire)) && _fireCd <= 0) { fireGun(); _fireCd = 0.16; }   // semi-auto: laukaus per painallus
    _prevLaserFire = fireInput;
    if (!active) return;
    updateBursts(dt);
    if (mineTarget) { restoreMesh(mineTarget); mineTarget = null; mineProg = 0; }
    for (const d of deposits) {   // esiintymien kierrätys + kasvuanimaatio jatkuu
      if (Math.hypot(d.x - px, d.z - pz) > FAR + 40) relocate(d, px, pz);
      if (d.pop < 1) { d.pop = Math.min(1, d.pop + dt * 3.5); d.mesh.scale.setScalar(d.pop); }
    }
    renderMineBar();
    return;
  }

  if (toolMode === TOOL_PLASMA) {
    // ---- PLASMA-TYKKI: pidä pohjassa ladataksesi, vapauta ampuaksesi ----
    refreshPlasmaTargets(dt);
    updatePlasmaGun(dt, fireInput || triggerPressed);
    if (triggerReleased && plasmaCharging) updatePlasmaGun(0, false);
    if (!active) return;
    updateBursts(dt);
    if (mineTarget) { restoreMesh(mineTarget); mineTarget = null; mineProg = 0; }
    for (const d of deposits) {
      if (Math.hypot(d.x - px, d.z - pz) > FAR + 40) relocate(d, px, pz);
      if (d.pop < 1) { d.pop = Math.min(1, d.pop + dt * 3.5); d.mesh.scale.setScalar(d.pop); }
    }
    renderMineBar();
    return;
  }

  // ---- HAKKU ----
  const swinging = fireInput;
  updateTool(dt, swinging);
  _prevLaserFire = false;
  if (!active) return;
  updateBursts(dt);
  // ISKUSIRUT: joka hakuniskun impaktilla (iskuvaihe ylittää 0,5) sinkoa pieniä
  // siruja edessä olevasta kivestä/mineraalista/objektista (osuman pinnan värissä)
  const ph = (swingT * STRIKE_RATE) % 1;
  if (swinging && swingAmt > 0.6 && _prevPh < 0.5 && ph >= 0.5) emitStrikeDebris();
  _prevPh = ph;
  // kierrätä kauas jääneet eteen (ei aktiivista louhintakohdetta) + kasvuanimaatio
  for (const d of deposits) {
    if (d !== mineTarget && Math.hypot(d.x - px, d.z - pz) > FAR + 40) relocate(d, px, pz);
    if (d.pop < 1) { d.pop = Math.min(1, d.pop + dt * 3.5); if (d !== mineTarget) d.mesh.scale.setScalar(d.pop); }
  }
  // louhinta
  if (_lmb || S.keys.Space) {
    const t = aimedDeposit();
    if (t !== mineTarget) { if (mineTarget) restoreMesh(mineTarget); mineTarget = t; mineProg = 0; if (mineTarget) applyCracks(mineTarget); }
    if (mineTarget) {
      mineProg += dt;
      const mt = mineTime(mineTarget.type);
      const f = Math.min(1, mineProg / mt);
      const j = 0.07 * f;                        // tärinä kasvaa edistymän mukaan
      mineTarget.mesh.position.set(
        mineTarget.x + (Math.random() - 0.5) * j,
        mineTarget.y + (Math.random() - 0.5) * j,
        mineTarget.z + (Math.random() - 0.5) * j);
      setCrackLevel(mineTarget, f);             // koko säilyy; halkeamat syvenevät edistymän mukaan
      if (mineProg >= mt) {                      // murtuu → purske + saalis + ilmestyy muualle
        S.inv[mineTarget.type] = (S.inv[mineTarget.type] || 0) + 1;
        spawnBurst(mineTarget.x, mineTarget.y + 0.5, mineTarget.z, mineTarget.type);
        removeCracks(mineTarget);
        relocate(mineTarget, px, pz);
        mineTarget = null; mineProg = 0;
        renderHud(); pulse();
      }
    }
  } else if (mineTarget) {
    restoreMesh(mineTarget); mineTarget = null; mineProg = 0;
  }
  renderMineBar();
}

/* ---- jalostus ---- */
export function canCraft(r){ for (const k in r.in) if ((S.inv[k] || 0) < r.in[k]) return false; return true; }
export function craftRecipe(i){
  const r = RECIPES[i];
  if (!r || !canCraft(r)) { pulseCraft(i, false); return false; }
  for (const k in r.in) S.inv[k] -= r.in[k];
  S.inv[r.out] = (S.inv[r.out] || 0) + 1;
  renderHud(); renderCraft();
  return true;
}
let craftOpen = false;
export function isCraftOpen(){ return craftOpen; }
export function toggleCraft(){
  craftOpen = !craftOpen;
  const el = document.getElementById('craftPanel');
  if (el) el.style.display = craftOpen ? 'block' : 'none';
  if (craftOpen) renderCraft();
}

/* ---- HUD ---- */
// kerätyt mineraalit visiirin vasemmalle näytölle (surface.js piirtää):
// raaka-aineet ensin, jalosteet perään; vain ne joita on varastossa
export function inventory(){
  const out = [];
  for (const k of RAW)  if ((S.inv[k] || 0) > 0) out.push({ name: ITEM_NAMES[k], count: S.inv[k], made: false });
  for (const k of MADE) if ((S.inv[k] || 0) > 0) out.push({ name: ITEM_NAMES[k], count: S.inv[k], made: true });
  return out;
}
function line(ids){ return ids.filter(k => (S.inv[k] || 0) > 0).map(k => `${ITEM_NAMES[k]} <b>${S.inv[k]}</b>`).join('  ·  '); }
export function renderHud(){
  const el = document.getElementById('miningHud');
  if (!el) return;
  const raw = line(RAW), made = line(MADE);
  el.innerHTML =
    (raw ? `<div class="mhRow">${raw}</div>` : (planetName === 'Kuu' ? '' : '<div class="mhRow mhDim">ei raaka-aineita</div>')) +
    (made ? `<div class="mhRow mhMade">${made}</div>` : '') +
    // Kuun pinnalla ei selitetekstejä (kypäränäyttö hoitaa opastuksen)
    (planetName === 'Kuu' ? '' : `<div class="mhHint">tähtää esiintymään + pidä hiiren vasen = louhi · C = jalostus</div>`);
}
export function renderCraft(){
  const el = document.getElementById('craftPanel');
  if (!el) return;
  let html = '<div class="crHead">JALOSTUS</div>';
  RECIPES.forEach((r, i) => {
    const ok = canCraft(r);
    const ins = Object.entries(r.in).map(([k, n]) => `${ITEM_NAMES[k]}×${n}`).join(' + ');
    html += `<div class="crRow ${ok ? 'crOk' : 'crNo'}"><span class="crNum">${i + 1}</span>${ins} → <b>${ITEM_NAMES[r.out]}</b><span class="crHave">${S.inv[r.out] || 0}</span></div>`;
  });
  html += '<div class="crHint">numero = jalosta · C = sulje</div>';
  el.innerHTML = html;
}
function pulse(){ const el = document.getElementById('miningHud'); if (!el) return; el.classList.remove('mhPulse'); void el.offsetWidth; el.classList.add('mhPulse'); }
function pulseCraft(){ const el = document.getElementById('craftPanel'); if (!el) return; el.classList.remove('crShake'); void el.offsetWidth; el.classList.add('crShake'); }
