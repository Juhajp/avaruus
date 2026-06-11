/* ---------------- Ilmakehään syöksyminen: kitkajarrutus, plasma, runkolämpö ----------------
   Kappaleilla, joilla on atmo-määrittely, on ilmakehävyöhyke (ATMO_FLOOR–ATMO_TOP × säde).
   Vyöhykkeessä ilmanvastus jarruttaa nopeuden ja tiheyden mukaan, kitkalämpö sytyttää
   plasmahehkun ja ravistelee kameraa. Runkolämmön täyttyessä alus tuhoutuu ja peli
   palaa aloitusnäkymään Maan luo. Merkuriuksella (ei atmoa) törmäyssuoja toimii ennallaan. */
import * as THREE from 'three';
import { camera } from './core.js';
import { bodies, placeNearBody } from './bodies.js';
import { NOISE_GLSL, registerMat } from './shaders.js';
import { S } from './state.js';

const ATMO_TOP = 3.0;      // ilmakehän yläraja (× säde) — pelillisesti paksu, jotta syöksy kestää hetken
const ATMO_FLOOR = 1.15;   // törmäyssuojan raja
const DRAG_K = 2.5;        // ilmanvastuksen voimakkuus
const HEAT_RATE = 7.0;     // lämmön kertyminen: täysi syöksy tappaa ennen pysähtymistä,
                           // ~5 % c selviää rajusti jarruttaen, ≤2 % c liitää lämpeämättä
const HEAT_Q0 = 0.03;      // kynnys, jonka alle jäävä kuumennus ei kerrytä lämpöä
const COOL_RATE = 0.2;     // jäähtyminen ilmakehän ulkopuolella
export const LANDING_MAX_EFF = 0.02;   // suurin nopeus (osuus c:stä), jolla G-laskeutuminen onnistuu

/* ---- plasmakuori (kameran lapsi, kuten warp) ---- */
const plasmaGroup = new THREE.Group();
plasmaGroup.visible = false;
camera.add(plasmaGroup);

