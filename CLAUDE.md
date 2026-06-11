# Aurinkokuntasimulaattori

Selainpohjainen 3D-avaruussimulaattori: FPV-lento aurinkokunnassa, laskeutuminen kiviplaneetoille, komentosiltanäkymä. [index.html](index.html) sisältää HTML:n, CSS:n ja käynnistysdiagnostiikan; pelikoodi on natiiveina ES-moduuleina `js/`-hakemistossa (ei build-vaihetta, GLSL-shaderit template-literaaleina):

- [js/state.js](js/state.js) — jaettu muuttuva tila `S`-objektissa (mode, nopeudet, yaw/pitch/roll, keys…) + `clamp01`. Ei importtaa mitään — moduulien yhteinen tila kulkee tämän kautta, ei sirkulaarisia importteja
- [js/core.js](js/core.js) — mittakaavavakiot (AU, C, DEG…), renderer/scene/camera/composer/renderPass, resize
- [js/shaders.js](js/shaders.js) — yhteiset GLSL-palat (NOISE_GLSL, PLANET_VERT, FRAG_HEAD), `registerMat`/`shaderMats` (uTime-päivitys), `baseUniforms`
- [js/bodies.js](js/bodies.js) — BODIES-data, planeettamateriaalit, tähtitaivas, kappaleiden rakentaminen, NASA-tekstuurien lataus, `bodyPosition`, `placeNearBody`, `updateBodies`
- [js/warp.js](js/warp.js) — warp-efekti: `updateWarp`, `resetWarp`
- [js/reentry.js](js/reentry.js) — ilmakehään syöksyminen: kitkajarrutus, plasmakuori, runkolämpö, tuhoutuminen; `updateReentry`, `LANDING_MAX_EFF`
- [js/surface.js](js/surface.js) — pintamoodi: SURFACE_CONFIGS, maastogeneraattori, `enterSurface`/`exitSurface`/`updateSurface`, `teleportToOrbit`, `tryBeamDown`, `orbitRange`, ROCKY
- [js/flight.js](js/flight.js) — avaruuslennon fysiikka: `updateFlight` (nopeus, F-kääntö, kehysseuranta, törmäyssuoja)
- [js/input.js](js/input.js) — hiiri/näppäimet/UI-napit, `setTarget`
- [js/hud.js](js/hud.js) — HUD, nimilaput, FOV-skaalaus: `updateSpaceHUD`
- [js/main.js](js/main.js) — pääsilmukka, `__sim`-testikoukku, käynnistys

## Käynnistys ja testaus

- Palvelin: `python3 -m http.server 8741` → http://localhost:8741 (määritelty myös `.claude/launch.json`:ssa nimellä `avaruus`, preview-työkalut käyttävät sitä)
- Three.js r160 ladataan jsdelivr-CDN:ltä importmapilla — **nettiyhteys vaaditaan**, ei build-vaihetta eikä riippuvuuksien asennusta
- Planeettatekstuurit: three.js-repo (Maa) ja threex.planets-repo (muut) jsdelivrin kautta; jos lataus epäonnistuu, proseduraaliset shaderit jäävät varalle
- Debug-koukku selaimessa: `window.__sim` — `goto(idx, dist)`, `setSpeed(f)`, `beam(idx)` (laskeudu), `beamUp()`, `surf()` (pintascene + korkeusfunktio), `state()`, sekä suorat viittaukset `camera, bodies, renderPass, renderer, scene`
- Aloitusruudussa on käynnistysdiagnostiikka: moduuli-/WebGL-virheet näytetään punaisella `#bootStatus`-rivillä

## Mittakaava ja fysiikka

- 1 AU = 1000 yksikköä; valonnopeus C ≈ 101,2 yks/s — kalibroitu niin, että Maa→Neptunus 0,99c:llä kestää ~5 min (ETA ~4:49)
- Kiertoajat: Kepler-skaalattu, Maan periodi 360 s (`ORBIT_BASE_PERIOD`)
- Vuorokaudet: todelliset pyörähdysajat skaalattu 1 h = 10 s → Maan vuorokausi 240 s. Avaruudessa `spinP` (sekunteina, negatiivinen = retrogradinen, Venus); pinnalla aurinko kulkee kaarirataa aurinkovuorokauden jaksolla (`dayLength`; Mars ~247 s, Merkurius/Venus kymmeniä tunteja eli käytännössä paikallaan), valaistus/taivas/rusko/yötähdet ajetaan `updateDaylight`issa. Laskeutuminen alkaa aina aamupäivästä; testaus: `__sim.surf().setDayPhase(p)` (0 = nousu, π/2 = keskipäivä, π = lasku, 3π/2 = keskiyö)
- Nopeussäätö 0–0,99c; **kehysseuranta**: alle 15 planeetansäteen etäisyydellä kamera kulkee planeetan radan mukana (täysi paino < 8 r), ja nopeusalue rajautuu 0,01–0,1c ("lähialuetila"). HUD näyttää `⊕ kehysseuranta: <planeetta> NN %`
- Törmäyssuoja työntää kameran ulos pinnasta (r×1,15) vauhtia nollaamatta (liukuu pintaa pitkin)
- Ilmakehään syöksyminen (kappaleet joilla `atmo`; ei Merkurius): vyöhyke r×1,15–r×3,0, tiheys ∝ syvyys³. Ilmanvastus jarruttaa, kitkalämpö q = tiheys × (effFrac/0,1)² sytyttää plasmakuoren (kameran lapsi, `depthTest:false` — muuten planeetta peittää sen!) ja ravistelee kameraa. Runkolämpö kertyy pääosin **jarrutusenergiasta** (∝ v·dv, `BRAKE_HEAT`) — pelkkä hetkellinen q ei riitä, koska jarrutus romahduttaa sen ennen täyttymistä; jäähtyminen kunnolla vain ohuessa ilmassa (tiheässä vain hidas `SOAK_COOL`). 100 % → alus tuhoutuu (`#deathOverlay`, klikkaus palauttaa Maan luo). Entry yli ~5 % c kuolettaa, alle selviää rajusti jarruttaen (lämpö jää hehkumaan), ≤1,5 % c liitää vapaasti. **Törmäystuho** (kaikki kappaleet, myös ilmakehättömät): pintakosketus (r×1,16) yli 1,5 % c:llä (`IMPACT_MAX`) tuhoaa aluksen; kaasujättiläisillä syynä paine, Auringon lähellä (r×1,2) höyrystyminen nopeudesta riippumatta. Laskeutuminen (G) vaatii ≤2 % c (`LANDING_MAX_EFF`). Debug: `__sim.reentry()`
- Kiertoradalle teleporttaus (T) vain kantamalla: max(0,5 AU, 30 r) — merkkivalo kohdepaneelissa

