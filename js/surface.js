/* ---------------- Pintamoodi: teleporttaus planeetoille ---------------- */
import * as THREE from 'three';
import { AU, renderer, scene, camera, renderPass } from './core.js';
import { bodies, placeNearBody } from './bodies.js';
import { resetWarp } from './warp.js';
import { LANDING_MAX_EFF, IMPACT_MAX, destroyShip, hideReentryFx } from './reentry.js';
import { S } from './state.js';

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

  if (d.cfg.sun) d.dl.position.copy(_sunDir);
  d.dl.intensity = d.baseInt * (d.cfg.sun ? dayF : 0.2 + 0.8 * dayF);
  if (d.twilight) d.dl.color.copy(_c1.set(0xffffff).lerp(d.twilight, tw * 0.85));
  if (d.hemi) d.hemi.intensity = d.baseHemi * (0.22 + 0.78 * dayF);

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

  // ilmakehällisten yötähdet häivytetään sisään pimeällä
  if (d.starsMat && d.cfg.nightStars) d.starsMat.opacity = 0.7 * (1 - dayF);
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

// harmaasävyinen pintadetaljitekstuuri (toistuu saumattomasti, jaetaan kaikille planeetoille)
let _detailTex = null;
function getDetailTexture(){
  if (_detailTex) return _detailTex;
  const S2 = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S2;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S2, S2);
  for (let y = 0; y < S2; y++) {
    for (let x = 0; x < S2; x++) {
      let v = 0, amp = 0.5, per = 8;
      for (let o = 0; o < 4; o++) { v += amp * vnoiseP(x * per / S2, y * per / S2, per); per *= 2; amp *= 0.5; }
      let g = 0.62 + 0.40 * (v / 0.9375);
      const sp = hash2(x * 3 + 17, y * 3 + 29);
      if (sp > 0.986) g *= 0.55;        // tummia pieniä kiviä
      else if (sp < 0.012) g *= 1.22;   // vaaleita jyviä
      const b = Math.min(255, (g * 255) | 0);
      const i = (y * S2 + x) * 4;
      img.data[i] = b; img.data[i + 1] = b; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(56, 56);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  _detailTex = t;
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
    sun: { color: [3.4, 3.3, 3.0], size: 100, intensity: 1.9 },
    hemi: [0x9ec8ee, 0x4a5a35, 0.6],
    features: { mountains: { amp: 60, maskF: 0.0007 }, trees: true },
  },
  Mars: {
    title: 'MARS — PINTA',
    info: 'Ohut 0,006 baarin CO₂-kehä, keskilämpötila −60 °C. Pöly värjää taivaan voinkeltaiseksi ja Aurinko näkyy ⅔-kokoisena, kalpeana kiekkona. Ruosteenpunaista kivikkoa kuten Curiosity-mönkijän kuvissa.',
    sky: 0xc89a6e, fog: { color: 0xc28d5e, near: 40, far: 900 },
    ground: 0xb56f3e, ground2: 0x8a4f28, rock: 0x96603a,
    hScale: 24, freq: 0.005,
    dayLength: 246.6,   // sol 24,66 h → ~4,1 min
    skyNight: 0x080605, twilight: 0x8898c8, nightStars: true,   // Marsin rusko on sinertävä
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

function initTerrain(sc, cfg){
  const detail = getDetailTexture();
  terrain = {
    sc, cfg,
    mat: new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0,
      map: detail, bumpMap: detail, bumpScale: 0.6,
    }),
    cA: new THREE.Color(cfg.ground),
    cB: new THREE.Color(cfg.ground2),
    tiles: new Map(),
    pool: [],
    queue: [],
    ctx: null, ctz: null,
    H: new Float32Array((TILE_SEGS + 3) * (TILE_SEGS + 3)),   // korkeusnäytteet +1 reunamarginaalilla
  };
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
  }
  if (!mesh.parent) t.sc.add(mesh);
  mesh.visible = true;
  const [tx, tz] = key.split(',').map(Number);
  fillTile(mesh, tx, tz);
  t.tiles.set(key, mesh);
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
    for (const [k, mesh] of t.tiles) {
      if (!want.has(k)) { t.tiles.delete(k); mesh.visible = false; t.pool.push(mesh); }
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
    return h;
  };

  // ääretön maasto: laattagridi kameran ympärillä
  initTerrain(sc, cfg);

  // kivet: tasainen jakauma toistuvassa solussa
  addScatter(sc, new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshStandardMaterial({ color: cfg.rock, roughness: 1 }),
    600, 2200, (i, x, z, m4, rq, re, rs) => {
      const s = 0.25 + Math.pow(hash2(i, 3), 2) * 3.4;
      re.set(hash2(i, 4) * 3.14, hash2(i, 5) * 6.28, hash2(i, 6) * 3.14);
      rq.setFromEuler(re);
      rs.set(s, s * (cfg.rockFlat ?? 0.8), s);
      m4.compose(_vp.set(x, surfHeightFn(x, z) + s * 0.25, z), rq, rs);
    });

  // pikkukivet lähimaisemaan: pieni solu pitää ne aina kameran lähellä
  addScatter(sc, new THREE.IcosahedronGeometry(0.22, 0),
    new THREE.MeshStandardMaterial({ color: cfg.rock, roughness: 1 }),
    1300, 480, (i, x, z, m4, rq, re, rs) => {
      const s = 0.4 + hash2(i, 13) * 1.5;
      re.set(hash2(i, 14) * 3.14, hash2(i, 15) * 6.28, 0);
      rq.setFromEuler(re);
      rs.set(s, s * 0.7, s);
      m4.compose(_vp.set(x, surfHeightFn(x, z) + 0.05, z), rq, rs);
    });

  // puut (Maa)
  if (F.trees) {
    const TREE_N = 420;
    const trees = addScatter(sc, new THREE.ConeGeometry(1, 3.2, 7),
      new THREE.MeshStandardMaterial({ roughness: 1 }),
      TREE_N, 2200, (i, x, z, m4, rq, re, rs) => {
        const s = 1.2 + Math.pow(hash2(i, 23), 2) * 2.8;
        rq.identity();
        rs.set(s, s, s);
        m4.compose(_vp.set(x, surfHeightFn(x, z) + s * 1.5, z), rq, rs);
      });
    const tc = new THREE.Color();
    for (let i = 0; i < TREE_N; i++) {
      tc.setHSL(0.30 + hash2(i, 24) * 0.06, 0.45, 0.16 + hash2(i, 25) * 0.10);
      trees.setColorAt(i, tc);
    }
  }

  // rakenna aloitusalue valmiiksi (laatat + sirote origon ympärille)
  updateTerrain(0, 0, true);
  updateScatter(0, 0);

  // valaistus — auringon suunta ja voimakkuus ajetaan updateDaylightissa
  let hemi = null;
  if (cfg.hemi) {
    hemi = new THREE.HemisphereLight(cfg.hemi[0], cfg.hemi[1], cfg.hemi[2]);
    sc.add(hemi);
  }
  const lightDef = cfg.sun ?? cfg.dirLight;
  const dl = new THREE.DirectionalLight(cfg.sun ? 0xffffff : cfg.dirLight.color, lightDef.intensity);
  if (cfg.dirLight) dl.position.copy(new THREE.Vector3(...cfg.dirLight.dir).normalize());
  sc.add(dl);

  // aurinkokiekko (jos näkyvissä) — paikka päivittyy radan mukana
  let disc = null;
  if (cfg.sun) {
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
    sc, cfg, dl, hemi, disc, starsMat,
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

// kiertoradalle voi siirtyä vain kohteen läheisyydestä
export function orbitRange(b){ return Math.max(0.5 * AU, b.def.r * 30); }
export function inOrbitRange(i){
  const b = bodies[i];
  return camera.position.distanceTo(b.group.position) < orbitRange(b);
}

export function teleportToOrbit(){
  if (S.mode !== 'space' || !inOrbitRange(S.targetIdx)) return;
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
  renderPass.scene = scene;
  scene.add(camera);          // kamera takaisin avaruusscenen jäseneksi
  document.body.classList.remove('surface');
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
let descentV = 0;
const descentPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export function checkDescentEntry(){
  if (S.mode !== 'space' || S.effFrac > IMPACT_MAX) return;
  for (const b of bodies) {
    if (!ROCKY.has(b.def.name)) continue;
    if (camera.position.distanceTo(b.group.position) < b.def.r * DESCENT_TRIGGER) {
      enterDescent(b);
      return;
    }
  }
}

function enterDescent(b){
  // sisääntulovauhti skaalataan lähestymisnopeudesta (60–300 m/s)
  const v = 60 + (S.effFrac / IMPACT_MAX) * 240;
  enterSurfaceScene(b, 'descent');
  descentV = v;
  descentPos.set(0, 650, 0);
  S.pitch = Math.min(S.pitch, -0.25);   // sisään aina laskevassa liu'ussa
  S.roll = 0;
  camera.fov = 65; camera.updateProjectionMatrix();
  updateDaylight();
  document.getElementById('surfTitle').textContent =
    `${b.def.name.toUpperCase()} — MATALALENTO`;
}

export function abortDescent(){
  if (S.mode !== 'descent') return;
  const idx = bodies.indexOf(surfaceBody);
  leaveSurfaceScene();
  placeNearBody(idx, 1.5);
}

export function updateDescent(dt){
  updateDaylight();
  // W/S säätää vauhtia
  if (S.keys.KeyW || S.keys.ArrowUp)   descentV += 200 * dt;
  if (S.keys.KeyS || S.keys.ArrowDown) descentV -= 200 * dt;
  descentV = Math.max(35, Math.min(450, descentV));

  // alus lentää katseen suuntaan
  camera.rotation.set(S.pitch, S.yaw, 0, 'YXZ');
  camera.getWorldDirection(_fwd);
  descentPos.addScaledVector(_fwd, descentV * dt);
  updateTerrain(descentPos.x, descentPos.z);
  updateScatter(descentPos.x, descentPos.z);

  const ground = surfHeightFn(descentPos.x, descentPos.z);
  const alt = descentPos.y - ground;

  // ylös avaruuteen
  if (descentPos.y > DESCENT_CEIL) { abortDescent(); return; }

  // kosketus maastoon: kovaa = tuho, hiljaa = pehmeä lasku kävelymoodiin
  if (alt <= 2.6) {
    if (descentV > SOFT_V) {
      const name = surfaceBody.def.name;
      const v = Math.round(descentV);
      leaveSurfaceScene();
      destroyShip(`Alus törmäsi pintaan ${v} m/s vauhdissa (${name}).`);
      return;
    }
    S.mode = 'surface';
    surfX = descentPos.x; surfZ = descentPos.z;
    bobPhase = 0; bobAmp = 0;
    const cfg = SURFACE_CONFIGS[surfaceBody.def.name];
    document.getElementById('surfTitle').textContent = cfg.title;
    document.getElementById('surfInfo').textContent = cfg.info;
    return;
  }

  camera.position.copy(descentPos);
  document.getElementById('surfInfo').textContent =
    `korkeus ${Math.round(alt)} m · vauhti ${Math.round(descentV)} m/s — hiiri ohjaa · ` +
    `W/S = vauhti · kosketus alle ${SOFT_V} m/s = lasku · ylös tai B = takaisin avaruuteen`;
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
  };
}
