/* ---------------- Pintalouhinta + jalostus (ei taloutta) ----------------
   Marsin pinnalla (kävelymoodi) on hehkuvia mineraaliesiintymiä, joita kerätään
   kävelemällä niiden yli. Kerätyt raaka-aineet voi jalostaa (C = jalostuspaneeli)
   tuotteiksi. Varasto on jaetussa tilassa `S.inv`. Esiintymät ovat kevyt
   kierrätyspooli (kuten muu sirote) — vain lähimmät pidetään pelaajan ympärillä,
   kerätty siirtyy uuteen paikkaan, joten louhittavaa riittää loputtomasti. */
import * as THREE from 'three';
import { camera } from './core.js';
import { S } from './state.js';

export const ITEM_NAMES = {
  rauta: 'Rautaoksidi', silikaatti: 'Silikaatit', jaa: 'Vesijää',
  teras: 'Teräs', happi: 'Happisäiliö', komposiitti: 'Komposiitti', paneeli: 'Runkopaneeli',
};
// jalostusreseptit: kuluttaa varastosta in-osat, tuottaa out-tuotteen varastoon.
// Happisäiliö ja Runkopaneeli ovat käyttötuotteita: ne varastoidaan ja käytetään
// erikseen (J/K tai HUD-napit, resources.js) aluksen hapen/rungon täyttöön.
export const RECIPES = [
  { out: 'teras',       in: { rauta: 3 } },
  { out: 'komposiitti', in: { silikaatti: 3 } },
  { out: 'happi',       in: { jaa: 2 } },
  { out: 'paneeli',     in: { teras: 2, komposiitti: 1 } },
];
const RAW = ['rauta', 'silikaatti', 'jaa'];
const MADE = ['teras', 'komposiitti', 'happi', 'paneeli'];

// esiintymätyypit: väri, emissio (hehku) ja suhteellinen yleisyys
// kivimäisiä esiintymiä: sama tekstuuri kuin tavallisilla kivillä, mutta hillitty
// tunnusväri (kerrotaan kivitekstuurilla) erottaa lajit toisistaan ja kivistä
const ORE = [
  { type: 'rauta',      col: 0xc86a42, w: 0.42 },   // ruosteenpunainen vivahde
  { type: 'silikaatti', col: 0xbcbcae, w: 0.38 },   // vaalean harmaa
  { type: 'jaa',        col: 0x9ec6de, w: 0.20 },    // sinertävä
];
function pickOre(){ const r = Math.random(); let a = 0; for (const o of ORE) { a += o.w; if (r < a) return o; } return ORE[0]; }

const COUNT = 12, NEAR = 16, FAR = 70;
const MINE_TIME = 1.2, REACH = 14, AIM_COS = 0.975;   // louhinta-aika (s), kantama (m, 3D), tähtäyskartio ~13°
const COLLIDE_R = 1.5;                                 // esiintymän törmäyssäde (ei voi kävellä läpi)
const _col = [0, 0];
let deposits = [];
let scene = null, heightFn = null, active = false;
let oreGeo = null, oreMats = null;   // luodaan per pintakäynti (scene-dispose hävittää)
let mineralEnv = null;               // taivaan IBL-kartta heijastuksiin (surface.js asettaa)
let rockMap = null, rockNor = null;  // planeetan kivitekstuuri + normaalikartta (surface.js asettaa)

// surface.js kutsuu kun taivaan ympäristökartta on valmis → mineraalit heijastavat sitä
export function setMineralEnv(tex){
  mineralEnv = tex;
  if (oreMats) for (const k in oreMats) { oreMats[k].envMap = tex; oreMats[k].needsUpdate = true; }
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
// murtumispurske: pieni pooli kivensiruja, jotka sinkoutuvat mineraalin värissä
const BURST_POOL = 30, BURST_PER = 14, BURST_G = 8;
let bursts = [], burstGeo = null;
const _bd = new THREE.Vector3();
let _lmb = false;                    // hiiren vasen pohjassa (= louhi)
let mineTarget = null, mineProg = 0; // nykyinen louhintakohde ja edistymä
const _fwd = new THREE.Vector3(), _to = new THREE.Vector3();

/* ---- ensimmäisen persoonan louhintatyökalu (kameran lapsi) ----
   Stilisoitu metallihakku oikeassa alakulmassa; heiluu kaarella kun louhitaan
   (Minecraft-tyylinen hakkuanimaatio). Näkyy vain Marsin kävelymoodissa. */
const TOOL_POS = new THREE.Vector3(0.42, -0.46, -0.95);
const TOOL_ROT = new THREE.Vector3(-0.30, 0.62, 0.35);
let swingT = 0, swingAmt = 0;
function buildTool(){
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.9, metalness: 0.0 });
  // himmeä, karhea metalli — ei peilimäisiä kirkkaita heijastuksia (ei "loista")
  const steel = new THREE.MeshStandardMaterial({ color: 0x70777f, roughness: 0.72, metalness: 0.35, envMapIntensity: 0.35 });
  // varsi (puu) + teräskaulus
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.025, 0.6, 10), wood);
  handle.position.set(0, -0.1, 0); g.add(handle);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.04, 0.07, 10), steel);
  collar.position.set(0, 0.18, 0); g.add(collar);
  // pää: kaksipäinen teräskärki poikittain varteen nähden (klassinen hakku)
  const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), steel);
  head.scale.set(0.78, 0.1, 0.12);            // pitkä X-suunnassa, ohut → kaksi kärkeä
  head.position.set(0, 0.205, 0.015);
  head.rotation.set(0.22, Math.PI / 2 - 0.35, 0);   // 90° − 20° (käännetty -40° edellisestä), kallistus eteen-alas
  g.add(head);
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
  const ph = (swingT * 2.6) % 1;
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