## Tilat (mode-muuttuja: 'space' | 'surface')

- **space**: FPV-lento, komentosilta-overlay (SVG, V kytkee), warp-efekti
- **surface**: kiviplaneetat (Merkurius, Venus, Maa, Mars; `ROCKY`-setti). Erillinen proseduraalinen maailma per planeetta (`SURFACE_CONFIGS`): fbm-maasto + todistetut piirteet (Mars: kanjoni/tulivuori/kraatterit/dyynit; Merkurius: kraatterit/jyrkänne; Venus: tulivuoret/repeämä; Maa: vuoret/puut), detaljitekstuuri + bump, kävelyheilunta (bobPhase/bobAmp). Komentosilta ja avaruus-HUD piilossa (`body.surface` CSS)
- Siirtymät: `enterSurface()` / `exitSurface()` — **TÄRKEÄÄ**: kamera on lisättävä renderöitävään sceneen (`surfaceScene.add(camera)` / `scene.add(camera)`), muuten Three.js ei päivitä kameran maailmamatriisia (kamera on avaruusscenen lapsi warp-efektin takia) ja näkymä jäätyy

## Näppäimet

Hiiri = katselu (pointer lock TAI vetämällä — lukko ei toimi kaikissa ympäristöissä, varajärjestelmä on). W/S/rulla = nopeus, Q/E = roll, X/M = pysäytä/täysi, 0–8 = kohde, F (pidä) = käänny kohteeseen, T = kiertoradalle, G = laskeudu, B = takaisin alukselle, V = komentosilta, O = kiertoradat, P = tauko, H = ohje. Pinnalla WASD + Shift.

## Renderöinti

- EffectComposer: RenderPass (`renderPass`-muuttuja — scenen vaihto tapahtuu tähän) + UnrealBloom (threshold 1.0) + OutputPass; ACES-tonemapping; **logaritminen syvyyspuskuri** — kaikissa custom-shadereissa oltava `logdepthbuf`-chunkit (katso `PLANET_VERT`/`FRAG_HEAD`)
- Planeetat: NASA-tekstuurikartat + custom-valaistusshader (aurinko origossa); Aurinko proseduraalinen (animoitu granulaatio); Saturnuksen renkaat proseduraaliset (Cassinin rako, planeetan varjo); ilmakehäkajot fresnel-kuorina; Maalla pilvikerros + yövalot (ei spekulaaria merikiiltoa — poistettu häiritsevänä)
- Warp-efekti (`warpGroup`, kameran lapsi): 2001-stargate-henkinen slit-scan-käytävä — 2 tunnelikuorta, joissa kirkkaus painottuu ylä- ja alavalotasoihin (`vUp`-varying ruutukoordinaateissa), pitkät z-suuntaan venyneet valoraidat ja hitaasti vaeltava cos-spektripaletti (simplex-kohina, jaksolliset cos/sin-koordinaatit — EI uv.x:ää suoraan, tulee sauma) + spektrinväriset tähtijuovat. Voimakkuus skaalautuu kiihtyvyyden mukaan (`updateWarp`), häipyy ~3 s tasaisessa vauhdissa, vain kehysseurannan ulkopuolella ja >10 % c

## Tunnetut sudenkuopat

- Kirkkauden säätö: planeettojen diffuusikertoimet ~1,0–1,1 — isommat arvot puhkipalavat bloomissa
- Esikatselutyökalun klikkaukset lähettävät rullatapahtumia → nopeus voi muuttua testeissä itsestään; testaa nopeusasiat `__sim.setSpeed()`-koukulla
- Pintamoodin spawn on origossa — kraatterit yms. generoidaan vähintään ~200 yksikön päähän siitä
- `GLSL` on JS-template-literaaleissa: varo backtickejä ja `${`-sekvenssejä shaderikoodissa
- Jaettua tilaa (nopeudet, mode, kulmat…) EI saa kopioida paikallisiin muuttujiin moduulin latauksen yhteydessä — lue ja kirjoita aina `S.kenttä` suoraan, muuten tila eriytyy
