/* ---------------- Pintamoodi: teleporttaus planeetoille ---------------- */
import * as THREE from 'three';
import { renderer, scene, camera, renderPass } from './core.js';
import { bodies, placeNearBody } from './bodies.js';
import { resetWarp } from './warp.js';
import { LANDING_MAX_EFF, IMPACT_MAX, destroyShip, hideReentryFx } from './reentry.js';
import { makeSky } from './sky.js';
import { S } from './state.js';

/* IBL: taivaasta generoitu ympäristökartta (päivitetään auringon liikkuessa) */
let pmrem = null;

export const ROCKY = new Set(['Merkurius', 'Venus', 'Maa', 'Mars']);
let surfaceBody = null;
let bridgeWasOn = true;
let surfX = 0, surfZ = 0;
let surfaceScene = null;
let surfHeightFn = null;
let bobPhase = 0, bobAmp = 0;

/* ---- vuorokaudenkierto ----
   Aurinko kulkee kaarirataa, jonka jakso on planeetan todellinen
   aurinkovuorokausi skaalattuna: 1 h = 10 s eli Maan vuorokausi 240 s.
   Valaistus, taivaan/sumun väri, rusko, aurinkokiekko ja yötähdet
   ajetaan auringon korkeuden mukaan joka ruutu (updateDaylight). */
let daylight = null;             // renderöitävän pintascenen valaistusviitteet
let dayPhase0 = 0, dayT0 = 0;    // vaihe ja simTime laskeutumishetkellä
const _sunDir = new THREE.Vector3();
const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();

function sunPhase(){
  return dayPhase0 + ((S.simTime - dayT0) / daylight.cfg.dayLength) * Math.PI * 2;
}
// kaarirata: nousu idästä (+x), lasku länteen, lakikorkeus ~66°
function sunDirAt(p, out){ return out.set(Math.cos(p), Math.sin(p), -0.45).normalize(); }

function updateDaylight(){
  const d = daylight;
  if (!d) return;
  sunDirAt(sunPhase(), _sunDir);
  const elev = _sunDir.y;
  const dayF = sstep(-0.12, 0.15, elev);
  // rusko vain ilmakehällisillä, auringon ollessa horisontin tuntumassa
  const tw = d.twilight ? Math.max(0, 1 - Math.abs(elev) / 0.35) * sstep(-0.22, -0.04, elev) : 0;

  if (d.cfg.sun) {
    // valo ja varjokamera seuraavat pelaajaa
    d.dl.position.copy(camera.position).addScaledVector(_sunDir, 800);
    d.dl.target.position.copy(camera.position);
    d.dl.target.updateMatrixWorld();
  }
  d.dl.intensity = d.baseInt * (d.cfg.sun ? dayF : 0.2 + 0.8 * dayF);
  if (d.twilight) d.dl.color.copy(_c1.set(0xffffff).lerp(d.twilight, tw * 0.85));
  if (d.hemi) d.hemi.intensity = d.baseHemi * (0.22 + 0.78 * dayF);
  if (d.bldgMat) d.bldgMat.emissiveIntensity = (1 - dayF) * 1.2;   // ikkunat syttyvät yöksi
  if (d.cloudMat) {
    // pilvet tummuvat yöksi ja värjäytyvät ruskossa
    _c2.setScalar(0.18 + 0.82 * dayF);
    if (d.twilight) _c2.lerp(d.twilight, tw * 0.6);
    d.cloudMat.color.copy(_c2);
  }

  // fysikaalinen taivas: aurinko shaderille + IBL-kartta auringon liikkuessa
  if (d.skyMat) {
    d.skyMat.uniforms.sunPosition.value.copy(_sunDir);
    d.skyEnvScene.userData.envMat.uniforms.sunPosition.value.copy(_sunDir);
    if (Math.abs(_sunDir.y - d.lastEnvElev) > 0.02 && S.simTime - d.lastEnvT > 1.2) {
      d.lastEnvElev = _sunDir.y;
      d.lastEnvT = S.simTime;
      const rt = pmrem.fromScene(d.skyEnvScene, 0, 100, 250000);
      if (d.envRT) d.envRT.dispose();
      d.envRT = rt;
      for (const m of d.envMats) m.envMap = rt.texture;
    }
  }

  // taivas ja sumu tummuvat yöksi, rusko värjää horisontin tuntumassa
  _c1.copy(d.skyNight).lerp(d.skyDay, dayF);
  if (d.twilight) _c1.lerp(d.twilight, tw * 0.55);
  d.sc.background.copy(_c1);
  if (d.sc.fog) {
    _c2.copy(d.fogNight).lerp(d.fogDay, dayF);
    if (d.twilight) _c2.lerp(d.twilight, tw * 0.45);
    d.sc.fog.color.copy(_c2);
  }

  // aurinkokiekko seuraa rataa ja värjäytyy ruskossa
  if (d.disc) {
    d.disc.visible = elev > -0.06;
    if (d.disc.visible) {
      d.disc.position.copy(_sunDir).multiplyScalar(7000);
      d.disc.lookAt(0, 0, 0);
      if (d.twilight) {
        const peak = Math.max(d.discDay.r, d.discDay.g, d.discDay.b);
        _c3.copy(d.twilight).multiplyScalar(peak * 0.85);
        d.disc.material.color.copy(_c2.copy(d.discDay).lerp(_c3, tw));
      }
    }
  }

  // ilmakehällisten yötähdet häivytetään sisään pimeällä (neliöllisesti —
  // muuten tähdet erottuvat jo iltapäivän kirkkaalla taivaalla)
  if (d.starsMat && d.cfg.nightStars) d.starsMat.opacity = 0.7 * (1 - dayF) * (1 - dayF);
}