const plasmaMat = registerMat(new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uHot: { value: 0 },
    uColor: { value: new THREE.Vector3(1.0, 0.55, 0.22) },
  },
  transparent: true,
  depthWrite: false,
  depthTest: false,   // plasma piirtyy aina planeetan päälle — muuten lähellä oleva pinta peittää sen
  blending: THREE.AdditiveBlending,
  side: THREE.BackSide,
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec2 vUv;
    uniform float uTime; uniform float uIntensity; uniform float uHot;
    uniform vec3 uColor;
    ` + NOISE_GLSL + /* glsl */`
    void main(){
      float t = uTime;
      float ang = vUv.x * 6.2831853;
      float z = vUv.y;
      // jaksolliset ympyräkoordinaatit — ei saumaa UV:n rajalla
      vec2 cu = vec2(cos(ang), sin(ang));
      // ohi virtaavat plasmajuovat: nopea virtaus pituussuunnassa
      float str = 0.5 + 0.5 * snoise(vec3(cu * 5.0, z * 2.2 + t * 11.0));
      str = pow(clamp(str * 1.35, 0.0, 1.0), 5.0);
      float wide = 0.5 + 0.5 * snoise(vec3(cu * 1.8 + 4.7, z * 1.1 + t * 6.0));
      wide = pow(clamp(wide * 1.2, 0.0, 1.0), 3.0);
      // liekehtivä lepatus
      float flick = 0.82 + 0.18 * snoise(vec3(t * 7.0, cu * 1.5));
      vec3 col = mix(uColor, vec3(1.0, 0.96, 0.86), clamp(uHot * (0.3 + str), 0.0, 1.0));
      float fade = smoothstep(0.0, 0.25, z) * smoothstep(1.0, 0.55, z);
      col *= (str * 1.15 + wide * 0.30) * fade * uIntensity * flick;
      gl_FragColor = vec4(col, 1.0);
      #include <logdepthbuf_fragment>
    }`,
}));
{
  const gi = new THREE.CylinderGeometry(7, 30, 80, 64, 24, true);
  gi.rotateX(-Math.PI / 2);
  const shell = new THREE.Mesh(gi, plasmaMat);
  shell.position.z = -34;
  shell.frustumCulled = false;
  shell.renderOrder = 999;   // piirretään viimeisenä kaiken päälle
  plasmaGroup.add(shell);
}

/* ---- tila ja HUD ---- */
let heat = 0;
let destroyed = false;
const heatRow = document.getElementById('heatRow');
const heatPct = document.getElementById('heatPct');
const heatBar = document.getElementById('heatBar');
const deathOverlay = document.getElementById('deathOverlay');
const flash = document.getElementById('flash');
let lastQ = 0, lastDensity = 0;

deathOverlay.addEventListener('click', () => {
  deathOverlay.style.display = 'none';
  destroyed = false;
});

function destroy(name){
  destroyed = true;
  heat = 0;
  S.targetFrac = 0; S.speedFrac = 0;
  plasmaGroup.visible = false;
  heatRow.style.display = 'none';
  document.getElementById('deathReason').textContent =
    `Kitkakuumennus ylitti rungon sietokyvyn (${name}).`;
  // valkoinen välähdys, joka häipyy tuhoutumisruudun päältä
  flash.style.transition = 'none';
  flash.style.opacity = '1';
  flash.getBoundingClientRect();   // pakota reflow ennen siirtymän palautusta
  flash.style.transition = '';
  flash.style.opacity = '0';
  deathOverlay.style.display = 'flex';
  placeNearBody(3);   // paluu aloitusnäkymään Maan luo
}

export function updateReentry(dt){
  if (destroyed) return;

  // lähimmän ilmakehällisen kappaleen tiheys kamerakorkeudella
  let density = 0, inBody = null;
  for (const b of bodies) {
    if (!b.def.atmo) continue;
    const d = camera.position.distanceTo(b.group.position);
    const top = b.def.r * ATMO_TOP, floor = b.def.r * ATMO_FLOOR;
    if (d < top) {
      const t = Math.min(1, (top - d) / (top - floor));
      const dens = t * t * t;   // tiheys kasvaa jyrkästi alaspäin
      if (dens > density) { density = dens; inBody = b; }
    }
  }

  const speedNorm = Math.min(1, S.effFrac / 0.1);   // lähialueella nopeusalue on 1–10 % c
  const q = density * speedNorm * speedNorm;        // dynaaminen paine / kitkakuumennus
  lastQ = q; lastDensity = density;

  // ilmanvastus jarruttaa — sitä rajummin mitä syvemmällä ja kovempaa
  if (density > 0) {
    const drag = Math.exp(-dt * DRAG_K * density * (0.25 + speedNorm));
    S.speedFrac *= drag;
    S.targetFrac = Math.min(S.targetFrac, S.speedFrac);
  }

  // runkolämpö: kova kuumennus kerryttää, muuten jäähtyy
  heat += dt * (HEAT_RATE * Math.max(0, q - HEAT_Q0) - (q < HEAT_Q0 ? COOL_RATE : 0));
  heat = Math.max(0, heat);
  if (heat >= 1) { destroy(inBody ? inBody.def.name : '?'); return; }

  // tärinä: dynaamisen paineen tahdissa, kuumana rajumpi
  if (q > 0.002) {
    const amp = 0.012 * q + 0.03 * q * heat;
    camera.rotation.x += (Math.random() - 0.5) * amp;
    camera.rotation.y += (Math.random() - 0.5) * amp;
    camera.rotation.z += (Math.random() - 0.5) * amp * 0.6;
  }

  // plasmahehku
  const vis = Math.min(1.3, q * 2.5 + heat * 0.3);
  if (vis > 0.02 && inBody) {
    plasmaGroup.visible = true;
    plasmaMat.uniforms.uIntensity.value = vis;
    plasmaMat.uniforms.uHot.value = Math.min(1, heat + q * 0.5);
    // plasman pohjaväri: kuuma oranssi, kevyesti planeetan ilmakehän sävyyn taitettuna
    const a = inBody.def.atmo.color;
    plasmaMat.uniforms.uColor.value.set(
      1.0 * 0.75 + a[0] * 0.25, 0.55 * 0.75 + a[1] * 0.25, 0.22 * 0.75 + a[2] * 0.25);
  } else {
    plasmaGroup.visible = false;
  }

  // HUD-rivi
  if (heat > 0.01 || q > 0.01) {
    heatRow.style.display = 'block';
    heatPct.textContent = Math.round(heat * 100);
    heatBar.style.width = `${Math.min(100, heat * 100)}%`;
  } else {
    heatRow.style.display = 'none';
  }
}

// debug-koukkua varten
export function reentryDebug(){
  return { heat, q: lastQ, density: lastDensity, destroyed };
}
