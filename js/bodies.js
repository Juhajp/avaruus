/* ---------------- Aurinkokunnan kappaleet: data, materiaalit, rakentaminen ---------------- */
import * as THREE from 'three';
import { AU, DEG, ORBIT_BASE_PERIOD, renderer, scene, camera } from './core.js';
import { NOISE_GLSL, PLANET_VERT, FRAG_HEAD, registerMat, baseUniforms } from './shaders.js';
import { S } from './state.js';

// spinP = todellinen pyörähdysaika skaalattuna: 1 h = 10 s (Maan vuorokausi 240 s).
// Negatiivinen arvo = retrogradinen pyöriminen (Venus).
export const BODIES = [
  { name:'Aurinko',   a:0,      r:120,  spinP:6091, type:'sun' },
  { name:'Merkurius', a:0.387,  r:1.9,  incl:7.0,  tilt:0.03, spinP:14076, phase:2.40, type:'rocky',
    opts:{ c1:[0.38,0.36,0.34], c2:[0.62,0.59,0.55], c3:[0.22,0.21,0.20], scale:5.0, rugged:1.0 } },
  { name:'Venus',     a:0.723,  r:4.75, incl:3.4,  tilt:2.6,  spinP:-58320, phase:4.40, type:'gas',
    opts:{ c1:[0.93,0.80,0.55], c2:[0.83,0.66,0.40], c3:[0.97,0.91,0.74], bandFreq:1.6, turb:2.6, flow:0.020 },
    atmo:{ color:[1.0,0.85,0.55], intensity:0.55, power:3.2 } },
  { name:'Maa',       a:1.0,    r:5.0,  incl:0.0,  tilt:23.4, spinP:239.3, phase:0.30, type:'earth',
    atmo:{ color:[0.30,0.55,1.0], intensity:0.9, power:3.0 } },
  { name:'Mars',      a:1.524,  r:2.66, incl:1.85, tilt:25.2, spinP:246.2, phase:1.20, type:'rocky',
    opts:{ c1:[0.48,0.21,0.10], c2:[0.70,0.37,0.18], c3:[0.26,0.11,0.06], scale:4.0, rugged:0.8, polar:0.86 },
    atmo:{ color:[0.85,0.55,0.38], intensity:0.30, power:3.5 } },
  { name:'Jupiter',   a:5.203,  r:40,   incl:1.3,  tilt:3.1,  spinP:99.3, phase:5.50, type:'gas',
    opts:{ c1:[0.70,0.55,0.38], c2:[0.93,0.87,0.74], c3:[0.46,0.30,0.18], bandFreq:7.0, turb:2.0, flow:0.015,
           spot:true, spotColor:[0.78,0.32,0.18] },
    atmo:{ color:[0.9,0.8,0.65], intensity:0.25, power:3.5 } },
  { name:'Saturnus',  a:9.537,  r:34,   incl:2.49, tilt:26.7, spinP:106.6, phase:2.80, type:'gas',
    opts:{ c1:[0.80,0.69,0.48], c2:[0.95,0.89,0.72], c3:[0.58,0.46,0.29], bandFreq:6.0, turb:1.1, flow:0.010 },
    rings:{ inner:1.25, outer:2.35 },
    atmo:{ color:[0.93,0.85,0.65], intensity:0.22, power:3.5 } },
  { name:'Uranus',    a:19.19,  r:18,   incl:0.77, tilt:97.8, spinP:172.4, phase:4.00, type:'gas',
    opts:{ c1:[0.55,0.80,0.86], c2:[0.66,0.88,0.92], c3:[0.45,0.72,0.82], bandFreq:3.0, turb:0.35, flow:0.006 },
    atmo:{ color:[0.6,0.9,0.95], intensity:0.30, power:3.5 } },
  { name:'Neptunus',  a:30.07,  r:17.5, incl:1.77, tilt:28.3, spinP:161.1, phase:0.65, type:'gas',
    opts:{ c1:[0.06,0.12,0.52], c2:[0.16,0.30,0.80], c3:[0.03,0.06,0.30], bandFreq:4.0, turb:0.8, flow:0.018 },
    atmo:{ color:[0.35,0.5,1.0], intensity:0.40, power:3.3 } },
];

