# Avaruus - Codex-ohjeistus

Tama projekti on selainpohjainen Three.js-avaruussimulaattori. Se on siirretty
Codexiin GitHub-reposta `https://github.com/Juhajp/avaruus.git`.

## Projektin tarkoitus

Peli on natiiveilla ES-moduuleilla toteutettu 3D-avaruus- ja
pintatutkimussimulaattori:

- FPV-lento aurinkokunnassa
- laskeutuminen kiviplaneetoille
- 3D-ohjaamo ja ulkonakyma
- pintamoodi, louhinta, viholliset ja planeettakohtainen maasto

Laajempi historiallinen ja tekninen kuvaus on tiedostossa `CLAUDE.md`.

## Tekninen perusta

- Ei npm- tai build-vaihetta.
- `index.html` lataa Three.js:n ja lisaosat importmapilla CDN:sta.
- Sovelluskoodi on natiiveina ES-moduuleina hakemistossa `js/`.
- Assetit ovat hakemistoissa `assets/` ja `models/`.
- GLSL-shaderit ovat JavaScript-template-literaaleissa.

## Komennot

- Kehityspalvelin: `python3 serve.py`
- Oletusosoite: `http://localhost:8741`
- Vaihtoehtoinen staattinen palvelin: `python3 -m http.server 8741`

Suosi `serve.py`-palvelinta, koska se lahettaa no-cache-otsakkeet ja estaa
selainta tarjoamasta vanhoja ES-moduuleja kehityksen aikana.

## Paamoduulit

- `js/state.js` - jaettu muuttuva tila `S`-objektissa. Ala kopioi tilakenttia
  moduulin latauksessa paikallisiin muuttujiin; lue ja kirjoita `S.kentta`
  suoraan.
- `js/core.js` - renderer, scene, camera, composer ja yhteiset mittakaavat.
- `js/bodies.js` - planeettadata, kappaleet, tekstuurit ja paivitys.
- `js/surface.js` - pinta- ja matalalentomoodit, maasto ja laskeutuminen.
- `js/cockpit.js` - 3D-ohjaamot ja alusten ulkomallit.
- `js/main.js` - paasilmukka ja `window.__sim`-debug-koukut.

## Arkkitehtuuriperiaatteet

- Pida rendering, fysiikka, input, HUD ja pintamoodin logiikka erillisissa
  moduuleissa nykyisen rakenteen mukaisesti.
- Vali sirkulaarisia importteja. Jaettu tila kulkee `state.js`:n `S`-objektin
  kautta.
- Lisaa uudet vihollistyypit omiin tiedostoihinsa nykyisten mallien tapaan.
- Lisaa pinnalle sijoitettaville objekteille varjoasetukset nykyisten apurien
  kautta, jotta matalan auringon itsevarjostus ei riko visuaaleja.
- Custom-shadereissa huomioi logarithmic depth buffer; katso olemassa olevat
  `logdepthbuf`-chunkit ennen shaderimuutoksia.
- Varo backtickeja ja `${`-sekvensseja GLSL-template-literaaleissa.

## Verifiointi

Visuaalisten tai pelimekaanisten muutosten jalkeen:

1. Kaynnista `python3 serve.py`.
2. Avaa `http://localhost:8741`.
3. Tarkista selaimen konsoli moduuli-, WebGL- ja asset-virheiden varalta.
4. Varmista, etta ensimmainen 3D-scene renderoityy eika canvas jaa tyhjaksi.
5. Testaa tarvittaessa `window.__sim`-koukuilla:
   - `__sim.state()`
   - `__sim.goto(idx, dist)`
   - `__sim.beam(idx)`
   - `__sim.beamUp()`
   - `__sim.surf()`

## Tunnetut riskit

- Projekti tarvitsee nettiyhteyden CDN:sta ladattavaan Three.js:aan ja osaan
  etatekstuureista.
- Selaimen valimuisti voi aiheuttaa vanhojen ES-moduulien latautumista; siksi
  `serve.py` on ensisijainen kehityspalvelin.
- Suorituskyky on herkka maaston, varjojen, overdrawn ja tekstuurien muutoksille.
  Tarkista FPS silmamaaraisesti ja tarvittaessa selaimen performance-tyokaluilla.
- `CLAUDE.md` sisaltaa paljon projektihistoriaa; kayta sita yksityiskohtaisena
  referenssina ennen isoja muutoksia.
