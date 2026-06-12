# Aurinkokuntasimulaattori

Selainpohjainen 3D-avaruussimulaattori: FPV-lento aurinkokunnassa, laskeutuminen kiviplaneetoille, komentosiltanäkymä. [index.html](index.html) sisältää HTML:n, CSS:n ja käynnistysdiagnostiikan; pelikoodi on natiiveina ES-moduuleina `js/`-hakemistossa (ei build-vaihetta, GLSL-shaderit template-literaaleina):

- [js/state.js](js/state.js) — jaettu muuttuva tila `S`-objektissa (mode, nopeudet, yaw/pitch/roll, keys…) + `clamp01`. Ei importtaa mitään — moduulien yhteinen tila kulkee tämän kautta, ei sirkulaarisia importteja
- [js/core.js](js/core.js) — mittakaavavakiot (AU, C, DEG…), renderer/scene/camera/composer/renderPass, resize
- [js/shaders.js](js/shaders.js) — yhteiset GLSL-palat (NOISE_GLSL, PLANET_VERT, FRAG_HEAD), `registerMat`/`shaderMats` (uTime-päivitys), `baseUniforms`
- [js/bodies.js](js/bodies.js) — BODIES-data, planeettamateriaalit, tähtitaivas, kappaleiden rakentaminen, NASA-tekstuurien lataus, `bodyPosition`, `placeNearBody`, `updateBodies`
- [js/sky.js](js/sky.js) — parametrisoitu fysikaalinen taivas (Preetham-malli, `makeSky`): uBetaR/uMieTint-uniformeilla sama shader tuottaa Maan sinisen ja Marsin voinkeltaisen taivaan ruskoineen
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
- Pikasiirtymä (R / kohdepaneelin nappi): hyppää valitun kohteen kiertoradalle mistä tahansa, nollaa nopeuden (`quickTravel`)

## Tilat (mode-muuttuja: 'space' | 'surface' | 'descent')