/* ---------------- Aurinko ---------------- */
function makeSunMaterial(){
  return registerMat(new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    void main(){
      vec3 p = vOP * 3.5;
      float n1 = fbm(p + vec3(uTime*0.05, uTime*0.03, 0.0));
      float n2 = fbm(p * 2.7 - vec3(0.0, uTime*0.08, uTime*0.04));
      float gran = ridged(p * 7.0 + vec3(uTime*0.15));
      float temp = clamp(0.62 + 0.45*n1 + 0.30*n2 - 0.28*gran, 0.0, 1.4);
      vec3 cool = vec3(0.95, 0.30, 0.03);
      vec3 hot  = vec3(1.00, 0.93, 0.62);
      vec3 col = mix(cool, hot, temp);
      // reunatummuma (limb darkening)
      vec3 V = normalize(cameraPosition - vWP);
      float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
      float limb = 0.45 + 0.55 * pow(mu, 0.55);
      gl_FragColor = vec4(col * temp * 3.2 * limb, 1.0);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* ---------------- Kiviplaneetat ---------------- */
function makeRockyMaterial(o){
  const u = baseUniforms();
  u.uC1 = { value: new THREE.Vector3(...o.c1) };
  u.uC2 = { value: new THREE.Vector3(...o.c2) };
  u.uC3 = { value: new THREE.Vector3(...o.c3) };
  u.uScale  = { value: o.scale  ?? 4.0 };
  u.uRugged = { value: o.rugged ?? 0.8 };
  u.uPolar  = { value: o.polar  ?? 2.0 };  // >1 = ei napalakkeja
  return registerMat(new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;
    uniform float uScale; uniform float uRugged; uniform float uPolar;
    void main(){
      vec3 p = vOP * uScale + vec3(13.7);
      float h = fbm(p) * 0.6 + uRugged * 0.4 * ridged(p * 2.0);
      float h2 = fbm(p * 5.0) * 0.5 + 0.5;
      vec3 col = mix(uC3, uC1, smoothstep(-0.2, 0.5, h));
      col = mix(col, uC2, smoothstep(0.45, 0.95, h) * 0.8);
      col *= 0.85 + 0.3 * h2;
      // napalakit (Mars)
      float capEdge = uPolar + 0.06 * fbm(p * 3.0);
      float cap = smoothstep(capEdge, capEdge + 0.05, abs(vOP.y));
      col = mix(col, vec3(0.95, 0.96, 1.0), cap);
      vec3 N = normalize(vN);
      vec3 S = sunDirAt(vWP);
      float diff = clamp(dot(N, S), 0.0, 1.0);
      diff = pow(diff, 1.1);
      vec3 lit = col * (diff * 1.05 + 0.015);
      gl_FragColor = vec4(lit, 1.0);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* ---------------- Kaasujättiläiset (+ Venus) ---------------- */
function makeGasMaterial(o){
  const u = baseUniforms();
  u.uC1 = { value: new THREE.Vector3(...o.c1) };
  u.uC2 = { value: new THREE.Vector3(...o.c2) };
  u.uC3 = { value: new THREE.Vector3(...o.c3) };
  u.uBandFreq = { value: o.bandFreq ?? 6.0 };
  u.uTurb     = { value: o.turb ?? 1.0 };
  u.uFlow     = { value: o.flow ?? 0.01 };
  u.uSpot     = { value: o.spot ? 1.0 : 0.0 };
  u.uSpotColor= { value: new THREE.Vector3(...(o.spotColor ?? [0.8,0.3,0.2])) };
  return registerMat(new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;
    uniform float uBandFreq; uniform float uTurb; uniform float uFlow;
    uniform float uSpot; uniform vec3 uSpotColor;
    void main(){
      float lat = vOP.y;
      vec3 fp = vOP * vec3(2.2, 5.0, 2.2) + vec3(uTime * uFlow, 0.0, 0.0);
      float warp = fbm(fp) * uTurb;
      float band = lat * uBandFreq + warp * 0.55;
      float t1 = 0.5 + 0.5 * sin(band * 6.2831);
      t1 = smoothstep(0.12, 0.88, t1);
      float t2 = 0.5 + 0.5 * sin(band * 2.3 + 1.7);
      vec3 col = mix(uC1, uC2, t1);
      col = mix(col, uC3, t2 * 0.6);
      float streak = fbm(vOP * vec3(3.0, 14.0, 3.0) + vec3(uTime*uFlow*3.0, 0.0, 0.0));
      col *= 0.92 + 0.13 * streak;
      // Suuri punainen pilkku (Jupiter)
      if (uSpot > 0.5) {
        float lon = atan(vOP.z, vOP.x);
        float la  = asin(clamp(vOP.y, -1.0, 1.0));
        vec2 d = vec2((lon - 0.9) * cos(la) / 0.38, (la + 0.38) / 0.17);
        float sd = length(d);
        float spot = smoothstep(1.0, 0.45, sd);
        float swirl = 0.5 + 0.5 * snoise(vec3(d * 3.0, uTime * 0.05));
        vec3 sc = mix(uSpotColor, uSpotColor * 1.35, swirl);
        col = mix(col, sc, spot * 0.9);
      }
      vec3 N = normalize(vN);
      vec3 S = sunDirAt(vWP);
      float diff = clamp(dot(N, S), 0.0, 1.0);
      diff = pow(diff, 1.05);
      vec3 lit = col * (diff * 1.02 + 0.012);
      gl_FragColor = vec4(lit, 1.0);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* ---------------- Maa ---------------- */
function makeEarthMaterial(){
  return registerMat(new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    void main(){
      vec3 p = vOP * 1.6 + vec3(5.2);
      float cont = fbm(p * 1.5);
      float det  = fbm(p * 7.0);
      float land = smoothstep(0.02, 0.10, cont);
      // meri
      vec3 deepSea = vec3(0.012, 0.05, 0.16);
      vec3 shallow = vec3(0.05, 0.22, 0.38);
      vec3 sea = mix(deepSea, shallow, smoothstep(-0.25, 0.02, cont));
      // maa
      float lat = abs(vOP.y);
      vec3 green  = vec3(0.08, 0.26, 0.07);
      vec3 forest = vec3(0.05, 0.17, 0.05);
      vec3 sand   = vec3(0.62, 0.52, 0.30);
      vec3 rock   = vec3(0.38, 0.32, 0.24);
      vec3 ground = mix(green, forest, smoothstep(-0.3, 0.4, det));
      ground = mix(ground, sand, smoothstep(0.35, 0.05, lat) * smoothstep(0.1, 0.45, det));
      ground = mix(ground, rock, smoothstep(0.30, 0.60, cont));
      // lumi navoilla ja vuorilla
      float snowLine = 0.72 + 0.10 * fbm(p * 3.0);
      float snow = smoothstep(snowLine, snowLine + 0.06, lat) + smoothstep(0.55, 0.7, cont) * 0.6;
      ground = mix(ground, vec3(0.93, 0.95, 1.0), clamp(snow, 0.0, 1.0));
      vec3 col = mix(sea, ground, land);
      vec3 N = normalize(vN);
      vec3 S = sunDirAt(vWP);
      vec3 V = normalize(cameraPosition - vWP);
      float ndl = dot(N, S);
      float diff = pow(clamp(ndl, 0.0, 1.0), 1.1);
      // kaupunkien valot yöpuolella
      float city = smoothstep(0.52, 0.78, fbm(p * 9.0)) * land * smoothstep(0.75, 0.35, lat);
      float night = smoothstep(0.03, -0.18, ndl);
      vec3 lights = vec3(1.0, 0.75, 0.35) * city * night * 0.7;
      // sininen reunakajo päiväpuolella
      float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
      vec3 atmo = vec3(0.25, 0.45, 0.95) * rim * clamp(ndl * 0.8 + 0.2, 0.0, 1.0) * 0.5;
      vec3 lit = col * (diff * 1.08 + 0.012) + lights + atmo;
      gl_FragColor = vec4(lit, 1.0);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* ---------------- Pilvet (Maa) ---------------- */
function makeCloudMaterial(){
  return registerMat(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: baseUniforms(),
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    void main(){
      vec3 p = vOP * 3.2 + vec3(uTime * 0.004, 0.0, uTime * 0.002);
      float n = fbm(p) * 0.6 + 0.4 * fbm(p * 3.1);
      float a = smoothstep(0.08, 0.55, n);
      vec3 N = normalize(vN);
      vec3 S = sunDirAt(vWP);
      float diff = clamp(dot(N, S), 0.0, 1.0);
      vec3 col = vec3(1.0) * (diff * 1.25 + 0.01);
      gl_FragColor = vec4(col, a * 0.85);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* ---------------- Ilmakehän kajo ---------------- */
function makeAtmoMaterial(a){
  const u = baseUniforms();
  u.uColor = { value: new THREE.Vector3(...a.color) };
  u.uIntensity = { value: a.intensity };
  u.uPower = { value: a.power };
  return registerMat(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: u,
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    uniform vec3 uColor; uniform float uIntensity; uniform float uPower;
    void main(){
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vWP);
      vec3 S = sunDirAt(vWP);
      float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), uPower);
      float day = clamp(dot(N, S) * 0.7 + 0.35, 0.0, 1.0);
      gl_FragColor = vec4(uColor * rim * day * uIntensity, rim * day);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* ---------------- Saturnuksen renkaat ---------------- */
function makeRingMaterial(innerR, outerR, planetR){
  const u = baseUniforms();
  u.uInner = { value: innerR };
  u.uOuter = { value: outerR };
  u.uPlanetR = { value: planetR };
  u.uFade = { value: 0 };   // lähellä (< 80 r) himmenee usvaksi, partikkelit ottavat vallan
  return registerMat(new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: u,
    vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vWP;
    varying float vR;
    varying vec3 vCenter;
    void main(){
      vR = length(position.xy);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWP = wp.xyz;
      vCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`,
    fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying vec3 vWP;
    varying float vR;
    varying vec3 vCenter;
    uniform vec3 uSunPos;
    uniform float uTime;
    uniform float uInner; uniform float uOuter; uniform float uPlanetR;
    uniform float uFade;
    ` + NOISE_GLSL + /* glsl */`
    void main(){
      float t = clamp((vR - uInner) / (uOuter - uInner), 0.0, 1.0);
      float bands = 0.55 + 0.45 * snoise(vec3(t * 42.0, 0.0, 0.0));
      bands *= 0.6 + 0.4 * snoise(vec3(t * 9.0, 3.7, 0.0));
      bands = clamp(bands, 0.0, 1.0);
      float alpha = bands;
      alpha *= smoothstep(0.0, 0.05, t) * smoothstep(1.0, 0.93, t);
      // Cassinin rako
      alpha *= 0.15 + 0.85 * smoothstep(0.015, 0.05, abs(t - 0.56));
      // planeetan varjo renkailla
      vec3 S = normalize(uSunPos - vWP);
      vec3 rp = vWP - vCenter;
      float t0 = dot(-rp, S);
      float shadow = 1.0;
      if (t0 > 0.0) {
        vec3 closest = rp + S * t0;
        shadow = smoothstep(uPlanetR * 0.95, uPlanetR * 1.12, length(closest));
      }
      vec3 base = vec3(0.78, 0.69, 0.54);
      vec3 col = base * (0.45 + 0.65 * bands);
      col *= 0.04 + 0.96 * shadow;
      // lähellä himmennetään pyörivien pikkukivipartikkelien usvaksi
      gl_FragColor = vec4(col, alpha * 0.9 * mix(1.0, 0.4, uFade));
      #include <logdepthbuf_fragment>
    }`,
  }));
}

/* Renkaiden pikkukivipartikkelit (lähikuva, < 80 r): stateless GPU-järjestelmä
   — kiertoradat lasketaan vertex-shaderissa siemenestä (säde/peruskulma) + uTime,
   CPU päivittää vain uniformit, joten ruudunpäivitys ei juuri kärsi. Differentiaali-
   kierto (sisempi nopeampi, ω ∝ r^-1.5) antaa todellisen leikkautuvan liikkeen. */
function makeRingParticles(inner, outer, planetR){
  const N = 70000;
  const pos = new Float32Array(N * 3);   // x=säde, y=paksuusjitter, z=peruskulma
  const bright = new Float32Array(N);
  const size = new Float32Array(N);      // 3 kokoluokkaa (enimmäkseen pieniä)
  const SIZES = [0.6, 1.0, 1.5];
  let i = 0, guard = 0;
  while (i < N && guard < N * 4) {
    guard++;
    const r = Math.sqrt(inner * inner + Math.random() * (outer * outer - inner * inner));   // pinta-alatasainen
    const t = (r - inner) / (outer - inner);
    if (t > 0.53 && t < 0.59) continue;   // Cassinin rako jätetään tyhjäksi
    pos[i * 3] = r;
    pos[i * 3 + 1] = (Math.random() - 0.5) * planetR * 0.012;   // ohut kiekko
    pos[i * 3 + 2] = Math.random() * Math.PI * 2;
    bright[i] = 0.45 + Math.random() * 0.55;
    const s = Math.random();
    size[i] = s < 0.55 ? SIZES[0] : (s < 0.85 ? SIZES[1] : SIZES[2]);
    i++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, i * 3), 3));
  g.setAttribute('aBright', new THREE.BufferAttribute(bright.subarray(0, i), 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size.subarray(0, i), 1));
  const u = baseUniforms();   // uSunPos (origo), uTime
  u.uOmega = { value: 0.09 };
  u.uRefR = { value: inner };
  u.uSize = { value: 150.0 };
  u.uOpacity = { value: 0 };
  u.uPlanetR = { value: planetR };
  u.uColor = { value: new THREE.Color(0.95, 0.85, 0.66) };
  const mat = registerMat(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: u,
    vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute float aBright;
    attribute float aSize;
    uniform float uTime, uOmega, uRefR, uSize, uPlanetR;
    uniform vec3 uSunPos;
    varying float vB;
    varying vec2 vDir;   // kiertotangentti ruutuavaruudessa → motion blur -venytys
    void main(){
      float r = position.x;
      float ang = position.z + uTime * uOmega * pow(uRefR / r, 1.5);   // differentiaalikierto
      vec3 p = vec3(cos(ang) * r, position.y, sin(ang) * r);
      vec4 wp = modelMatrix * vec4(p, 1.0);
      vec3 center = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 S = normalize(uSunPos - wp.xyz);
      vec3 rp = wp.xyz - center;
      float t0 = dot(-rp, S);
      float sh = 1.0;
      if (t0 > 0.0) { vec3 cl = rp + S * t0; sh = smoothstep(uPlanetR * 0.95, uPlanetR * 1.12, length(cl)); }
      vB = aBright * (0.06 + 0.94 * sh);
      vec4 mv = viewMatrix * wp;
      gl_Position = projectionMatrix * mv;
      // liikesuunnan (kiertotangentin) projektio ruudulle motion bluria varten
      vec3 tanW = mat3(modelMatrix) * vec3(-sin(ang), 0.0, cos(ang));
      vec4 clipB = projectionMatrix * (viewMatrix * vec4(wp.xyz + tanW * (r * 0.02), 1.0));
      vDir = normalize((clipB.xy / clipB.w) - (gl_Position.xy / gl_Position.w) + vec2(1e-5));
      gl_PointSize = clamp(uSize * aSize / -mv.z, 1.0, 6.0);
      #include <logdepthbuf_vertex>
    }`,
    fragmentShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vB;
    varying vec2 vDir;
    void main(){
      vec2 d = gl_PointCoord - 0.5;
      float al = dot(d, vDir);                      // liikkeen suunta
      float pe = dot(d, vec2(-vDir.y, vDir.x));     // kohtisuora
      // lievästi venytetty ellipsi (0,5 vs 0,33 puoliakselit) = hitunen motion bluria
      float rr = sqrt(al * al / 0.25 + pe * pe / 0.109);
      float a = smoothstep(1.0, 0.5, rr) * uOpacity;
      if (a < 0.01) discard;
      gl_FragColor = vec4(uColor * vB, a);
      #include <logdepthbuf_fragment>
    }`,
  }));
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;   // kiertopaikat lasketaan shaderissa → bounding sphere ei päde
  pts.visible = false;
  return pts;
}

/* ---------------- Tähtitaivas ---------------- */
function makeStars(){
  const group = new THREE.Group();
  function starField(count, radius, bandiness, size, brightness){
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      let v = new THREE.Vector3().randomDirection();
      if (bandiness > 0) v.y *= (1 - bandiness) + Math.random() * 0.25;
      v.normalize().multiplyScalar(radius * (0.9 + Math.random() * 0.1));
      pos.set([v.x, v.y, v.z], i*3);
      const k = Math.random();
      if (k < 0.10)      c.setRGB(0.65, 0.75, 1.0);   // sininen
      else if (k < 0.22) c.setRGB(1.0, 0.80, 0.60);   // oranssi
      else if (k < 0.30) c.setRGB(1.0, 0.65, 0.55);   // punertava
      else               c.setRGB(1.0, 1.0, 1.0);
      const b = brightness * (0.25 + Math.pow(Math.random(), 2.5) * 0.75);
      col.set([c.r * b, c.g * b, c.b * b], i*3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size, sizeAttenuation:false, vertexColors:true,
      transparent:true, depthWrite:false });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    return pts;
  }
  group.add(starField(14000, 150000, 0, 1.6, 0.60));     // tausta
  const band = starField(9000, 150000, 0.86, 1.4, 0.40); // Linnunrata
  band.rotation.set(0.45, 0.2, 0.9);
  group.add(band);
  group.add(starField(350, 150000, 0, 3.2, 1.4));        // kirkkaat tähdet
  return group;
}
scene.add(makeStars());

/* ---------------- Kappaleiden rakentaminen ---------------- */
const labelsRoot = document.getElementById('labels');
export const bodies = [];
export const orbitLines = new THREE.Group();
scene.add(orbitLines);

for (const def of BODIES) {
  const group = new THREE.Group();
  const tiltGroup = new THREE.Group();
  group.add(tiltGroup);
  if (def.tilt) tiltGroup.rotation.z = def.tilt * DEG;

  let mesh, clouds = null, ringMesh = null, ringParts = null;
  const segs = def.r > 15 ? [128, 96] : [96, 64];

  if (def.type === 'sun') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(def.r, 128, 96), makeSunMaterial());
    // korona-sprite
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    const grad = ctx.createRadialGradient(128,128,0, 128,128,128);
    grad.addColorStop(0.00, 'rgba(255,240,210,1)');
    grad.addColorStop(0.18, 'rgba(255,190,90,0.55)');
    grad.addColorStop(0.45, 'rgba(255,120,30,0.16)');
    grad.addColorStop(1.00, 'rgba(255,80,10,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,256,256);
    const tex = new THREE.CanvasTexture(cv);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, blending: THREE.AdditiveBlending, depthWrite:false, transparent:true }));
    sprite.scale.setScalar(def.r * 7);
    group.add(sprite);
  } else if (def.type === 'earth') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(def.r, ...segs), makeEarthMaterial());
    clouds = new THREE.Mesh(new THREE.SphereGeometry(def.r * 1.015, 96, 64), makeCloudMaterial());
    tiltGroup.add(clouds);
  } else if (def.type === 'gas') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(def.r, ...segs), makeGasMaterial(def.opts));
  } else {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(def.r, ...segs), makeRockyMaterial(def.opts));
  }
  tiltGroup.add(mesh);

  if (def.atmo) {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(def.r * 1.055, 96, 64), makeAtmoMaterial(def.atmo));
    tiltGroup.add(shell);
  }
  if (def.rings) {
    const inner = def.r * def.rings.inner;
    const outer = def.r * def.rings.outer;
    ringMesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 256, 8),
      makeRingMaterial(inner, outer, def.r));
    ringMesh.rotation.x = -Math.PI / 2;
    tiltGroup.add(ringMesh);
    ringParts = makeRingParticles(inner, outer, def.r);   // lähikuvan pikkukivet
    tiltGroup.add(ringParts);
  }

  // kiertoradan viiva
  if (def.a > 0) {
    const pts = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * def.a * AU, 0, Math.sin(a) * def.a * AU));
    }
    const og = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(og, new THREE.LineBasicMaterial({
      color: 0x3a6f9f, transparent: true, opacity: 0.30 }));
    if (def.incl) line.rotation.x = def.incl * DEG;
    orbitLines.add(line);
  }

  // nimilappu
  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = `<span class="dot">◦</span> ${def.name}`;
  labelsRoot.appendChild(label);

  scene.add(group);
  bodies.push({
    def, group, mesh, clouds, ringMesh, ringParts, label,
    angVel: def.a > 0 ? (2 * Math.PI) / (ORBIT_BASE_PERIOD * Math.pow(def.a, 1.5)) : 0,
    spinVel: def.spinP ? (2 * Math.PI) / def.spinP : 0.02,
  });
}