// 2D-kohina maastoa varten
function hash2(x, y){ const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise2(x, y){
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x, y, oct){
  let val = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { val += amp * vnoise2(x * f, y * f); f *= 2.07; amp *= 0.5; }
  return val;
}
function ridged2(x, y, oct){
  let val = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { val += amp * (1 - Math.abs(vnoise2(x * f, y * f) * 2 - 1)); f *= 2.13; amp *= 0.5; }
  return val;
}
function sstep(a, b, x){
  x = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
}
// jaksollinen arvokohina saumatonta tekstuuria varten
function vnoiseP(x, y, P){
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (a) => ((a % P) + P) % P;
  const a = hash2(w(xi), w(yi)), b = hash2(w(xi + 1), w(yi)),
        c = hash2(w(xi), w(yi + 1)), d = hash2(w(xi + 1), w(yi + 1));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// planeettakohtainen värillinen pintadetaljitekstuuri (toistuu saumattomasti).
// Keskikirkkaus ~1.0, jotta se moduloi vertex-värejä tummentamatta kokonaisuutta;
// sävyläiskät, rakeisuus ja kivispekkelit tuovat lähietäisyyden yksityiskohdat.
// Sama tekstuuri toimii bump-karttana (punakanava).
const _texCache = {};
function getDetailTexture(name, cfg){
  if (_texCache[name]) return _texCache[name];
  const S2 = 512;
  const seed = name.length * 7.13;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S2;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S2, S2);
  // sävysuunta: ground→ground2-suhde kertoo planeetan luontevan värivaihtelun
  const cA = new THREE.Color(cfg.ground), cB = new THREE.Color(cfg.ground2);
  const tr = cB.r / Math.max(0.04, cA.r), tg = cB.g / Math.max(0.04, cA.g), tb = cB.b / Math.max(0.04, cA.b);
  for (let y = 0; y < S2; y++) {
    for (let x = 0; x < S2; x++) {
      // perusrakeisuus (4 oktaavia)
      let v = 0, amp = 0.5, per = 8;
      for (let o = 0; o < 4; o++) { v += amp * vnoiseP(x * per / S2 + seed, y * per / S2, per); per *= 2; amp *= 0.5; }
      let g = 0.66 + 0.42 * (v / 0.9375);
      // isommat sävyläiskät: taitetaan kohti ground2:n suhteellista sävyä
      const patch = vnoiseP(x * 5 / S2 + seed + 3, y * 5 / S2 + 9, 5) * 0.8
                  + vnoiseP(x * 13 / S2 + seed + 7, y * 13 / S2 + 2, 13) * 0.2;
      const pm = sstep(0.38, 0.72, patch) * 0.55;
      let r = g * (1 + (tr - 1) * pm), gr = g * (1 + (tg - 1) * pm), b = g * (1 + (tb - 1) * pm);
      // kivispekkelit
      const sp = hash2(x * 3 + 17, y * 3 + 29);
      if (sp > 0.986) { r *= 0.5; gr *= 0.5; b *= 0.5; }
      else if (sp < 0.012) { r *= 1.25; gr *= 1.25; b *= 1.25; }
      const i = (y * S2 + x) * 4;
      // lineaariavaruudessa (ei SRGB-dekoodausta): arvot toimivat suorina kertoimina
      img.data[i]     = Math.min(255, (r * 235) | 0);
      img.data[i + 1] = Math.min(255, (gr * 235) | 0);
      img.data[i + 2] = Math.min(255, (b * 235) | 0);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  _texCache[name] = t;
  return t;
}

// olosuhteet nykytietämyksen mukaan
export const SURFACE_CONFIGS = {
  Merkurius: {
    title: 'MERKURIUS — PINTA',
    info: 'Ei kaasukehää: taivas on pikimusta keskellä päivääkin ja Aurinko näkyy ~2,5× suurempana kuin Maasta. Pinta +430 °C päivällä, −180 °C yöllä. Kuun pintaa muistuttavaa regoliittia ja kraattereita.',
    sky: 0x000000, fog: null,
    ground: 0x8a8178, ground2: 0x55504a, rock: 0x6e675f,
    hScale: 26, freq: 0.0045,
    dayLength: 42230,   // aurinkovuorokausi ~176 vrk → käytännössä paikallaan
    sun: { color: [4.0, 4.0, 3.9], size: 260, intensity: 2.4 },
    hemi: [0x101010, 0x201d16, 0.3], stars: true,
    // todistetusti: tiheä kraatteröinti ja Rupes-jyrkänteet
    features: { craters: 16, scarp: true },
  },
  Venus: {
    title: 'VENUS — PINTA',
    info: '92 baarin hiilidioksidikehä, +465 °C. Rikkihappopilvet 50 km ylempänä päästävät läpi vain himmeän oranssin hämärän, eikä Aurinkoa erota. Venera-luotainten kuvissa basalttilaattoja — ainoat kuvat Venuksen pinnalta.',
    sky: 0xc08038, fog: { color: 0xb5762f, near: 8, far: 230 },
    ground: 0x8a6038, ground2: 0x5e3f22, rock: 0x75522e,
    hScale: 10, freq: 0.006, rockFlat: 0.35,
    dayLength: 28020,   // aurinkovuorokausi ~117 vrk; vain usvan kirkkaus elää
    skyNight: 0x140a02,
    sun: null,
    dirLight: { color: 0xffb060, intensity: 0.8, dir: [0.3, 0.8, -0.4] },
    hemi: [0xd08a40, 0x4a3014, 0.9],
    // todistetusti: kilpitulivuoria ja repeämälaaksoja, vain vähän kraattereita
    features: {
      craters: 3,
      volcanoes: [{ x: 520, z: -680, R: 480, H: 75 }, { x: -700, z: 300, R: 380, H: 55 }],
      canyon: { width: 0.035, depth: 20 },
    },
  },
  Maa: {
    title: 'MAA — PINTA',
    info: 'Typpi-happikehä, 1 bar, keskilämpötila +15 °C. Ainoa tunnettu planeetta, jonka pinnalla on nestemäistä vettä ja elämää.',
    sky: 0x7fb8e8, fog: { color: 0xcfe2f5, near: 60, far: 1500 },
    ground: 0x4a7a30, ground2: 0x6a6648, rock: 0x8a8578,
    hScale: 18, freq: 0.004,
    dayLength: 240,     // 24 h → 4 min
    skyNight: 0x060a13, twilight: 0xff8a50, nightStars: true,
    // fysikaalinen taivas: Maan Rayleigh-oletukset (sininen taivas, punainen rusko)
    scatter: { turbidity: 2.5, rayleigh: 2.0, mie: 0.006, mieG: 0.8, gain: 0.28 },
    sun: { color: [3.4, 3.3, 3.0], size: 100, intensity: 1.9 },
    hemi: [0x9ec8ee, 0x4a5a35, 0.6],
    features: { mountains: { amp: 60, maskF: 0.0007 }, trees: true, roads: true, towns: true,
                rocks: false, clouds: true },
  },
  Mars: {
    title: 'MARS — PINTA',
    info: 'Ohut 0,006 baarin CO₂-kehä, keskilämpötila −60 °C. Pöly värjää taivaan voinkeltaiseksi ja Aurinko näkyy ⅔-kokoisena, kalpeana kiekkona. Ruosteenpunaista kivikkoa kuten Curiosity-mönkijän kuvissa.',
    sky: 0xc89a6e, fog: { color: 0xc28d5e, near: 40, far: 900 },
    ground: 0xb56f3e, ground2: 0x8a4f28, rock: 0x96603a,
    hScale: 24, freq: 0.005,
    dayLength: 246.6,   // sol 24,66 h → ~4,1 min
    skyNight: 0x080605, twilight: 0x8898c8, nightStars: true,   // Marsin rusko on sinertävä
    // pölysironta: punainen siroaa sinistä enemmän → voinkeltainen taivas, sininen rusko
    scatter: { betaR: [2.6e-5, 1.2e-5, 0.45e-5], turbidity: 5, rayleigh: 1.4,
               mie: 0.012, mieG: 0.76, mieTint: [1.0, 0.8, 0.62], gain: 0.3 },
    sun: { color: [2.6, 2.5, 2.3], size: 65, intensity: 1.9 },
    hemi: [0xc89a6e, 0x5a3520, 0.62],
    // todistetusti: Valles Marineris -kanjonit, Olympus Mons, kraatterit ja dyynit
    features: {
      craters: 7,
      canyon: { width: 0.05, depth: 45 },
      mountains: { amp: 40, maskF: 0.0006 },
      volcanoes: [{ x: -820, z: -720, R: 540, H: 130 }],
      dunes: true,
    },
  },
};

// rakennusten julkisivu (betoni + ikkunaruudukko) ja yöikkunoiden emissiokartta
let _bldgTex = null;
function getBuildingTextures(){
  if (_bldgTex) return _bldgTex;
  const W2 = 128, H2 = 256;
  const fc = document.createElement('canvas'); fc.width = W2; fc.height = H2;
  const ec = document.createElement('canvas'); ec.width = W2; ec.height = H2;
  const f = fc.getContext('2d'), e = ec.getContext('2d');
  f.fillStyle = '#918e87';
  f.fillRect(0, 0, W2, H2);
  for (let i = 0; i < 260; i++) {   // betonin sävyvaihtelu
    const g = 110 + hash2(i, 1) * 60 | 0;
    f.fillStyle = `rgba(${g},${g},${g},0.14)`;
    f.fillRect(hash2(i, 2) * W2 | 0, hash2(i, 3) * H2 | 0, 6 + hash2(i, 4) * 28, 5 + hash2(i, 5) * 18);
  }
  e.fillStyle = '#000';
  e.fillRect(0, 0, W2, H2);
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 4; c++) {
      const wx = 8 + c * 30, wy = 10 + r * 24;
      f.fillStyle = '#1b2530';
      f.fillRect(wx, wy, 18, 14);
      if (hash2(c * 7 + 1, r * 13 + 2) < 0.55) {   // osa ikkunoista palaa öisin
        e.fillStyle = '#ffd9a0';
        e.fillRect(wx, wy, 18, 14);
      }
    }
  }
  const facade = new THREE.CanvasTexture(fc);
  facade.colorSpace = THREE.SRGBColorSpace;
  const windows = new THREE.CanvasTexture(ec);
  windows.colorSpace = THREE.SRGBColorSpace;
  _bldgTex = { facade, windows };
  return _bldgTex;
}

// pehmeä kumpupilvitekstuuri (läpinäkyvä reunoilta)
let _cloudTex = null;
function getCloudTexture(){
  if (_cloudTex) return _cloudTex;
  const S2 = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S2;
  const c = cv.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const px = S2 / 2 + (hash2(i, 61) - 0.5) * 150;
    const py = S2 / 2 + (hash2(i, 62) - 0.5) * 130;
    const r = 26 + hash2(i, 63) * 60;
    const g = c.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S2, S2);
  }
  const t = new THREE.CanvasTexture(cv);
  _cloudTex = t;
  return t;
}