function makeDeposit(){
  const g = new THREE.Group();
  // kivimäinen lohkareklusteri (kuten tavalliset kivet), tyvi osin maan alle
  const n = 2 + Math.floor(Math.random() * 2);    // 2–3 lohkaretta
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(oreGeo, oreMats.rauta);
    const s = 0.55 + Math.random() * 0.7;
    m.scale.setScalar(s);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    m.position.set((Math.random() - 0.5) * 1.5, s * 0.2, (Math.random() - 0.5) * 1.5);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
  }
  return { mesh: g, type: 'rauta', x: 0, z: 0, y: 0, pop: 1 };
}
function setOre(d, ore){
  d.type = ore.type;
  for (const m of d.mesh.children) m.material = oreMats[ore.type];
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
  setOre(d, pickOre());
  d.pop = 0;                                    // kasvaa 0→1 (ilmestymisanimaatio)
  d.mesh.scale.setScalar(0.001);
}

/* kutsutaan pintascenen rakennuksesta; esiintymät vain Marsille */
export function initMining(sc, name, hFn){
  clearMining();
  if (name !== 'Mars') { renderHud(); return; }
  scene = sc; heightFn = hFn; active = true;
  oreGeo = makeOreRockGeo();
  oreMats = {};
  for (const o of ORE) {
    // kuin kivi: sama kivitekstuuri + normaalikartta, väri vain hillitty tunnusvivahde
    oreMats[o.type] = new THREE.MeshStandardMaterial({
      color: o.col, roughness: 1, metalness: 0, envMapIntensity: 0.25 });
    if (rockMap) oreMats[o.type].map = rockMap;
    if (rockNor) oreMats[o.type].normalMap = rockNor;
    if (mineralEnv) oreMats[o.type].envMap = mineralEnv;
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
    const m = new THREE.Mesh(burstGeo, oreMats.rauta);
    m.visible = false;
    sc.add(m);
    bursts.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, max: 0, base: 1 });
  }
  renderHud();
}
// sinkoa BURST_PER kivensirua mineraalin paikalta sen värissä
function spawnBurst(x, y, z, type){
  let n = 0;
  for (const b of bursts) {
    if (b.life > 0) continue;
    _bd.set(Math.random() - 0.5, Math.random() * 0.8 + 0.25, Math.random() - 0.5).normalize();
    b.vel.copy(_bd).multiplyScalar(1.6 + Math.random() * 2.6);
    b.spin.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    b.max = 0.5 + Math.random() * 0.4; b.life = b.max;
    b.base = 0.5 + Math.random() * 0.9;
    b.mesh.material = oreMats[type];
    b.mesh.position.set(x, y, z);
    b.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    b.mesh.scale.setScalar(b.base);
    b.mesh.visible = true;
    if (++n >= BURST_PER) break;
  }
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
  renderMineBar();
  renderHud();
}
function renderMineBar(){
  const el = document.getElementById('mineBar');
  if (!el) return;
  if (active && mineTarget) {
    el.style.display = 'block';
    el.firstElementChild.style.width = Math.min(100, mineProg / MINE_TIME * 100) + '%';
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
function restoreMesh(d){ d.mesh.position.set(d.x, d.y, d.z); d.mesh.scale.setScalar(d.pop); }
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
  // louhintatyökalu: näkyy Marsin pinnalla, heiluu kun louhitaan
  tool.visible = active;
  updateTool(dt, active && (_lmb || S.keys.Space));
  if (!active) return;
  updateBursts(dt);
  // kierrätä kauas jääneet eteen (ei aktiivista louhintakohdetta) + kasvuanimaatio
  for (const d of deposits) {
    if (d !== mineTarget && Math.hypot(d.x - px, d.z - pz) > FAR + 40) relocate(d, px, pz);
    if (d.pop < 1) { d.pop = Math.min(1, d.pop + dt * 3.5); if (d !== mineTarget) d.mesh.scale.setScalar(d.pop); }
  }
  // louhinta
  if (_lmb || S.keys.Space) {
    const t = aimedDeposit();
    if (t !== mineTarget) { if (mineTarget) restoreMesh(mineTarget); mineTarget = t; mineProg = 0; }
    if (mineTarget) {
      mineProg += dt;
      const f = Math.min(1, mineProg / MINE_TIME);
      const j = 0.07 * f;                        // tärinä kasvaa edistymän mukaan
      mineTarget.mesh.position.set(
        mineTarget.x + (Math.random() - 0.5) * j,
        mineTarget.y + (Math.random() - 0.5) * j,
        mineTarget.z + (Math.random() - 0.5) * j);
      mineTarget.mesh.scale.setScalar(mineTarget.pop * (1 - 0.4 * f));
      if (mineProg >= MINE_TIME) {               // murtuu → purske + saalis + ilmestyy muualle
        S.inv[mineTarget.type] = (S.inv[mineTarget.type] || 0) + 1;
        spawnBurst(mineTarget.x, mineTarget.y + 0.5, mineTarget.z, mineTarget.type);
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
function line(ids){ return ids.filter(k => (S.inv[k] || 0) > 0).map(k => `${ITEM_NAMES[k]} <b>${S.inv[k]}</b>`).join('  ·  '); }
export function renderHud(){
  const el = document.getElementById('miningHud');
  if (!el) return;
  const raw = line(RAW), made = line(MADE);
  el.innerHTML =
    (raw ? `<div class="mhRow">${raw}</div>` : '<div class="mhRow mhDim">ei raaka-aineita</div>') +
    (made ? `<div class="mhRow mhMade">${made}</div>` : '') +
    `<div class="mhHint">tähtää esiintymään + pidä hiiren vasen = louhi · C = jalostus</div>`;
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