/* ---------------- Planeettakartat: Solar System Scope (CC-BY 4.0) ----------------
   Pohjakartat ovat 2K-versioita TÄYSIN samoista kartoista kuin hi-resit (Wikimedia,
   CORS-sallittu). Koska base ja hi-res ovat sama kuva eri tarkkuudella, ristihäivytys
   2K→8K on pelkkää saman kuvan terävöitymistä — ei väri-/piirremuutosta. */
const WM = 'https://upload.wikimedia.org/wikipedia/commons/';
const PLANET_TEXTURES = {
  Merkurius: WM + '9/92/Solarsystemscope_texture_2k_mercury.jpg',
  Venus:     WM + '4/40/Solarsystemscope_texture_2k_venus_surface.jpg',
  Mars:      WM + '4/46/Solarsystemscope_texture_2k_mars.jpg',
  Jupiter:   WM + 'b/be/Solarsystemscope_texture_2k_jupiter.jpg',
  Saturnus:  WM + 'e/ea/Solarsystemscope_texture_2k_saturn.jpg',
  Uranus:    WM + '9/95/Solarsystemscope_texture_2k_uranus.jpg',
  Neptunus:  WM + '1/1e/Solarsystemscope_texture_2k_neptune.jpg',
};
const EARTH_DAY   = WM + 'c/c3/Solarsystemscope_texture_2k_earth_daymap.jpg';
const EARTH_NIGHT = WM + '2/2f/Solarsystemscope_texture_2k_earth_nightmap.jpg';