// asfalttitekstuuri: keskikatkoviiva ja reunaviivat; v toistuu 15 m välein
let _roadTex = null;
function getRoadTexture(){
  if (_roadTex) return _roadTex;
  const W2 = 128, H2 = 128;
  const cv = document.createElement('canvas');
  cv.width = W2; cv.height = H2;
  const c = cv.getContext('2d');
  c.fillStyle = '#2a2a2d';
  c.fillRect(0, 0, W2, H2);
  for (let i = 0; i < 500; i++) {   // asfaltin rakeisuus
    const g = 28 + hash2(i, 51) * 36 | 0;
    c.fillStyle = `rgba(${g},${g},${g + 2},0.5)`;
    c.fillRect(hash2(i, 52) * W2 | 0, hash2(i, 53) * H2 | 0, 2, 2);
  }
  c.fillStyle = '#8e8e8a';            // reunaviivat
  c.fillRect(6, 0, 4, H2);
  c.fillRect(W2 - 10, 0, 4, H2);
  c.fillStyle = '#cdcdc6';            // keskikatkoviiva
  c.fillRect(W2 / 2 - 3, 10, 6, 46);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  _roadTex = t;
  return t;
}

/* ---- tieverkko ja kaupungit (Maa) ----
   Tiet kulkevat ROAD_SP-välisessä ruudukossa; osa risteyksistä on kaupunkeja.
   Maasto tasoittuu teiden ja kaupunkien kohdalla, laatat värjäävät tiet
   asfaltiksi ja rakennukset sijoittuvat kortteleihin risteyksen ympärille. */
const ROAD_SP = 900;
function townAt(ix, iz){ return hash2(ix * 3.7 + 11.3, iz * 5.1 + 7.7) < 0.4; }
function roadDist(x, z){
  const mx = ((x % ROAD_SP) + ROAD_SP) % ROAD_SP;
  const mz = ((z % ROAD_SP) + ROAD_SP) % ROAD_SP;
  return Math.min(Math.min(mx, ROAD_SP - mx), Math.min(mz, ROAD_SP - mz));
}

function makeCraters(n, seed){
  const list = [];
  for (let i = 0; i < n; i++) {
    let x = (hash2(i + seed, 5) - 0.5) * 2100;
    let z = (hash2(i + seed, 6) - 0.5) * 2100;
    if (Math.hypot(x, z) < 220) { x += 350; z -= 300; }   // ei laskeutumispisteeseen
    list.push({ x, z, r: 30 + hash2(i + seed, 7) * 95, depth: 4 + hash2(i + seed, 8) * 9 });
  }
  return list;
}

/* ---- ääretön maasto: laattagridi kameran ympärillä ----
   Korkeusfunktio on globaali ja proseduraalinen — vain mesh on rajallinen.
   Maasto generoidaan TILE-kokoisina laattoina TILE_GRID×TILE_GRID-ruudukkoon
   kameran ympärille; liikuttaessa vapautuneet laatat kierrätetään uusiin
   kohtiin (enintään yksi laatanrakennus per ruutu — ei nykäyksiä).
   Normaalit lasketaan korkeusnäytteistä naapureineen, joten laattasaumat
   eivät erotu valaistuksessa. */
const TILE = 600, TILE_SEGS = 48, TILE_GRID = 5;   // kate 3000×3000, ~115k kolmiota
let terrain = null;
const _vn = new THREE.Vector3();
const _cc = new THREE.Color();
const _vp = new THREE.Vector3();
const _m4s = new THREE.Matrix4(), _rqs = new THREE.Quaternion(),
      _res = new THREE.Euler(), _rss = new THREE.Vector3();

