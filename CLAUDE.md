# Aurinkokuntasimulaattori

Selainpohjainen 3D-avaruussimulaattori: FPV-lento aurinkokunnassa, laskeutuminen kiviplaneetoille, komentosiltanäkymä. Kaikki koodi on yhdessä tiedostossa: [index.html](index.html) (HTML + CSS + ES-moduuli-JS + GLSL-shaderit template-literaaleina).

## Käynnistys ja testaus

- Palvelin: `python3 -m http.server 8741` → http://localhost:8741 (määritelty myös `.claude/launch.json`:ssa nimellä `avaruus`, preview-työkalut käyttävät sitä)
- Three.js r160 ladataan jsdelivr-CDN:ltä importmapilla — **nettiyhteys vaaditaan**, ei build-vaihetta eikä riippuvuuksien asennusta
- Planeettatekstuurit: three.js-repo (Maa) ja threex.planets-repo (muut) jsdelivrin kautta; jos lataus epäonnistuu, proseduraaliset shaderit jäävät varalle
- Debug-koukku selaimessa: `window.__sim` — `goto(idx, dist)`, `setSpeed(f)`, `beam(idx)` (laskeudu), `beamUp()`, `surf()` (pintascene + korkeusfunktio), `state()`, sekä suorat viittaukset `camera, bodies, renderPass, renderer, scene`
- Aloitusruudussa on käynnistysdiagnostiikka: moduuli-/WebGL-virheet näytetään punaisella `#bootStatus`-rivillä

## Mittakaava ja fysiikka

- 1 AU = 1000 yksikköä; valonnopeus C ≈ 101,2 yks/s — kalibroitu niin, että Maa→Neptunus 0,99c:llä kestää ~5 min (ETA ~4:49)
- Kiertoajat: Kepler-skaalattu, Maan periodi 360 s (`ORBIT_BASE_PERIOD`)
- Nopeussäätö 0–0,99c; **kehysseuranta**: alle 15 planeetansäteen etäisyydellä kamera kulkee planeetan radan mukana (täysi paino < 8 r), ja nopeusalue rajautuu 0,01–0,1c ("lähialuetila"). HUD näyttää `⊕ kehysseuranta: <planeetta> NN %`
- Törmäyssuoja työntää kameran ulos pinnasta (r×1,15) vauhtia nollaamatta (liukuu pintaa pitkin)
- Kiertoradalle teleporttaus (T) vain kantamalla: max(0,5 AU, 30 r) — merkkivalo kohdepaneelissa

## Tilat (mode-muuttuja: 'space' | 'surface')

- **space**: FPV-lento, komentosilta-overlay (SVG, V kytkee), warp-efekti
- **surface**: kiviplaneetat (Merkurius, Venus, Maa, Mars; `ROCKY`-setti). Erillinen proseduraalinen maailma per planeetta (`SURFACE_CONFIGS`): fbm-maasto + todistetut piirteet (Mars: kanjoni/tulivuori/kraatterit/dyynit; Merkurius: kraatterit/jyrkänne; Venus: tulivuoret/repeämä; Maa: vuoret/puut), detaljitekstuuri + bump, kävelyheilunta (bobPhase/bobAmp). Komentosilta ja avaruus-HUD piilossa (`body.surface` CSS)
- Siirtymät: `enterSurface()` / `exitSurface()` — **TÄRKEÄÄ**: kamera on lisättävä renderöitävään sceneen (`surfaceScene.add(camera)` / `scene.add(camera)`), muuten Three.js ei päivitä kameran maailmamatriisia (kamera on avaruusscenen lapsi warp-efektin takia) ja näkymä jäätyy

## Näppäimet

Hiiri = katselu (pointer lock TAI vetämällä — lukko ei toimi kaikissa ympäristöissä, varajärjestelmä on). W/S/rulla = nopeus, Q/E = roll, X/M = pysäytä/täysi, 0–8 = kohde, F (pidä) = käänny kohteeseen, T = kiertoradalle, G = laskeudu, B = takaisin alukselle, V = komentosilta, O = kiertoradat, P = tauko, H = ohje. Pinnalla WASD + Shift.

## Renderöinti

- EffectComposer: RenderPass (`renderPass`-muuttuja — scenen vaihto tapahtuu tähän) + UnrealBloom (threshold 1.0) + OutputPass; ACES-tonemapping; **logaritminen syvyyspuskuri** — kaikissa custom-shadereissa oltava `logdepthbuf`-chunkit (katso `PLANET_VERT`/`FRAG_HEAD`)
- Planeetat: NASA-tekstuurikartat + custom-valaistusshader (aurinko origossa); Aurinko proseduraalinen (animoitu granulaatio); Saturnuksen renkaat proseduraaliset (Cassinin rako, planeetan varjo); ilmakehäkajot fresnel-kuorina; Maalla pilvikerros + yövalot + merikiilto
- Warp-efekti (`warpGroup`, kameran lapsi): 2001-stargate-henkinen slit-scan-käytävä — 2 tunnelikuorta, joissa kirkkaus painottuu ylä- ja alavalotasoihin (`vUp`-varying ruutukoordinaateissa), pitkät z-suuntaan venyneet valoraidat ja hitaasti vaeltava cos-spektripaletti (simplex-kohina, jaksolliset cos/sin-koordinaatit — EI uv.x:ää suoraan, tulee sauma) + spektrinväriset tähtijuovat. Voimakkuus skaalautuu kiihtyvyyden mukaan (`updateWarp`), häipyy ~3 s tasaisessa vauhdissa, vain kehysseurannan ulkopuolella ja >10 % c

## Tunnetut sudenkuopat

- Kirkkauden säätö: planeettojen diffuusikertoimet ~1,0–1,1 — isommat arvot puhkipalavat bloomissa
- Esikatselutyökalun klikkaukset lähettävät rullatapahtumia → nopeus voi muuttua testeissä itsestään; testaa nopeusasiat `__sim.setSpeed()`-koukulla
- Pintamoodin spawn on origossa — kraatterit yms. generoidaan vähintään ~200 yksikön päähän siitä
- `GLSL` on JS-template-literaaleissa: varo `</script>`-sekvenssejä ja backtickejä
