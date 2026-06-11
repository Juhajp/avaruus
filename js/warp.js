/* ---------------- Warp-efekti ---------------- */
import * as THREE from 'three';
import { camera } from './core.js';
import { NOISE_GLSL, registerMat } from './shaders.js';
import { S } from './state.js';

const warpGroup = new THREE.Group();
warpGroup.visible = false;
camera.add(warpGroup);

// slit-scan-valokäytävän kuori: pitkät valoraidat ja vaeltava spektripaletti
function makeWarpShellMaterial(phase, speedMul, gain){
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uSpeed: { value: 3 },
      uPhase: { value: phase },
      uSpeedMul: { value: speedMul },
      uGain: { value: gain },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying float vUp;
      void main(){
        vUv = uv;
        // pystysuuntakomponentti ruutukoordinaateissa (kuori on kameran lapsi):
        // 1 suoraan ylä-/alapuolella, 0 sivuilla — slit-scan-valotasojen painotus
        vUp = abs(normalize(position.xy).y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      varying float vUp;
      uniform float uTime; uniform float uStrength; uniform float uSpeed;
      uniform float uPhase; uniform float uSpeedMul; uniform float uGain;
      ` + NOISE_GLSL + /* glsl */`
      void main(){
        float t = uTime;
        float ang = vUv.x * 6.2831853;
        float z = vUv.y;
        float sp = uSpeed * uSpeedMul;
        // jaksolliset ympyräkoordinaatit — ei saumaa UV:n rajalla
        vec2 cu = vec2(cos(ang), sin(ang));
        // hyvin loiva huojunta — slit-scan on geometrinen, ei pyörteinen
        float wob = snoise(vec3(cu * 0.8 + uPhase, z * 2.0 - t * 0.35)) * 0.09;
        vec2 c2 = vec2(cos(ang + wob), sin(ang + wob));
        // pitkät valoraidat: tiheä kulmajako, matala z-taajuus → z-suuntaan venyneet juovat
        float band = 0.5 + 0.5 * snoise(vec3(c2 * 9.0 + uPhase, z * 0.8 - t * sp));
        band = pow(clamp(band * 1.32, 0.0, 1.0), 7.0);
        // leveämmät valovirrat samaan suuntaan
        float flow = 0.5 + 0.5 * snoise(vec3(c2 * 3.2 - uPhase, z * 0.5 - t * sp * 0.6));
        flow = pow(clamp(flow * 1.15, 0.0, 1.0), 4.0);
        // valotasokäytävä: kirkkaus keskittyy ylä- ja alapintaan, sivut jäävät hämäriksi
        float wall = mix(0.18, 1.0, pow(vUp, 2.5));
        // hitaasti vaeltavat spektrin värivaiheet (cos-paletti); kulkee myös syvyyden mukana
        float hueT = t * 0.045 + uPhase * 0.12 + z * 0.30
                   + snoise(vec3(c2 * 0.6, z * 1.2 - t * 0.4)) * 0.10;
        vec3 base = 0.5 + 0.5 * cos(6.2831853 * (hueT + vec3(0.0, 0.33, 0.67)));
        base = base * base * 1.25;   // kylläisemmät, syvemmät sävyt
        vec3 col = base * (band * 1.05 + flow * 0.22) * wall;
        col += vec3(1.0, 0.98, 0.95) * pow(band, 3.0) * pow(vUp, 3.0) * 0.45;  // valkoiset ytimet valotasoissa
        // häivytys tunnelin päissä — keskinäkymä jää avoimeksi kohti katoamispistettä
        float fade = smoothstep(0.02, 0.30, z) * smoothstep(1.0, 0.45, z);
        col *= fade * uStrength * uGain;
        gl_FragColor = vec4(col, 1.0);
        #include <logdepthbuf_fragment>
      }`,
  });
  return registerMat(m);
}

const warpShellMats = [
  makeWarpShellMaterial(0.0, 1.0, 0.45),   // sisempi: nopea ja kirkas
  makeWarpShellMaterial(4.7, 0.55, 0.18),  // ulompi: hidas ja utuinen
];
{
  const giInner = new THREE.CylinderGeometry(10, 50, 420, 72, 32, true);
  giInner.rotateX(-Math.PI / 2);
  const inner = new THREE.Mesh(giInner, warpShellMats[0]);
  inner.position.z = -130;
  inner.frustumCulled = false;
  warpGroup.add(inner);
  const giOuter = new THREE.CylinderGeometry(18, 78, 480, 72, 32, true);
  giOuter.rotateX(-Math.PI / 2);
  const outer = new THREE.Mesh(giOuter, warpShellMats[1]);
  outer.position.z = -140;
  outer.frustumCulled = false;
  warpGroup.add(outer);
}

// tähtijuovat liukuvärillä (kirkas kärki, kylläinen häntä)
const WARP_N = 360;
const warpZ  = new Float32Array(WARP_N);
const warpXY = new Float32Array(WARP_N * 2);
const warpPos = new Float32Array(WARP_N * 6);
const warpCol = new Float32Array(WARP_N * 6);
for (let i = 0; i < WARP_N; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = 5 + Math.random() * 38;
  warpXY[i * 2]     = Math.cos(a) * r;
  warpXY[i * 2 + 1] = Math.sin(a) * r;
  warpZ[i] = -210 + Math.random() * 220;
  const o = i * 6;
  // sävy spektrin yli (sama cos-paletti kuin kuorissa) — kärki lähes valkoinen, häntä kylläinen
  const h = Math.random();
  const cr = 0.5 + 0.5 * Math.cos(2 * Math.PI * h);
  const cg = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.33));
  const cb = 0.5 + 0.5 * Math.cos(2 * Math.PI * (h + 0.67));
  warpCol[o]     = 0.65 + cr * 0.35; warpCol[o + 1] = 0.65 + cg * 0.35; warpCol[o + 2] = 0.65 + cb * 0.35;
  warpCol[o + 3] = cr * 0.60;        warpCol[o + 4] = cg * 0.60;        warpCol[o + 5] = cb * 0.60;
}
const warpGeo = new THREE.BufferGeometry();
warpGeo.setAttribute('position', new THREE.BufferAttribute(warpPos, 3));
warpGeo.setAttribute('color', new THREE.BufferAttribute(warpCol, 3));
const warpMat = new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const warpLines = new THREE.LineSegments(warpGeo, warpMat);
warpLines.frustumCulled = false;
warpGroup.add(warpLines);

let warpStrength = 0;
let prevEffFrac = 0;
export function updateWarp(dt){
  // voimakkuus skaalautuu kiihtyvyyden mukaan: raju kiihdytys = kirkas efekti,
  // kevyt kiihdytys = himmeä. Tasaisessa vauhdissa häipyy ~3 sekunnissa.
  const accelRate = Math.max(0, (S.effFrac - prevEffFrac) / Math.max(dt, 1e-4));
  prevEffFrac = S.effFrac;
  const accelNorm = Math.min(1, accelRate / 0.9);   // ~0.9/s (M-näppäin) antaa täyden tehon
  const base = Math.max(0, Math.min(1, (S.effFrac - 0.10) / 0.20)) * (1 - S.dragWeight);
  const target = base * accelNorm;
  const rate = target > warpStrength ? 5 : 1.2;   // nopea syttyminen, pehmeä häipyminen
  warpStrength += (target - warpStrength) * (1 - Math.exp(-dt * rate));
  if (warpStrength < 0.02) { warpGroup.visible = false; return; }
  warpGroup.visible = true;
  warpMat.opacity = Math.min(0.85, warpStrength);
  for (const m of warpShellMats) {
    m.uniforms.uStrength.value = warpStrength;
    m.uniforms.uSpeed.value = 2.0 + S.effFrac * 6.0;
  }
  // kiihdytys venyttää juovia
  const accel = S.targetFrac > S.speedFrac + 0.005 ? 1.7 : 1.0;
  const speedZ = 80 + S.effFrac * 900;
  const len = (3 + S.effFrac * 28) * accel;
  for (let i = 0; i < WARP_N; i++) {
    warpZ[i] += speedZ * dt;
    if (warpZ[i] > 10) warpZ[i] -= 230;
    const x = warpXY[i * 2], y = warpXY[i * 2 + 1];
    const o = i * 6;
    warpPos[o] = x;     warpPos[o + 1] = y; warpPos[o + 2] = warpZ[i];
    warpPos[o + 3] = x; warpPos[o + 4] = y; warpPos[o + 5] = warpZ[i] - len;
  }
  warpGeo.attributes.position.needsUpdate = true;
}

// sammuta efekti heti (esim. pinnalle laskeuduttaessa)
export function resetWarp(){
  warpGroup.visible = false;
  warpStrength = 0;
}