/* Hi-res (8K kiviplaneetat + Maa, 4K Jupiter/Saturnus). Ladataan vain lähestyttävälle
   planeetalle (`updatePlanetLOD`), yksi kerrallaan VRAMin säästämiseksi, ja vapautetaan
   kun etääntyy. Uranus/Neptunus jäävät 2K:hon — ei 8K:ta saatavilla eikä tarvetta
   (sileitä kaasukehiä). 2K-pohja jää aina varalle. */
const HIRES = {
  Merkurius: WM + '2/27/Solarsystemscope_texture_8k_mercury.jpg',
  Venus:     WM + '1/1c/Solarsystemscope_texture_8k_venus_surface.jpg',
  Maa:       WM + '0/04/Solarsystemscope_texture_8k_earth_daymap.jpg',
  Mars:      WM + '7/70/Solarsystemscope_texture_8k_mars.jpg',
  Jupiter:   WM + '5/5e/Solarsystemscope_texture_8k_jupiter.jpg',
  Saturnus:  WM + '1/1e/Solarsystemscope_texture_8k_saturn.jpg',
};

const texLoader = new THREE.TextureLoader();
function loadTex(url){
  return new Promise((resolve, reject) => {
    texLoader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      resolve(t);
    }, undefined, reject);
  });
}

