/* ---------------- Renderer, scene, kamera, composer + mittakaava ---------------- */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 400000);
scene.add(camera);   // jotta kameraan kiinnitetyt efektit (warp) renderöityvät

export const composer = new EffectComposer(renderer);
export const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.65, 0.5, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