function initTerrain(sc, cfg, name){
  const detail = getDetailTexture(name, cfg);
  terrain = {
    sc, cfg,
    mat: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0,
      map: detail, bumpMap: detail, bumpScale: 0.85,
    }),
    cA: new THREE.Color(cfg.ground),
    cB: new THREE.Color(cfg.ground2),
    tiles: new Map(),
    pool: [],
    queue: [],
    ctx: null, ctz: null,
    roads: !!(cfg.features && cfg.features.roads),
    roadMat: null,
    roadPool: { x: [], z: [] },
    H: new Float32Array((TILE_SEGS + 3) * (TILE_SEGS + 3)),   // korkeusnäytteet +1 reunamarginaalilla
  };
  if (terrain.roads) {
    terrain.roadMat = new THREE.MeshStandardMaterial({
      map: getRoadTexture(), roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
  }
}
const _cAsphalt = new THREE.Color(0x232326);
const ROAD_W = 11;   // tiekaistan leveys

/* tiekaistat: laattaan kuuluvat ohuet meshit, jotka myötäilevät maastoa
   keskilinjan korkeudella (maasto on tasoitettu tien kohdalla) */
function getRoadStrip(dir){
  const t = terrain;
  let m = t.roadPool[dir].pop();
  if (!m) {
    const g = dir === 'z'
      ? new THREE.PlaneGeometry(ROAD_W, TILE, 1, TILE_SEGS)
      : new THREE.PlaneGeometry(TILE, ROAD_W, TILE_SEGS, 1);
    g.rotateX(-Math.PI / 2);
    m = new THREE.Mesh(g, t.roadMat);
    m.userData.dir = dir;
    m.receiveShadow = true;
    t.sc.add(m);
  }
  m.visible = true;
  return m;
}

function fillRoadStrip(mesh, dir, line, center){
  const g = mesh.geometry;
  const pos = g.attributes.position, uv = g.attributes.uv;
  // x-suuntainen tie kelluu hieman z-suuntaisen yläpuolella risteyksissä
  const lift = dir === 'z' ? 0.26 : 0.4;
  for (let v = 0; v < pos.count; v++) {
    const lx = pos.getX(v), lz = pos.getZ(v);
    const along = dir === 'z' ? center + lz : center + lx;
    const across = dir === 'z' ? lx : lz;
    pos.setY(v, surfHeightFn(dir === 'z' ? line : along, dir === 'z' ? along : line) + lift);
    uv.setXY(v, across / ROAD_W + 0.5, along / 15);
  }
  pos.needsUpdate = uv.needsUpdate = true;
  g.computeBoundingSphere();
  mesh.position.set(dir === 'z' ? line : center, 0, dir === 'z' ? center : line);
}

function fillTile(mesh, tx, tz){
  const t = terrain;
  const g = mesh.geometry;
  const pos = g.attributes.position, col = g.attributes.color,
        uv = g.attributes.uv, nor = g.attributes.normal;
  const n = TILE_SEGS + 1, step = TILE / TILE_SEGS, W = n + 2;
  const ox = tx * TILE, oz = tz * TILE;
  const x0 = ox - TILE / 2, z0 = oz - TILE / 2;
  const H = t.H;
  for (let j = -1; j <= n; j++)
    for (let i = -1; i <= n; i++)
      H[(j + 1) * W + (i + 1)] = surfHeightFn(x0 + i * step, z0 + j * step);
  const hs = t.cfg.hScale;
  for (let v = 0; v < pos.count; v++) {
    const i = Math.round((pos.getX(v) + TILE / 2) / step);
    const j = Math.round((pos.getZ(v) + TILE / 2) / step);
    const h = H[(j + 1) * W + (i + 1)];
    pos.setY(v, h);
    // normaali naapurikorkeuksista — yhtenevä laattasaumojen yli
    _vn.set(H[(j + 1) * W + i] - H[(j + 1) * W + (i + 2)], 2 * step,
            H[j * W + (i + 1)] - H[(j + 2) * W + (i + 1)]).normalize();
    nor.setXYZ(v, _vn.x, _vn.y, _vn.z);
    const wx = x0 + i * step, wz = z0 + j * step;
    const tt = Math.min(1, Math.max(0, fbm2(wx * 0.011 + 7, wz * 0.011 + 7, 3)));
    // korkeammat kohdat vaaleampia, painanteet tummempia
    const shade = (0.72 + 0.55 * ((h / hs) * 0.5 + 0.5)) * 1.16;
    _cc.copy(t.cA).lerp(t.cB, tt).multiplyScalar(shade);
    if (t.roads) {
      const a = 1 - sstep(6.5, 11, roadDist(wx, wz));
      if (a > 0) _cc.lerp(_cAsphalt, a * 0.88);
    }
    col.setXYZ(v, _cc.r, _cc.g, _cc.b);
    uv.setXY(v, wx / 2600, wz / 2600);   // detaljitekstuuri maailmakoordinaateissa — jatkuva laattojen yli
  }
  pos.needsUpdate = col.needsUpdate = uv.needsUpdate = nor.needsUpdate = true;
  g.computeBoundingSphere();
  mesh.position.set(ox, 0, oz);
}

function buildQueuedTile(){
  const t = terrain;
  const key = t.queue.shift();
  if (!key || t.tiles.has(key)) return;
  let mesh = t.pool.pop();
  if (!mesh) {
    const g = new THREE.PlaneGeometry(TILE, TILE, TILE_SEGS, TILE_SEGS);
    g.rotateX(-Math.PI / 2);
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    mesh = new THREE.Mesh(g, t.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  if (!mesh.parent) t.sc.add(mesh);
  mesh.visible = true;
  const [tx, tz] = key.split(',').map(Number);
  fillTile(mesh, tx, tz);
  const entry = { mesh, roads: [] };
  if (t.roadMat) {
    // laatan läpi kulkevat tielinjat saavat omat kaistameshinsä
    const ox = tx * TILE, oz = tz * TILE;
    for (let k = Math.ceil((ox - TILE / 2) / ROAD_SP); k * ROAD_SP <= ox + TILE / 2; k++) {
      const m = getRoadStrip('z');
      fillRoadStrip(m, 'z', k * ROAD_SP, oz);
      entry.roads.push(m);
    }
    for (let k = Math.ceil((oz - TILE / 2) / ROAD_SP); k * ROAD_SP <= oz + TILE / 2; k++) {
      const m = getRoadStrip('x');
      fillRoadStrip(m, 'x', k * ROAD_SP, ox);
      entry.roads.push(m);
    }
  }
  t.tiles.set(key, entry);
}

function updateTerrain(ax, az, buildAll = false){
  const t = terrain;
  const ctx = Math.round(ax / TILE), ctz = Math.round(az / TILE);
  if (ctx !== t.ctx || ctz !== t.ctz) {
    t.ctx = ctx; t.ctz = ctz;
    const R = (TILE_GRID - 1) / 2;
    const want = new Set();
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) want.add((ctx + dx) + ',' + (ctz + dz));
    for (const [k, e] of t.tiles) {
      if (!want.has(k)) {
        t.tiles.delete(k);
        e.mesh.visible = false;
        t.pool.push(e.mesh);
        for (const r of e.roads) { r.visible = false; t.roadPool[r.userData.dir].push(r); }
      }
    }
    t.queue = [...want].filter(k => !t.tiles.has(k));
  }
  if (buildAll) { while (t.queue.length) buildQueuedTile(); }
  else if (t.queue.length) buildQueuedTile();
}

/* ---- kameraa seuraava sirote (kivet, pikkukivet, puut) ----
   Kukin instanssi sijaitsee jaksollisen W×W-solun kopioista siinä, joka on
   lähinnä kameraa; solun vaihtuessa paikka ja korkeus lasketaan uudelleen. */
let scatters = [];

function addScatter(sc, geo, mat, count, W, place){
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;   // instanssit hajallaan — perusgeometrian mukainen kullaus veisi ne piiloon
  const sct = {
    mesh, count, W, place,
    bx: new Float32Array(count), bz: new Float32Array(count),
    kx: new Float64Array(count).fill(NaN), kz: new Float64Array(count).fill(NaN),
  };
  for (let i = 0; i < count; i++) {
    sct.bx[i] = (hash2(i, 91) - 0.5) * W;
    sct.bz[i] = (hash2(i, 92) - 0.5) * W;
  }
  scatters.push(sct);
  sc.add(mesh);
  return mesh;
}

function updateScatter(ax, az){
  for (const s of scatters) {
    let dirty = false;
    for (let i = 0; i < s.count; i++) {
      const kx = Math.round((ax - s.bx[i]) / s.W);
      const kz = Math.round((az - s.bz[i]) / s.W);
      if (kx === s.kx[i] && kz === s.kz[i]) continue;
      s.kx[i] = kx; s.kz[i] = kz;
      s.place(i, s.bx[i] + kx * s.W, s.bz[i] + kz * s.W, _m4s, _rqs, _res, _rss);
      s.mesh.setMatrixAt(i, _m4s);
      dirty = true;
    }
    if (dirty) s.mesh.instanceMatrix.needsUpdate = true;
  }
}

function buildSurfaceScene(name){
  const cfg = SURFACE_CONFIGS[name];
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(cfg.sky);
  if (cfg.fog) sc.fog = new THREE.Fog(cfg.fog.color, cfg.fog.near, cfg.fog.far);

  const freq = cfg.freq, hs = cfg.hScale;
  const F = cfg.features || {};
  const craters = F.craters ? makeCraters(F.craters, name.length * 13) : null;
  // paikkasidonnaiset piirteet (kraatterit, tulivuoret) toistuvat tällä jaksolla —
  // kohina on luonnostaan ääretöntä; piirteet mahtuvat jakson sisään ilman saumaa
  const FEAT_P = 4200;
  const wrapF = (v) => (((v + FEAT_P / 2) % FEAT_P + FEAT_P) % FEAT_P) - FEAT_P / 2;
  surfHeightFn = (x, z) => {
    let h = (fbm2(x * freq, z * freq, 5) - 0.5) * 2 * hs
          + (fbm2(x * freq * 6 + 9, z * freq * 6 + 9, 3) - 0.5) * hs * 0.22;
    if (F.mountains) {
      const m = F.mountains;
      const mask = Math.pow(Math.max(0, (fbm2(x * m.maskF + 11, z * m.maskF + 4, 2) - 0.5) / 0.5), 2);
      if (mask > 0.001) h += mask * ridged2(x * 0.0035, z * 0.0035, 4) * m.amp;
    }
    if (F.canyon) {
      const d = Math.abs(vnoise2(x * 0.0006 + 3.7, z * 0.0006 + 9.1) - 0.5);
      const msk = 1 - sstep(0, F.canyon.width, d);
      if (msk > 0) h -= msk * msk * F.canyon.depth;
    }
    const xf = wrapF(x), zf = wrapF(z);
    if (F.volcanoes) for (const v of F.volcanoes) {
      const d = Math.hypot(xf - v.x, zf - v.z) / v.R;
      if (d < 1) {
        let vh = Math.pow(1 - d, 1.6) * v.H;
        if (d < 0.14) vh -= (1 - d / 0.14) * v.H * 0.25;   // kaldera
        h += vh;
      }
    }
    if (craters) for (const c of craters) {
      const d = Math.hypot(xf - c.x, zf - c.z) / c.r;
      if (d < 1.7) {
        h += -Math.max(0, 1 - d * d) * c.depth
           + Math.exp(-((d - 1.05) * (d - 1.05)) / 0.02) * c.depth * 0.4;
      }
    }
    if (F.scarp) h += sstep(0.50, 0.53, vnoise2(x * 0.00045 + 7.3, z * 0.00045 + 2.2)) * 9;
    if (F.dunes) h += 0.45 * Math.sin(x * 0.055 + fbm2(x * 0.0025 + 1, z * 0.0025 + 1, 2) * 7);
    if (F.roads) {
      // maasto tasoittuu teiden ja kaupunkien kohdalla suuriin muotoihin
      const mR = 1 - sstep(9, 19, roadDist(x, z));
      const ix = Math.round(x / ROAD_SP), iz = Math.round(z / ROAD_SP);
      const dTown = townAt(ix, iz) ? Math.hypot(x - ix * ROAD_SP, z - iz * ROAD_SP) : 1e9;
      const mT = 1 - sstep(140, 210, dTown);
      const m = Math.max(mR, mT);
      if (m > 0) {
        const hL = (fbm2(x * freq, z * freq, 2) - 0.5) * 2 * hs;
        h = h * (1 - 0.9 * m) + hL * 0.9 * m;
      }
    }
    return h;
  };

  // ääretön maasto: laattagridi kameran ympärillä
  initTerrain(sc, cfg, name);

  // materiaalit, jotka saavat taivaasta lasketun ympäristökartan (IBL).
  // HUOM: ei koko ruudun täyttävään maastoon — env-näytteistys maksaa siinä ~20 fps
  const envMats = [];

  // piilota sirote-instanssi (tien/kaupungin alle jäävät)
  const hideInstance = (m4, rq, rs) => {
    rq.identity(); rs.set(0, 0, 0);
    m4.compose(_vp.set(0, -2000, 0), rq, rs);
  };
  const inTownArea = (x, z) => {
    if (!F.roads) return false;
    if (roadDist(x, z) < 14) return true;
    const ix = Math.round(x / ROAD_SP), iz = Math.round(z / ROAD_SP);
    return townAt(ix, iz) && Math.hypot(x - ix * ROAD_SP, z - iz * ROAD_SP) < 220;
  };

  // kivet: tasainen jakauma toistuvassa solussa (ei Maassa — nurmella murikat näyttävät vierailta)
  if (F.rocks !== false) {
    const rocksMat = new THREE.MeshStandardMaterial({ color: cfg.rock, roughness: 1, envMapIntensity: 0.25 });
    envMats.push(rocksMat);
    const rocks = addScatter(sc, new THREE.DodecahedronGeometry(1, 0), rocksMat,
      600, 2200, (i, x, z, m4, rq, re, rs) => {
        if (inTownArea(x, z)) { hideInstance(m4, rq, rs); return; }
        const s = 0.25 + Math.pow(hash2(i, 3), 2) * 3.4;
        re.set(hash2(i, 4) * 3.14, hash2(i, 5) * 6.28, hash2(i, 6) * 3.14);
        rq.setFromEuler(re);
        rs.set(s, s * (cfg.rockFlat ?? 0.8), s);
        m4.compose(_vp.set(x, surfHeightFn(x, z) + s * 0.25, z), rq, rs);
      });
    rocks.castShadow = true;
    rocks.receiveShadow = true;
  }

  // pikkukivet lähimaisemaan: pieni solu pitää ne aina kameran lähellä
  if (F.rocks !== false) {
    addScatter(sc, new THREE.IcosahedronGeometry(0.22, 0),
      new THREE.MeshStandardMaterial({ color: cfg.rock, roughness: 1 }),
      1300, 480, (i, x, z, m4, rq, re, rs) => {
        const s = 0.4 + hash2(i, 13) * 1.5;
        re.set(hash2(i, 14) * 3.14, hash2(i, 15) * 6.28, 0);
        rq.setFromEuler(re);
        rs.set(s, s * 0.7, s);
        m4.compose(_vp.set(x, surfHeightFn(x, z) + 0.05, z), rq, rs);
      });
  }

  // puut (Maa)
  if (F.trees) {
    const TREE_N = 420;
    const treesMat = new THREE.MeshStandardMaterial({ roughness: 1, envMapIntensity: 0.25 });
    envMats.push(treesMat);
    const trees = addScatter(sc, new THREE.ConeGeometry(1, 3.2, 7), treesMat,
      TREE_N, 2200, (i, x, z, m4, rq, re, rs) => {
        if (inTownArea(x, z)) { hideInstance(m4, rq, rs); return; }
        const s = 1.2 + Math.pow(hash2(i, 23), 2) * 2.8;
        rq.identity();
        rs.set(s, s, s);
        m4.compose(_vp.set(x, surfHeightFn(x, z) + s * 1.5, z), rq, rs);
      });
    trees.castShadow = true;
    trees.receiveShadow = true;
    const tc = new THREE.Color();
    for (let i = 0; i < TREE_N; i++) {
      tc.setHSL(0.30 + hash2(i, 24) * 0.06, 0.45, 0.16 + hash2(i, 25) * 0.10);
      trees.setColorAt(i, tc);
    }
  }

  // pilvet: litteät kumpupilvet 400–580 m korkeudessa, seuraavat kameraa sirotteena
  let cloudMat = null;
  if (F.clouds) {
    cloudMat = new THREE.MeshBasicMaterial({
      map: getCloudTexture(), transparent: true, depthWrite: false,
      side: THREE.DoubleSide, fog: true,
    });
    addScatter(sc, new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), cloudMat,
      34, 3200, (i, x, z, m4, rq, re, rs) => {
        const s = 150 + hash2(i, 41) * 230;
        re.set(0, hash2(i, 42) * 6.28, 0);
        rq.setFromEuler(re);
        rs.set(s, 1, s * (0.55 + hash2(i, 43) * 0.5));
        m4.compose(_vp.set(x, 400 + hash2(i, 44) * 180, z), rq, rs);
      });
  }

  // rakennukset: kaupungit teiden risteyksissä (Maa)
  let bldgMat = null;
  if (F.towns) {
    const { facade, windows } = getBuildingTextures();
    bldgMat = new THREE.MeshStandardMaterial({
      map: facade, roughness: 0.9, metalness: 0, envMapIntensity: 0.3,
      emissive: 0xffc488, emissiveMap: windows, emissiveIntensity: 0,
    });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3b3b3e, roughness: 1, envMapIntensity: 0.25 });
    envMats.push(bldgMat, roofMat);
    const buildings = addScatter(sc, new THREE.BoxGeometry(1, 1, 1),
      [bldgMat, bldgMat, roofMat, roofMat, bldgMat, bldgMat],
      500, 2400, (i, x, z, m4, rq, re, rs) => {
        const ix = Math.round(x / ROAD_SP), iz = Math.round(z / ROAD_SP);
        if (!townAt(ix, iz) || hash2(ix * 7.7 + i, iz * 3.3 + 1) > 0.8) {
          hideInstance(m4, rq, rs);
          return;
        }
        // korttelipaikka: 16–140 yks risteyksestä, ei tielinjojen päälle
        const h1 = hash2(ix * 31.7 + i * 1.3, iz * 17.9 + 5);
        const h2 = hash2(ix * 13.1 + i * 2.7, iz * 41.3 + 9);
        const wx = ix * ROAD_SP + (h1 < 0.5 ? -1 : 1) * (16 + ((h1 * 7.31) % 1) * 124);
        const wz = iz * ROAD_SP + (h2 < 0.5 ? -1 : 1) * (16 + ((h2 * 5.17) % 1) * 124);
        const bw = 7 + hash2(i * 3.1, ix + iz) * 12;
        const bd = 7 + hash2(i * 5.3, ix - iz + 99) * 12;
        const bh = 6 + Math.pow(hash2(i * 7.7, ix * 2 + iz), 2) * 42;
        rq.identity();
        rs.set(bw, bh, bd);
        m4.compose(_vp.set(wx, surfHeightFn(wx, wz) + bh / 2 - 0.6, wz), rq, rs);
      });
    buildings.castShadow = true;
    buildings.receiveShadow = true;
  }

  // rakenna aloitusalue valmiiksi (laatat + sirote origon ympärille)
  updateTerrain(0, 0, true);
  updateScatter(0, 0);

  // fysikaalinen taivas (Maa, Mars): sirontashader + IBL-ympäristökartta
  let skyMat = null, skyEnvScene = null;
  if (cfg.scatter) {
    const sky = makeSky(cfg.scatter);
    sc.add(sky);
    skyMat = sky.material;
    // erillinen minimaailma ympäristökartan renderöintiin: sama taivas
    // ILMAN auringon HDR-kiekkoa (muuten ambientti ylivalottuu)
    skyEnvScene = new THREE.Scene();
    const envMat = skyMat.clone();
    envMat.uniforms.uSunGlow.value = 0;
    const envSky = new THREE.Mesh(sky.geometry, envMat);
    envSky.scale.setScalar(120000);
    skyEnvScene.add(envSky);
    skyEnvScene.userData.envMat = envMat;
    pmrem = pmrem ?? new THREE.PMREMGenerator(renderer);
  }

  // valaistus — auringon suunta ja voimakkuus ajetaan updateDaylightissa.
  // IBL-planeetoilla hemisfäärivaloa lasketaan, ettei ambientti tuplaannu
  let hemi = null;
  if (cfg.hemi) {
    hemi = new THREE.HemisphereLight(cfg.hemi[0], cfg.hemi[1], cfg.hemi[2]);
    sc.add(hemi);
  }
  const lightDef = cfg.sun ?? cfg.dirLight;
  const dl = new THREE.DirectionalLight(cfg.sun ? 0xffffff : cfg.dirLight.color, lightDef.intensity);
  if (cfg.dirLight) dl.position.copy(new THREE.Vector3(...cfg.dirLight.dir).normalize());
  if (cfg.sun) {
    // varjot: kartta seuraa pelaajaa (paikat päivitetään updateDaylightissa)
    dl.castShadow = true;
    dl.shadow.mapSize.set(2048, 2048);
    dl.shadow.camera.left = -300; dl.shadow.camera.right = 300;
    dl.shadow.camera.top = 300; dl.shadow.camera.bottom = -300;
    dl.shadow.camera.near = 100; dl.shadow.camera.far = 1700;
    dl.shadow.bias = -0.0004;
    dl.shadow.normalBias = 0.8;
  }
  sc.add(dl);
  sc.add(dl.target);

  // aurinkokiekko (jos näkyvissä) — paikka päivittyy radan mukana.
  // Sirontataivaalla aurinko hehkuineen syntyy shaderissa, erillistä kiekkoa ei tarvita
  let disc = null;
  if (cfg.sun && !cfg.scatter) {
    disc = new THREE.Mesh(
      new THREE.CircleGeometry(cfg.sun.size, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(...cfg.sun.color), fog: false })
    );
    sc.add(disc);
  }

  // tähtitaivas: ilmakehättömillä aina, ilmakehällisillä öisin
  let starsMat = null;
  if (cfg.stars || cfg.nightStars) {
    const n = 1600, p = new Float32Array(n * 3);
    const sv = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      sv.set(hash2(i, 7) - 0.5, Math.abs(hash2(i, 8)) * 0.9 + 0.04, hash2(i, 9) - 0.5)
        .normalize().multiplyScalar(7500);
      p[i * 3] = sv.x; p[i * 3 + 1] = sv.y; p[i * 3 + 2] = sv.z;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    starsMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true,
      opacity: cfg.stars ? 0.7 : 0, fog: false });   // fog söisi tähdet ilmakehällisillä
    sc.add(new THREE.Points(sg, starsMat));
  }

  daylight = {
    sc, cfg, dl, hemi, disc, starsMat, bldgMat, cloudMat,
    skyMat, skyEnvScene, envMats, envRT: null, lastEnvElev: 99, lastEnvT: -99,
    baseInt: lightDef.intensity,
    baseHemi: cfg.hemi ? cfg.hemi[2] : 0,
    skyDay: new THREE.Color(cfg.sky),
    skyNight: new THREE.Color(cfg.skyNight ?? cfg.sky),
    fogDay: cfg.fog ? new THREE.Color(cfg.fog.color) : null,
    fogNight: cfg.fog ? new THREE.Color(cfg.skyNight ?? cfg.fog.color) : null,
    twilight: cfg.twilight ? new THREE.Color(cfg.twilight) : null,
    discDay: disc ? disc.material.color.clone() : null,
  };
  return sc;
}

