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
let mineTarget = null, mineProg = 0; // nykyinen louhintakohde ja edistymä
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();
const _ray = new THREE.Raycaster();  // hakun isku → mitä edessä (kivi/mineraali/objekti)
const STRIKE_RATE = 2.6;             // iskuja/s (sama kuin updateToolin animaatio)
let _prevPh = 0;                     // edellinen iskuvaihe (impaktin tunnistus)
// ISO loppupurske kun mineraali murtuu (enemmän + isompia + nopeampia siruja)
const FINAL_BURST  = { count: 24, scaleMin: 0.9, scaleRng: 1.6, speedMin: 2.4, speedRng: 4.2, lifeMin: 0.6, lifeRng: 0.5, spread: 0.35 };
// pienet sirut joka hakuniskulla (kivi/mineraali/objekti) — PIENET sirpaleet
const STRIKE_BURST = { count: 5,  scaleMin: 0.12, scaleRng: 0.22, speedMin: 1.1, speedRng: 1.9, lifeMin: 0.3, lifeRng: 0.3, spread: 0.16 };

// ---- ase (semiautomaattinen laser) ----
let weaponMode = false;             // false = hakku, true = ase (X vaihtaa pinnalla)
let recoil = 0, _gunT = 0;          // rekyyli (vaikuttaa VAIN aseeseen) + huojunta-aika
let _fireCd = 0, _prevFire = false; // laukauksen jäähtymisaika + edellinen liipaisin (semi-auto = nouseva reuna)
const BEAM_POOL = 12, BEAM_W = 0.16, BEAM_LIFE = 0.16;
const GUN_DMG = 1, DEP_HP = 3;     // laserin vahinko per laukaus + mineraalin piilo-osumapisteet
let beams = [], beamGeo = null, _beamTex = null;
let _gunHitHandler = null;          // surface.js rekisteröi kivien/sukkulan osumakäsittelyn
export function setGunHitHandler(fn){ _gunHitHandler = fn; }
const GUN_POS = new THREE.Vector3(0.34, -0.40, -0.55);
const GUN_ROT = new THREE.Vector3(0.03, -0.12, 0.0);
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4(), _muz = new THREE.Vector3();

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
function beamDashTex(){
  if (_beamTex) return _beamTex;
  const w = 16, h = 64, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    const ph = (y / h * 3) % 1;            // ~3 katkoa per tekstuuri
    if (ph >= 0.6) continue;               // tauko (katkonainen)
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - (w - 1) / 2) / ((w - 1) / 2);   // 0 keskellä, 1 reunoilla
      const v = Math.round(255 * Math.pow(1 - dx, 2));        // kirkas keskisäie
      c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(x, y, 1, 1);
    }
  }
  _beamTex = new THREE.CanvasTexture(cv);
  return _beamTex;
}
// pehmeä pyöreä hehku (suuliekki) — ilman tätä litteä quad näkyy valkoisena suorakaiteena
let _flashTex = null;
function flashTex(){
  if (_flashTex) return _flashTex;
  const s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,225,180,0.65)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, s, s);
  _flashTex = new THREE.CanvasTexture(cv);
  return _flashTex;
}
function makeBeamMat(){
  const t = beamDashTex().clone(); t.needsUpdate = true;
  t.wrapT = THREE.RepeatWrapping; t.wrapS = THREE.ClampToEdgeWrapping;
  const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, side: THREE.DoubleSide });
  m.color.setRGB(2.8, 0.65, 0.4);   // kuuma oranssipunainen → hehkuu bloomissa
  return m;
}
// KAKSI ristikkäistä lattaa (Y = pituus, X/Z = leveys) → litteä mutta näkyy joka
// suunnasta (yksi latta katoaisi reunastaan kun ammutaan suoraan katseen suuntaan)
function makeBeamGeo(){
  const g = new THREE.BufferGeometry();
  const pos = [
    -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, 0.5, 0,   // latta XY
    0, -0.5, -0.5,  0, -0.5, 0.5,  0, 0.5, 0.5,  0, 0.5, -0.5,   // latta ZY
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1,  0, 0, 1, 0, 1, 1, 0, 1];   // V pituuden suuntaan (dashit)
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}
let gun = null, _muzzleFlash = null;
function buildGun(){
  const g = new THREE.Group();
  // CELL SHADING + bittikarttatekstuuri (kuten hakku); otsalamppu → näkyy kaikissa valoissa
  const bodyMat = toonMat({ color: 0x6f7681 }); loadToolTex(bodyMat, 'metal_plate_02', 2, 1);
  const darkMat = toonMat({ color: 0x33373d }); loadToolTex(darkMat, 'metal_plate', 1, 1);
  addToolHeadlamp(bodyMat); addToolHeadlamp(darkMat);
  const box = (mat, w, h, d, x, y, z, rx, ry, rz) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0); g.add(m); return m; };
  box(bodyMat, 0.15, 0.17, 0.5, 0, 0, 0);                       // runko/lukko
  box(bodyMat, 0.10, 0.10, 0.32, 0, 0.02, -0.34);              // piippusuojus
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.04, 0.5, 10), darkMat);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, -0.5); g.add(barrel);   // piippu
  box(darkMat, 0.07, 0.21, 0.1, 0, -0.17, 0.08, -0.26);        // kahva
  box(bodyMat, 0.09, 0.13, 0.22, 0, -0.02, 0.33);             // perä
  box(darkMat, 0.03, 0.055, 0.2, 0, 0.13, -0.04);            // tähtäin/kisko
  addOutlines(g, 0.01);   // cell shading: musta ääriviiva
  // hehkuvat osat (MeshBasic, kirkkaat → bloom): suuliekkirengas + energiakenno
  const emit = new THREE.MeshBasicMaterial(); emit.color.setRGB(2.6, 0.7, 0.4);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.013, 8, 18), emit); ring.position.set(0, 0.02, -0.77); g.add(ring);
  const cell = new THREE.MeshBasicMaterial(); cell.color.setRGB(0.4, 1.6, 2.3);
  box(cell, 0.02, 0.06, 0.26, 0.082, 0.0, 0.02);             // sininen energiakenno kyljessä
  g.traverse(o => { if (o.isMesh) o.userData.viewmodel = true; });   // raycastit ohittavat aseen
  // suuliekki: kirkas kiekko piipun kärjessä, kääntyy katselijaa kohti, syttyy laukauksessa
  const fm = new THREE.MeshBasicMaterial({ map: flashTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0 });
  fm.color.setRGB(3.2, 1.3, 0.7);
  _muzzleFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), fm);
  _muzzleFlash.position.set(0, 0.02, -0.82); g.add(_muzzleFlash);
  g.position.copy(GUN_POS); g.rotation.set(GUN_ROT.x, GUN_ROT.y, GUN_ROT.z);
  g.visible = false; camera.add(g);
  return g;
}
gun = buildGun();
function updateGun(dt){
  _gunT += dt;
  recoil += (0 - recoil) * Math.min(1, dt * 14);   // rekyyli laantuu nopeasti
  gun.position.set(GUN_POS.x, GUN_POS.y + Math.sin(_gunT * 1.6) * 0.004, GUN_POS.z + recoil * 0.14);
  gun.rotation.set(GUN_ROT.x - recoil * 0.22, GUN_ROT.y + Math.sin(_gunT * 1.3) * 0.006, GUN_ROT.z);
  if (_muzzleFlash) _muzzleFlash.material.opacity = Math.max(0, recoil * 1.3 - 0.25);
}
// ensimmäinen kiinteä osuma edessä (maasto/kivi/mineraali/objekti); palauttaa intersectionin
function gunRaycast(){
  _ray.set(camera.position, _fwd); _ray.near = 0.3; _ray.far = 140;
  const objs = scene.children.filter(o => o !== camera);
  const hits = _ray.intersectObjects(objs, true);
  for (const h of hits) {
    const o = h.object;
    if (!o.visible || !o.material) continue;
    if (o.userData && (o.userData.debris || o.userData.beam)) continue;
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
  const o = h.object;
  const dep = deposits.find(d => o.parent === d.mesh);
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
  if (!scene || !beams.length) return;
  camera.getWorldDirection(_fwd); camera.updateMatrixWorld();
  _muz.set(0.22, -0.14, -1.4).applyMatrix4(camera.matrixWorld);   // suupiipun pää maailmassa
  const hit = gunRaycast();
  const len = Math.max(2, (hit ? hit.distance : 140) - 0.3);
  const b = beams.find(x => x.life <= 0) || beams[0];
  _by.copy(_muz).addScaledVector(_fwd, len * 0.5);                // keskipiste
  _bz.copy(camera.position).sub(_by); _bz.addScaledVector(_fwd, -_bz.dot(_fwd));   // leveä sivu kohti kameraa (kohtisuoraan säteeseen)
  if (_bz.lengthSq() < 1e-6) _bz.set(0, 1, 0);
  _bz.normalize(); _bx.crossVectors(_fwd, _bz).normalize();
  _bm.makeBasis(_bx, _fwd, _bz);                                  // X=leveys, Y=pituus(säde), Z=normaali
  b.mesh.position.copy(_by);
  b.mesh.quaternion.setFromRotationMatrix(_bm);
  b.mesh.scale.set(BEAM_W, len, BEAM_W);   // X/Z = leveys (ristikkäiset latat), Y = pituus
  b.mesh.material.map.repeat.set(1, Math.max(2, len * 0.4));      // lisää katkoja pidempään säteeseen
  b.mesh.material.opacity = 1; b.mesh.visible = true;
  b.life = b.max = BEAM_LIFE;
  recoil = 1;   // rekyyli vain aseeseen
  if (hit) applyGunDamage(hit);   // vahinko osumakohteeseen
}
function updateBeams(dt){
  for (const b of beams) {
    if (b.life <= 0) continue;
    b.life -= dt;
    if (b.life <= 0) { b.mesh.visible = false; continue; }
    b.mesh.material.opacity = b.life / b.max;
  }
}
// X (pinnalla) vaihtaa aseen ja hakun välillä
export function toggleWeapon(){
  if (!active) return;
  weaponMode = !weaponMode;
  recoil = 0;
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
  // laserin säde-pooli (lattamaiset, katkonaiset säteet)
  beamGeo = beamGeo || makeBeamGeo();
  beams = [];
  for (let i = 0; i < BEAM_POOL; i++) {
    const m = new THREE.Mesh(beamGeo, makeBeamMat());
    m.visible = false; m.frustumCulled = false; m.renderOrder = 5;
    m.userData.beam = true;
    sc.add(m);
    beams.push({ mesh: m, life: 0, max: 0 });
  }
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
  if (h) emitBurst(h.point.x, h.point.y, h.point.z, h.object.material, STRIKE_BURST);
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
  _lmb = false; mineTarget = null; mineProg = 0;
  swingAmt = 0; if (tool) { tool.visible = false; tool.position.copy(TOOL_POS); tool.rotation.set(TOOL_ROT.x, TOOL_ROT.y, TOOL_ROT.z); }
  // ase: nollaa tila ja palaa hakkuun seuraavalle pintakäynnille
  beams = []; weaponMode = false; recoil = 0; _prevFire = false; _fireCd = 0;
  if (gun) { gun.visible = false; gun.position.copy(GUN_POS); gun.rotation.set(GUN_ROT.x, GUN_ROT.y, GUN_ROT.z); }
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
export function setMining(on){ _lmb = on; }
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
  let x = Math.random() * CRACK_SZ, y = Math.random() * CRACK_SZ;
  let ang = Math.random() * 6.28;
  const segs = 7 + (Math.random() * 6 | 0);    // 7–12 segmenttiä (pidemmät juovat)
  ctx.strokeStyle = 'rgba(8,6,5,0.85)'; ctx.lineCap = 'round';
  ctx.lineWidth = 0.3 + Math.random() * 0.4;   // 0,3–0,7 (ohuet)
  ctx.beginPath(); ctx.moveTo(x, y);
  for (let s = 0; s < segs; s++) {
    ang += (Math.random() - 0.5) * 0.9;        // loiva mutkittelu
    const len = 18 + Math.random() * 12;       // 18–30 px segmentit
    x += Math.cos(ang) * len; y += Math.sin(ang) * len;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}
function applyCracks(d){
  if (d._crackMats) return;
  const cv = document.createElement('canvas'); cv.width = cv.height = CRACK_SZ;
  const ctx = cv.getContext('2d');
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
  tool.visible = active && !weaponMode;
  if (gun) gun.visible = active && weaponMode;
  updateBeams(dt);
  const fireInput = active && (_lmb || S.keys.Space);

  if (weaponMode) {
    // ---- ASE ----
    updateGun(dt);
    _fireCd -= dt;
    if (fireInput && !_prevFire && _fireCd <= 0) { fireGun(); _fireCd = 0.16; }   // semi-auto: laukaus per painallus
    _prevFire = fireInput;
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

  // ---- HAKKU ----
  const swinging = fireInput;
  updateTool(dt, swinging);
  _prevFire = fireInput;
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
