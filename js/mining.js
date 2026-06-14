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
const ORE = [
  { type: 'rauta',      col: 0x8a3414, emis: 0x431706, w: 0.42 },
  { type: 'silikaatti', col: 0x9a8e74, emis: 0x2a2418, w: 0.38 },
  { type: 'jaa',        col: 0x9fd6ee, emis: 0x214a5c, w: 0.20 },
];
function pickOre(){ const r = Math.random(); let a = 0; for (const o of ORE) { a += o.w; if (r < a) return o; } return ORE[0]; }

const COUNT = 22, NEAR = 8, FAR = 70;
const MINE_TIME = 1.2, REACH = 14, AIM_COS = 0.975;   // louhinta-aika (s), kantama (m, 3D), tähtäyskartio ~13°
let deposits = [];
let scene = null, heightFn = null, active = false;
let oreGeo = null, oreMats = null;   // luodaan per pintakäynti (scene-dispose hävittää)
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
  const dark = new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.5, metalness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.32, metalness: 0.95 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x6fe0ff });
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.62, 0.045), dark);
  handle.position.set(0, -0.12, 0);
  g.add(handle);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.05), steel);
  grip.position.set(0, -0.36, 0);
  g.add(grip);
  // hakun pää: viistetty poikkipalkki + kaksi kärkeä
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.07), steel);
  head.position.set(0, 0.19, 0); head.rotation.z = 0.16;
  g.add(head);
  for (const s of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 4), steel);
    tip.position.set(s * 0.2, 0.19 + s * 0.03, 0);
    tip.rotation.z = (s > 0 ? -Math.PI / 2 : Math.PI / 2) + 0.16;
    g.add(tip);
  }
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.015, 0.02), glow);   // energiakärki
  edge.position.set(0, 0.215, 0.035); edge.rotation.z = 0.16;
  g.add(edge);
  g.position.copy(TOOL_POS);
  g.rotation.set(TOOL_ROT.x, TOOL_ROT.y, TOOL_ROT.z);
  g.visible = false;
  camera.add(g);
  return g;
}
const tool = buildTool();
function updateTool(dt, swinging){
  swingAmt += ((swinging ? 1 : 0) - swingAmt) * Math.min(1, dt * 12);
  if (swinging || swingAmt > 0.02) swingT += dt;
  const c = Math.sin(((swingT * 3.0) % 1) * Math.PI);   // ~3 iskua/s, 0→1→0 kaari
  const k = c * swingAmt;
  tool.position.set(TOOL_POS.x, TOOL_POS.y - k * 0.10, TOOL_POS.z - k * 0.16);
  tool.rotation.set(TOOL_ROT.x - k * 1.15, TOOL_ROT.y, TOOL_ROT.z + k * 0.55);
}

function makeDeposit(){
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {                 // pieni kivenlohkareklusteri
    const m = new THREE.Mesh(oreGeo, oreMats.rauta);
    const s = 0.5 + Math.random() * 0.75;
    m.scale.setScalar(s);
    m.position.set((Math.random() - 0.5) * 1.7, s * 0.45, (Math.random() - 0.5) * 1.7);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
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
  const ang = Math.random() * Math.PI * 2;
  const dist = NEAR + Math.random() * (FAR - NEAR);
  d.x = px + Math.cos(ang) * dist;
  d.z = pz + Math.sin(ang) * dist;
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
  oreGeo = new THREE.IcosahedronGeometry(0.85, 0);
  oreMats = {};
  for (const o of ORE) oreMats[o.type] = new THREE.MeshStandardMaterial({
    color: o.col, emissive: o.emis, roughness: 0.6, metalness: 0.25, flatShading: true });
  for (let i = 0; i < COUNT; i++) {
    const d = makeDeposit();
    relocate(d, 0, 0);
    d.pop = 1; d.mesh.scale.setScalar(1);       // alussa täysikokoisia
    deposits.push(d);
    sc.add(d.mesh);
  }
  // murtumispurskeen sirupooli
  burstGeo = new THREE.IcosahedronGeometry(0.13, 0);
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