function makeTexturedMaterial(map, radius){
  const u = baseUniforms();
  u.uMap = { value: map };          // pohjakartta (1–2K)
  u.uMap2 = { value: map };         // hi-res (sama kunnes LOD lataa)
  u.uBlend = { value: 0 };          // 0 = pohja, 1 = hi-res — ristihäivytys
  u.uRadius = { value: radius || 1.0 };
  return registerMat(new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    uniform sampler2D uMap;
    uniform sampler2D uMap2;
    uniform float uBlend;
    uniform float uRadius;
    varying vec2 vUv;
    void main(){
      vec3 col = mix(texture2D(uMap, vUv).rgb, texture2D(uMap2, vUv).rgb, uBlend);
      // proseduraalinen lähidetalji peittää matalan kartan pikselöitymisen
      // lähietäisyydellä; häivytetään sisään kameran pintaetäisyydestä, ja
      // vOP (pinnan suunta objektiavaruudessa) pitää detaljin kiinni pinnassa
      // vain aivan lähellä (8K riittää kauempaa) ja kevyt — 3 näytettä
      float nd = 1.0 - smoothstep(uRadius * 0.15, uRadius * 1.4, length(cameraPosition - vWP));
      if (nd > 0.002) {
        float det = snoise(vOP * 170.0) * 0.5 + snoise(vOP * 520.0) * 0.32 + snoise(vOP * 1400.0) * 0.18;
        col *= 1.0 + det * 0.16 * nd;
      }
      vec3 N = normalize(vN);
      vec3 S = sunDirAt(vWP);
      float diff = pow(clamp(dot(N, S), 0.0, 1.0), 1.05);
      vec3 lit = col * (diff * 1.12 + 0.015);
      gl_FragColor = vec4(lit, 1.0);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

function makeTexturedEarthMaterial(day, night, radius){
  const u = baseUniforms();
  u.uMap = { value: day };
  u.uMap2 = { value: day };
  u.uBlend = { value: 0 };
  u.uNight = { value: night };
  u.uRadius = { value: radius || 1.0 };
  return registerMat(new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: PLANET_VERT,
    fragmentShader: FRAG_HEAD + /* glsl */`
    uniform sampler2D uMap;
    uniform sampler2D uMap2;
    uniform float uBlend;
    uniform sampler2D uNight;
    uniform float uRadius;
    varying vec2 vUv;
    void main(){
      vec3 day = mix(texture2D(uMap, vUv).rgb, texture2D(uMap2, vUv).rgb, uBlend);
      // lähidetalji (kevyempi kuin kiviplaneetoilla, ettei meri kohise)
      float nd = 1.0 - smoothstep(uRadius * 0.15, uRadius * 1.4, length(cameraPosition - vWP));
      if (nd > 0.002) {
        float det = snoise(vOP * 170.0) * 0.5 + snoise(vOP * 520.0) * 0.32 + snoise(vOP * 1400.0) * 0.18;
        day *= 1.0 + det * 0.11 * nd;
      }
      vec3 night = texture2D(uNight, vUv).rgb;
      vec3 N = normalize(vN);
      vec3 S = sunDirAt(vWP);
      vec3 V = normalize(cameraPosition - vWP);
      float ndl = dot(N, S);
      float diff = pow(clamp(ndl, 0.0, 1.0), 1.1);
      // kaupunkien valot yöpuolella
      float nightSide = smoothstep(0.05, -0.18, ndl);
      vec3 lights = night * vec3(1.0, 0.88, 0.65) * nightSide * 1.1;
      // sininen reunakajo päiväpuolella
      float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.5);
      vec3 atmo = vec3(0.25, 0.45, 0.95) * rim * clamp(ndl * 0.8 + 0.2, 0.0, 1.0) * 0.5;
      vec3 lit = day * (diff * 1.15 + 0.01) + lights + atmo;
      gl_FragColor = vec4(lit, 1.0);
      #include <logdepthbuf_fragment>
    }`,
  }));
}

// lataa kartat taustalla; epäonnistuessa proseduraalinen pinta jää varalle
for (const b of bodies) {
  if (b.def.type === 'earth') {
    Promise.all([
      loadTex(EARTH_DAY),
      loadTex(EARTH_NIGHT),
    ]).then(([d, n]) => {
      const old = b.mesh.material;
      b.mesh.material = makeTexturedEarthMaterial(d, n, b.def.r);
      b.baseMap = d;
      old.dispose();
    }).catch(() => {});
  } else if (PLANET_TEXTURES[b.def.name]) {
    loadTex(PLANET_TEXTURES[b.def.name]).then((t) => {
      const old = b.mesh.material;
      b.mesh.material = makeTexturedMaterial(t, b.def.r);
      b.baseMap = t;
      old.dispose();
    }).catch(() => {});
  }
}

export function bodyPosition(b, t, out){
  if (b.def.a === 0) return out.set(0, 0, 0);
  const ang = b.def.phase + b.angVel * t;
  const d = b.def.a * AU;
  out.set(Math.cos(ang) * d, 0, Math.sin(ang) * d);
  if (b.def.incl) out.applyAxisAngle(new THREE.Vector3(1,0,0), b.def.incl * DEG);
  return out;
}

// aloituspaikka: kappaleen lähellä, katse kohti kappaletta
export function placeNearBody(idx, distMult = 3.5){
  const b = bodies[idx];
  const bp = bodyPosition(b, S.simTime, new THREE.Vector3());
  // kamera kappaleen aurinkopuolelle, jotta valaistu puoli näkyy
  const sunward = bp.lengthSq() > 1 ? bp.clone().normalize().negate() : new THREE.Vector3(1, 0, 0);
  const off = sunward.multiplyScalar(b.def.r * distMult)
    .add(new THREE.Vector3(0, b.def.r * 0.7, 0));
  camera.position.copy(bp).add(off);
  camera.lookAt(bp);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  S.yaw = e.y; S.pitch = e.x; S.roll = 0;
}

// kappaleiden paikat ja pyöriminen (kaikissa moodeissa)
/* ---- planeettatekstuurin LOD: korkearesoluutiokartta vain lähestyttävälle
   kappaleelle, yksi kerrallaan. Lataus alkaa jo kaukaa (lead time), ja kartat
   ristihäivytetään (uBlend 0→1) jotta vaihto on huomaamaton. ---- */
const LOD_LOAD = 80, LOD_KEEP = 120, LOD_FADE = 3.0;   // vaihto 8K:ksi < 80 r, pidä < 120 r, häivytys ~0,3 s τ
let activeLOD = null;   // { b, tex, target }  target 1 = hi näkyviin, 0 = takaisin pohjaan
let lodLoading = null;  // kappale jolla lataus kesken
function surfDist(b){ return camera.position.distanceTo(b.group.position) - b.def.r; }
function lodDrop(b){
  const u = b.mesh.material.uniforms;
  if (u.uMap2) u.uMap2.value = b.baseMap;
  if (u.uBlend) u.uBlend.value = 0;
}
function updatePlanetLOD(dt){
  // lähin kappale, jolla on hi-res ja pohjakartta jo ladattu
  let cand = null, candD = Infinity;
  for (const b of bodies) {
    if (!b.baseMap || !HIRES[b.def.name]) continue;
    const d = surfDist(b);
    if (d < candD) { candD = d; cand = b; }
  }
  // aloita lataus kun lähestyttävä tulee alueelle (yksi kerrallaan)
  if (cand && candD < cand.def.r * LOD_LOAD && lodLoading !== cand &&
      (!activeLOD || activeLOD.b !== cand)) {
    const want = cand;
    lodLoading = want;
    loadTex(HIRES[want.def.name]).then((t) => {
      if (lodLoading === want) lodLoading = null;
      if (!want.baseMap || surfDist(want) > want.def.r * LOD_KEEP) { t.dispose(); return; }
      t.anisotropy = 4;   // 8K + 16× anisotropia koko ruudulla maksaa fps:ää
      if (activeLOD) { lodDrop(activeLOD.b); activeLOD.tex.dispose(); }   // jäännös (harvinainen)
      const u = want.mesh.material.uniforms;
      if (u.uMap2) u.uMap2.value = t;
      if (u.uBlend) u.uBlend.value = 0;
      activeLOD = { b: want, tex: t, target: 1 };   // häivytetään sisään
    }).catch(() => { if (lodLoading === want) lodLoading = null; });
  } else if (activeLOD && activeLOD.b === cand && candD < cand.def.r * LOD_KEEP) {
    activeLOD.target = 1;   // palasi alueelle → häivytä takaisin
  }
  // häivytys ja vapautus
  if (activeLOD) {
    if (activeLOD.target === 1 && surfDist(activeLOD.b) > activeLOD.b.def.r * LOD_KEEP) activeLOD.target = 0;
    const u = activeLOD.b.mesh.material.uniforms;
    if (u.uBlend) {
      u.uBlend.value += (activeLOD.target - u.uBlend.value) * Math.min(1, dt * LOD_FADE);
      if (activeLOD.target === 0 && u.uBlend.value < 0.02) {   // häivytys loppuun → vapauta
        lodDrop(activeLOD.b);
        activeLOD.tex.dispose();
        activeLOD = null;
      }
    }
  }
}

/* Renkaiden pikkukivipartikkelit häivytetään sisään < 80 r ja ulos > 80 r;
   flat-rengas himmenee samalla usvaksi (uFade). Pelkkä uniformien lerppaus. */
function updateRingParticles(dt){
  for (const b of bodies) {
    if (!b.ringParts) continue;
    const d = camera.position.distanceTo(b.group.position) - b.def.r;
    const target = d < b.def.r * 80 ? 1 : 0;
    const pu = b.ringParts.material.uniforms, ru = b.ringMesh.material.uniforms;
    pu.uOpacity.value += (target - pu.uOpacity.value) * Math.min(1, dt * 2.0);
    ru.uFade.value = pu.uOpacity.value;
    b.ringParts.visible = pu.uOpacity.value > 0.01;
  }
}

export function updateBodies(dt){
  for (const b of bodies) {
    bodyPosition(b, S.simTime, b.group.position);
    b.mesh.rotation.y += b.spinVel * dt;
    if (b.clouds) b.clouds.rotation.y += b.spinVel * 1.25 * dt;
  }
  updatePlanetLOD(dt);
  updateRingParticles(dt);
}