// pikasiirtymä: hyppää valitun kohteen kiertoradalle mistä tahansa (testaukseen)
export function quickTravel(){
  if (S.mode !== 'space') return;
  S.targetFrac = 0; S.speedFrac = 0;
  placeNearBody(S.targetIdx, 6);
}

export function tryBeamDown(){
  if (S.mode !== 'space') return;
  if (S.effFrac > LANDING_MAX_EFF) return;   // laskeutuminen vain hitaassa vauhdissa
  const b = bodies[S.targetIdx];
  if (!ROCKY.has(b.def.name)) return;
  if (camera.position.distanceTo(b.group.position) > b.def.r * 15) return;
  enterSurface(b);
}

// yhteinen alustus pintamoodille ja matalalennolle
function enterSurfaceScene(b, mode){
  S.mode = mode;
  surfaceBody = b;
  surfaceScene = buildSurfaceScene(b.def.name);
  renderPass.scene = surfaceScene;
  surfaceScene.add(camera);   // kameran maailmamatriisi päivittyy vain renderöitävän scenen osana
  resetWarp();
  hideReentryFx();
  dayT0 = S.simTime;
  dayPhase0 = 0.55;
  S.targetFrac = 0; S.speedFrac = 0;
  bridgeWasOn = document.body.classList.contains('bridge');
  document.body.classList.remove('bridge');
  document.body.classList.add('surface');
}

