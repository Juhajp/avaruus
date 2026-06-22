/* ---------------- Cell shading: yhteinen toon-materiaali + ääriviivat ----------------
   MeshToonMaterial kvantitaa valaistuksen porrastetuksi (toonRamp gradientMap →
   litteä sarjakuvamainen varjostus) ja säilyttää tekstuurit (map/normalMap/
   bumpMap). Musta ääriviiva piirretään käänteisellä kuorella (inverted hull:
   geometrian klooni, verteksit työnnetty normaalia pitkin ulos, BackSide).
   Jaettu sukkulan/ohjaamoiden, kivien, mineraalien ja työkalun kesken. */
import * as THREE from 'three';

let _toonRamp = null;
export function toonRamp(){
  if (_toonRamp) return _toonRamp;
  const steps = new Uint8Array([55, 145, 255]);   // 3 selvää sävyporrasta (vahva cell-shade)
  _toonRamp = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  _toonRamp.minFilter = _toonRamp.magFilter = THREE.NearestFilter;
  _toonRamp.needsUpdate = true;
  return _toonRamp;
}

// luo MeshToonMaterial (säilyttää map/normalMap/bumpMap) + jaettu sävyrampi
export function toonMat(params){
  return new THREE.MeshToonMaterial(Object.assign({ gradientMap: toonRamp() }, params));
}

// käänteisen kuoren geometria: klooni, verteksit työnnetty ulos.
// Työntösuunta on HITSATTU normaali (jaetun position-paikan normaalien keskiarvo)
// eikä raaka per-vertex-normaali — muuten flat-varjostetuilla/fasetoiduilla
// kappaleilla (esim. ikosaedrikivet, joiden jaetut verteksit osoittavat eri
// suuntiin) ääriviivan kuori repeää saumoista ja näyttää KATKONAISELTA.
export function expandGeo(geo, thickness){
  const g = geo.clone();
  const p = g.attributes.position, n = g.attributes.normal;
  if (!n) return g;
  const acc = new Map();
  const key = (x, y, z) => Math.round(x * 1000) + ',' + Math.round(y * 1000) + ',' + Math.round(z * 1000);
  for (let i = 0; i < p.count; i++) {
    const k = key(p.getX(i), p.getY(i), p.getZ(i));
    let a = acc.get(k);
    if (!a) { a = [0, 0, 0]; acc.set(k, a); }
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
  }
  for (let i = 0; i < p.count; i++) {
    const a = acc.get(key(p.getX(i), p.getY(i), p.getZ(i)));
    const len = Math.hypot(a[0], a[1], a[2]) || 1;
    p.setXYZ(i,
      p.getX(i) + a[0] / len * thickness,
      p.getY(i) + a[1] / len * thickness,
      p.getZ(i) + a[2] / len * thickness);
  }
  p.needsUpdate = true;
  return g;
}

export function outlineMaterial(){
  return new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
}

// lisää musta ääriviiva jokaiselle toon-meshille ryhmässä. Kopioi lähteen
// paikan/kierron/skaalan ja lisää ääriviivan saman vanhemman lapseksi → toimii
// myös yhdistämättömille meshille (joilla on oma transformaatio).
export function addOutlines(g, thickness){
  const adds = [];
  g.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || !o.material || !o.material.isMeshToonMaterial) return;
    if (!o.geometry.attributes.normal) return;
    const om = new THREE.Mesh(expandGeo(o.geometry, thickness), outlineMaterial());
    om.position.copy(o.position);
    om.quaternion.copy(o.quaternion);
    om.scale.copy(o.scale);
    adds.push({ om, parent: o.parent });
  });
  for (const { om, parent } of adds) parent.add(om);
}