- **space**: FPV-lento, komentosilta-overlay (SVG, aina päällä avaruudessa), warp-efekti
- **descent** (matalalento): kun alus laskeutuu avaruudessa kiviplaneetan pintarajan (r×1,18) alle alle törmäysnopeuden, fade-to-black vie planeetan pintamaailmaan ~650 m korkeuteen laskeutumisalukseen (oma ohjaamo-overlay `#lander`, `body.descent` CSS; hiiri ohjaa, W/S = vauhti 35–450 m/s). Turbulenssi ja tuuli pyörittävät alusta pituusakselin ympäri (`descRoll`, sinisummakohina + puuskat) ja työntävät sivusuunnassa — A/D (tai Q/E) vastaohjaa. Keinohorisontti (`#attWrap` SVG: horisontti kääntyy −rollin ja siirtyy pitchin mukaan) + lukemat (korkeus/vauhti/kallistus, vihreä kun rajoissa). Onnistunut lasku vaatii ≤55 m/s JA kallistuksen ≤2° (`MAX_ROLL_DEG`) — muuten tuho ("laskuteline petti"). Pehmeä lasku → fade-to-black → kävelymoodi. Nousu yli 900 m tai B → takaisin avaruuteen (r×1,5, ilman fadea). Siirtymät: `fadeSwap(fn)` (#fadeBlack; `transitioning`-lippu jäädyttää updateDescentin ja estää tuplatriggerit). Debug: `surf().roll()/setRoll(r)`
- **surface**: kiviplaneetat (Merkurius, Venus, Maa, Mars; `ROCKY`-setti). Erillinen proseduraalinen maailma per planeetta (`SURFACE_CONFIGS`): fbm-maasto + todistetut piirteet (Mars: kanjoni/tulivuori/kraatterit/dyynit; Merkurius: kraatterit/jyrkänne; Venus: tulivuoret/repeämä; Maa: vuoret/puut), detaljitekstuuri + bump, kävelyheilunta (bobPhase/bobAmp). Komentosilta ja avaruus-HUD piilossa (`body.surface` CSS)
- **Ääretön maasto**: korkeusfunktio on globaali; mesh generoidaan 600 yks laattoina 5×5-gridiin kameran ympärille (`updateTerrain`, kate 3000×3000, ~115k kolmiota) ja vapautuneet laatat kierrätetään — enintään yksi laatanrakennus per ruutu. Normaalit lasketaan korkeusnäyttein naapureineen (EI `computeVertexNormals` — laattasaumat näkyisivät). Kivet/pikkukivet/puut ovat kameraa seuraavaa jaksollista sirotetta (`addScatter`/`updateScatter`, solu 2200/480 yks). Paikkasidonnaiset piirteet (kraatterit, tulivuoret) toistuvat 4200 yks jaksolla (`wrapF`) — piirteet mahtuvat jakson sisään, ei saumaa
- **Pintadetaljit ja varjot**: planeettakohtainen värillinen detaljitekstuuri (`getDetailTexture`, lineaariavaruudessa keskikirkkaus ~1 — moduloi vertex-värejä, toimii myös bump-karttana) ja shadow map (PCFSoft 2048, päällä `core.js`:ssä): aurinkovalon varjokamera (±300 yks) seuraa pelaajaa `updateDaylight`issa, maasto/kivet/puut/rakennukset heittävät varjot. Venuksella ei varjoja (usva). FPS-tavoite >50 — pidä laattamäärä ja varjokartan koko kurissa
- **Fysikaalinen taivas + IBL** (Maa ja Mars, `cfg.scatter`): taivaskupu `sky.js`:stä (renderOrder −100, depthWrite false — tähdet ja maasto piirtyvät päälle), aurinko hehkuineen syntyy shaderissa (ei erillistä kiekkomeshia). PMREM-ympäristökartta generoidaan taivaasta ~1,2 s välein auringon liikkuessa ja syötetään VAIN propseille (talot/kivet/puut, `envMats`) — **EI koko ruudun maastoon: env-näytteistys maastossa maksoi ~20 fps**. Env-versio taivaasta ilman aurinkokiekkoa (`uSunGlow 0` — HDR-kiekko räjäyttäisi ambientin). Viritys: gain ~0,3 (ACES exposure 1,1:llä), Maa rayleigh 2,0 / Mars käänteinen betaR (punainen siroaa → sininen rusko)
- SSAO kokeiltu (N8AO CDN:ltä): epävakaa — tuotti ajoittain pelkän taustavärin (log-syvyyspuskuri?). Poistettu; AO harkitaan uudelleen three-päivityksen (GTAOPass) myötä
- **Maan tiet ja kaupungit**: tieverkko ROAD_SP=900 yks ruudukossa (`roadDist`), osa risteyksistä kaupunkeja (`townAt`). Maasto tasoittuu teiden/kaupunkien kohdalla (surfHeightFn), laatat värjäävät pientareet tummiksi ja varsinainen tie on laattaan kytketty kaistamesh (`getRoadStrip`/`fillRoadStrip`, asfalttitekstuuri keskikatkoviivalla; x-suunnan kaista hieman z-suunnan yläpuolella risteyksissä). Rakennukset ovat instansoitua sirotetta julkisivutekstuurilla (`getBuildingTextures`) — ikkunat syttyvät yöllä (`bldgMat.emissiveIntensity` updateDaylightissa). Puut väistävät teitä ja kaupunkeja (`inTownArea`). Maassa ei kivisirotetta (`features.rocks: false`); pilvet ovat litteitä kameraa seuraavia tasoja ~400–580 m korkeudessa (`features.clouds`), jotka tummuvat yöksi ja värjäytyvät ruskossa
- Siirtymät: `enterSurfaceScene()` / `leaveSurfaceScene()` (yhteiset pinta- ja matalalentomoodille) — **TÄRKEÄÄ**: kamera on lisättävä renderöitävään sceneen (`surfaceScene.add(camera)` / `scene.add(camera)`), muuten Three.js ei päivitä kameran maailmamatriisia (kamera on avaruusscenen lapsi warp-efektin takia) ja näkymä jäätyy

## Näppäimet

Hiiri = katselu (pointer lock TAI vetämällä — lukko ei toimi kaikissa ympäristöissä, varajärjestelmä on). W/S/rulla = nopeus, Q/E = roll, X/M = pysäytä/täysi, 0–8 = kohde, F (pidä) = käänny kohteeseen, R = pikasiirtymä kohteen luo (rajoittamaton, testaukseen), G = laskeudu, B = takaisin alukselle, O = kiertoradat, H = ohje. Pinnalla WASD + Shift. V/T/P poistettu: komentosilta on aina päällä avaruudessa, tauko vain `__sim.pause()`-koukulla.

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