// yhteinen purku: takaisin avaruusscenen renderöintiin ja resurssit vapaiksi
function leaveSurfaceScene(){
  S.mode = 'space';
  if (daylight && daylight.envRT) daylight.envRT.dispose();
  renderPass.scene = scene;
  scene.add(camera);          // kamera takaisin avaruusscenen jäseneksi
  document.body.classList.remove('surface');
  document.body.classList.remove('descent');
  if (bridgeWasOn) document.body.classList.add('bridge');
  camera.fov = 60; camera.updateProjectionMatrix();
  surfaceScene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) Array.isArray(o.material) ? o.material.forEach(m => m.dispose()) : o.material.dispose();
  });
  surfaceScene = null;
  daylight = null;
  surfaceBody = null;
  terrain = null;
  scatters = [];
}

function enterSurface(b){
  enterSurfaceScene(b, 'surface');
  surfX = 0; surfZ = 0;
  // vuorokausi alkaa aamupäivästä; aurinko selän taakse laskeutuessa,
  // jotta maisema näkyy valaistuna
  sunDirAt(dayPhase0, _sunDir);
  S.yaw = Math.atan2(_sunDir.x, _sunDir.z);
  S.pitch = 0; S.roll = 0;
  updateDaylight();
  camera.fov = 65; camera.updateProjectionMatrix();
  const cfg = SURFACE_CONFIGS[b.def.name];
  document.getElementById('surfTitle').textContent = cfg.title;
  document.getElementById('surfInfo').textContent = cfg.info;
}

