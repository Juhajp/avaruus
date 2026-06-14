/* ---------------- Renderer, scene, kamera, composer + mittakaava ---------------- */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ============================================================
   Mittakaava
   1 AU = 1000 yksikköä. Neptunus ~30.07 AU.
   c valitaan niin, että 0.99 c -matka Maasta Neptunukseen (~29 AU)
   kestää noin 5 minuuttia.
   ============================================================ */
export const AU = 1000;
export const C  = (30.07 * AU) / (0.99 * 300);   // ~101.2 yksikköä/s
export const C_KMS = 299792.458;

export const DEG = Math.PI / 180;
export const ORBIT_BASE_PERIOD = 360;            // Maan kiertoaika sekunteina (Kepler: T ∝ a^1.5)

function createRenderer(){
  // yritä useilla kokoonpanoilla: täysi laatu -> ilman antialiasia -> virransäästö
  const attempts = [
    { antialias:true,  logarithmicDepthBuffer:true },
    { antialias:false, logarithmicDepthBuffer:true },
    { antialias:false, logarithmicDepthBuffer:true, powerPreference:'low-power' },
  ];
  for (const opts of attempts) {
    try { return new THREE.WebGLRenderer(opts); } catch (err) { /* kokeile seuraavaa */ }
  }
  // mikään ei onnistunut — selvitä miksi ja neuvo käyttäjää
  const has2 = !!document.createElement('canvas').getContext('webgl2');
  const has1 = !!document.createElement('canvas').getContext('webgl');
  let msg;
  if (!has2 && !has1) {
    msg = 'WebGL on poissa käytöstä selaimessa. Korjaus: avaa chrome://settings/system, kytke '
        + '"Käytä grafiikkakiihdytystä, jos saatavilla" päälle ja käynnistä Chrome uudelleen. '
        + 'Tarkista sitten chrome://gpu — WebGL- ja WebGL2-rivien pitäisi olla "Hardware accelerated". '
        + '(WebGL voi myös olla tilapäisesti estetty GPU-virheen jälkeen — pelkkä Chromen uudelleenkäynnistys voi riittää.)';
  } else if (!has2) {
    msg = 'Selain tarjoaa vain WebGL 1:n, mutta simulaattori tarvitsee WebGL 2:n. '
        + 'Päivitä Chrome uusimpaan versioon ja tarkista chrome://gpu (WebGL2-rivi).';
  } else {
    msg = 'WebGL2 on tuettu, mutta kontekstin luonti epäonnistui silti. '
        + 'Sulje muut raskaat WebGL-välilehdet tai käynnistä Chrome uudelleen.';
  }
  window.__bootError(msg);
  throw new Error('WebGL unavailable');
}
export const renderer = createRenderer();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;                  // varjot pintamoodissa; avaruudessa ei heittäjiä
renderer.shadowMap.type = THREE.PCFShadowMap;   // tarkkarajaisemmat varjot (vähemmän "savumaista" pehmennystä)
document.getElementById('app').appendChild(renderer.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 400000);
scene.add(camera);   // jotta kameraan kiinnitetyt efektit (warp) renderöityvät

export const composer = new EffectComposer(renderer);
export const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

/* Lämpöväreily: ruudun alaosan uv-huojunta (moottorin kuuma ilma laskussa).
   Pass on käytössä vain kun amplitudi > 0 — muuten nollakustannus. */
const HeatShimmerShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmp: { value: 0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAmp;
    varying vec2 vUv;
    void main(){
      float m = smoothstep(0.85, 0.2, vUv.y);   // voimistuu alareunaa kohti
      vec2 off = vec2(
        sin(vUv.y * 72.0 + uTime * 9.2) + sin(vUv.y * 31.0 - uTime * 5.3 + vUv.x * 17.0),
        sin(vUv.x * 47.0 + uTime * 7.1 + vUv.y * 23.0)
      ) * (uAmp * m) * vec2(1.0, 0.55);
      gl_FragColor = texture2D(tDiffuse, vUv + off);
    }`,
};
const heatPass = new ShaderPass(HeatShimmerShader);
heatPass.enabled = false;
composer.addPass(heatPass);
export function setHeatShimmer(amp, time){
  heatPass.uniforms.uAmp.value = amp;
  heatPass.uniforms.uTime.value = time;
  heatPass.enabled = amp > 0.00005;
}

const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.5, 1.08);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