export function exitSurface(){
  if (S.mode !== 'surface') return;
  const idx = bodies.indexOf(surfaceBody);
  leaveSurfaceScene();
  placeNearBody(idx, 6);
}

export function updateSurface(dt){
  updateDaylight();
  const running = S.keys.ShiftLeft || S.keys.ShiftRight;
  const sp = running ? 26 : 9;
  let mx = 0, mz = 0;
  if (S.keys.KeyW || S.keys.ArrowUp) mz -= 1;
  if (S.keys.KeyS || S.keys.ArrowDown) mz += 1;
  if (S.keys.KeyA || S.keys.ArrowLeft) mx -= 1;
  if (S.keys.KeyD || S.keys.ArrowRight) mx += 1;
  const moving = (mx || mz) ? 1 : 0;
  if (moving) {
    const inv = 1 / Math.hypot(mx, mz);
    surfX += (Math.cos(S.yaw) * mx + Math.sin(S.yaw) * mz) * inv * sp * dt;
    surfZ += (-Math.sin(S.yaw) * mx + Math.cos(S.yaw) * mz) * inv * sp * dt;
  }
  updateTerrain(surfX, surfZ);
  updateScatter(surfX, surfZ);

  // kävelyheilunta: askelpomppu, sivuttaishuojunta ja kevyt kallistus
  bobAmp += ((moving ? (running ? 1.4 : 1.0) : 0) - bobAmp) * (1 - Math.exp(-dt * 8));
  if (bobAmp > 0.03) bobPhase += dt * (running ? 11.5 : 8.0);
  const bobY  = Math.abs(Math.sin(bobPhase)) * 0.20 * bobAmp;   // askel joka puolijaksolla
  const sway  = Math.sin(bobPhase) * 0.09 * bobAmp;             // vasen-oikea joka toinen askel
  const tilt  = Math.sin(bobPhase) * 0.016 * bobAmp;
  const rX = Math.cos(S.yaw), rZ = -Math.sin(S.yaw);            // kameran oikea-suunta

  camera.rotation.set(S.pitch, S.yaw, tilt, 'YXZ');
  camera.position.set(
    surfX + rX * sway,
    surfHeightFn(surfX, surfZ) + 2.4 + bobY,
    surfZ + rZ * sway
  );
}

/* ---- matalalento: hidas lähestyminen vie pintalentoon ----
   Kun alus laskeutuu avaruudessa kiviplaneetan pintarajan (r×1,18) alle
   alle törmäysnopeuden (IMPACT_MAX — kovempaa tulevat tuhoutuvat reentryssä),
   näkymä vaihtuu planeetan proseduraaliseen pintamaailmaan ja lento jatkuu
   maaston yllä: hiiri ohjaa, W/S säätää vauhtia. Kosketus maastoon kovaa →
   tuho; alle SOFT_V → pehmeä lasku kävelymoodiin; ylös DESCENT_CEIL:n
   yläpuolelle (tai B) → takaisin avaruuteen. */
const DESCENT_TRIGGER = 1.18;   // × säde
const DESCENT_CEIL = 900;       // paluu avaruuteen tämän korkeuden yläpuolella
const SOFT_V = 55;              // pehmeän kosketuksen yläraja (m/s)
const MAX_ROLL_DEG = 2;         // suurin sallittu kallistus kosketuksessa
let descentV = 0;
let descRoll = 0;               // kallistus (rad) — tuuli pyörittää, A/D vastaohjaa
let windPhase = 0;
const descentPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

// fade to black -siirtymä: pimennys, vaihto, häivytys takaisin
const fadeEl = document.getElementById('fadeBlack');
let transitioning = false;
function fadeSwap(fn){
  if (transitioning) return;
  transitioning = true;
  fadeEl.style.transition = 'opacity 0.3s ease';
  fadeEl.style.opacity = '1';
  setTimeout(() => {
    fn();
    fadeEl.style.transition = 'opacity 0.9s ease';
    fadeEl.style.opacity = '0';
    transitioning = false;
  }, 330);
}

// ohjaamon mittarielementit
const ld = {
  title: document.getElementById('ldTitle'),
  alt: document.getElementById('ldAlt'),
  v: document.getElementById('ldV'),
  roll: document.getElementById('ldRoll'),
  horizon: document.getElementById('attHorizon'),
  pointer: document.getElementById('attPointer'),
};

export function checkDescentEntry(){
  if (transitioning || S.mode !== 'space' || S.effFrac > IMPACT_MAX) return;
  for (const b of bodies) {
    if (!ROCKY.has(b.def.name)) continue;
    if (camera.position.distanceTo(b.group.position) < b.def.r * DESCENT_TRIGGER) {
      fadeSwap(() => enterDescent(b));
      return;
    }
  }
}

function enterDescent(b){
  // sisääntulovauhti skaalataan lähestymisnopeudesta (60–300 m/s)
  const v = 60 + (S.effFrac / IMPACT_MAX) * 240;
  enterSurfaceScene(b, 'descent');
  document.body.classList.add('descent');
  descentV = v;
  descentPos.set(0, 650, 0);
  descRoll = (Math.random() - 0.5) * 0.12;   // pieni satunnainen alkukallistus (±3,4°)
  windPhase = Math.random() * 100;
  S.pitch = Math.min(S.pitch, -0.25);   // sisään aina laskevassa liu'ussa
  S.roll = 0;
  camera.fov = 65; camera.updateProjectionMatrix();
  updateDaylight();
  ld.title.textContent = `${b.def.name.toUpperCase()} — MATALALENTO`;
}

export function abortDescent(){
  if (S.mode !== 'descent') return;
  const idx = bodies.indexOf(surfaceBody);
  leaveSurfaceScene();
  placeNearBody(idx, 1.5);
}

export function updateDescent(dt){
  if (transitioning) return;   // jäädytä fade-siirtymän ajaksi
  updateDaylight();
  // W/S säätää vauhtia
  if (S.keys.KeyW || S.keys.ArrowUp)   descentV += 200 * dt;
  if (S.keys.KeyS || S.keys.ArrowDown) descentV -= 200 * dt;
  descentV = Math.max(35, Math.min(450, descentV));

  // turbulenssi ja tuuli pyörittävät alusta pituusakselin ympäri;
  // A/D (tai Q/E) vastaohjaa
  windPhase += dt;
  const turb = Math.sin(windPhase * 0.9 + 1.7) * 0.5
             + Math.sin(windPhase * 2.3) * 0.3
             + Math.sin(windPhase * 5.1 + 0.6) * 0.2;
  const gust = Math.sin(windPhase * 0.13) > 0.6 ? Math.sin(windPhase * 7.7) * 0.6 : 0;
  descRoll += (turb * 0.038 + gust * 0.03) * dt;
  if (S.keys.KeyA || S.keys.KeyQ || S.keys.ArrowLeft)  descRoll += 0.30 * dt;
  if (S.keys.KeyD || S.keys.KeyE || S.keys.ArrowRight) descRoll -= 0.30 * dt;
  descRoll -= descRoll * 0.05 * dt;   // kevyt aerodynaaminen vaimennus
  descRoll = Math.max(-0.45, Math.min(0.45, descRoll));

  // alus lentää katseen suuntaan; kallistus ja tuuli työntävät sivulle
  camera.rotation.set(S.pitch, S.yaw, descRoll, 'YXZ');
  camera.getWorldDirection(_fwd);
  descentPos.addScaledVector(_fwd, descentV * dt);
  _right.set(Math.cos(S.yaw), 0, -Math.sin(S.yaw));
  descentPos.addScaledVector(_right, (-Math.sin(descRoll) * descentV * 0.5 + turb * 4) * dt);
  // turbulenssin tärinä
  camera.rotation.x += (Math.random() - 0.5) * 0.0035 * Math.abs(turb + gust);
  camera.rotation.z += (Math.random() - 0.5) * 0.0025 * Math.abs(turb + gust);
  updateTerrain(descentPos.x, descentPos.z);
  updateScatter(descentPos.x, descentPos.z);

  const ground = surfHeightFn(descentPos.x, descentPos.z);
  const alt = descentPos.y - ground;
  const rollDeg = descRoll * 180 / Math.PI;

  // ylös avaruuteen
  if (descentPos.y > DESCENT_CEIL) { abortDescent(); return; }

  // kosketus maastoon: liian kovaa tai vinossa = tuho, muuten pehmeä lasku
  if (alt <= 2.6) {
    if (descentV > SOFT_V || Math.abs(rollDeg) > MAX_ROLL_DEG) {
      const name = surfaceBody.def.name;
      const reason = descentV > SOFT_V
        ? `Alus törmäsi pintaan ${Math.round(descentV)} m/s vauhdissa (${name}).`
        : `Laskuteline petti: kallistus kosketuksessa ${Math.abs(rollDeg).toFixed(1)}° — sallittu ±${MAX_ROLL_DEG}° (${name}).`;
      leaveSurfaceScene();
      destroyShip(reason);
      return;
    }
    fadeSwap(() => {
      S.mode = 'surface';
      document.body.classList.remove('descent');
      surfX = descentPos.x; surfZ = descentPos.z;
      bobPhase = 0; bobAmp = 0;
      const cfg = SURFACE_CONFIGS[surfaceBody.def.name];
      document.getElementById('surfTitle').textContent = cfg.title;
      document.getElementById('surfInfo').textContent = cfg.info;
    });
    return;
  }

  camera.position.copy(descentPos);

  // ohjaamon mittarit: keinohorisontti ja lukemat
  const pitchDeg = S.pitch * 180 / Math.PI;
  ld.horizon.setAttribute('transform',
    `rotate(${(-rollDeg).toFixed(2)}) translate(0 ${(pitchDeg * 1.6).toFixed(1)})`);
  ld.pointer.setAttribute('transform', `rotate(${rollDeg.toFixed(2)})`);
  ld.alt.textContent = Math.round(alt);
  ld.v.textContent = Math.round(descentV);
  ld.roll.textContent = rollDeg.toFixed(1);
  const rollOk = Math.abs(rollDeg) <= MAX_ROLL_DEG;
  ld.roll.style.color = rollOk ? '#4dff88' : '#ff7a5c';
  ld.v.style.color = descentV <= SOFT_V ? '#4dff88' : '#9fd8ff';
}

// debug-koukkua (__sim.surf) varten; setDayPhase: 0 = auringonnousu,
// π/2 = keskipäivä, π = auringonlasku, 3π/2 = keskiyö
export function surfDebug(){
  return {
    scene: surfaceScene, h: surfHeightFn, x: surfX, z: surfZ,
    dayPhase: daylight ? sunPhase() % (Math.PI * 2) : null,
    setDayPhase(p){ dayPhase0 = p; dayT0 = S.simTime; updateDaylight(); },
    descentPos, descentV: () => descentV,
    setDescentV(v){ descentV = v; },
    roll: () => descRoll,
    setRoll(r){ descRoll = r; },
  };
}
