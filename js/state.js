/* ---------------- Jaettu muuttuva tila ----------------
   Kaikki moduulien yli jaettu tila on yhdessä S-objektissa, jonka kenttiä
   moduulit lukevat ja kirjoittavat suoraan. Yksi objekti (ei yksittäisiä
   export let -muuttujia) pitää riippuvuudet yksisuuntaisina: state.js ei
   importtaa mitään, joten sirkulaarisia importteja ei synny. */
export const S = {
  simTime: 0,
  paused: false,
  mode: 'space',     // 'space' | 'surface'
  yaw: 0, pitch: 0, roll: 0,
  speedFrac: 0,      // säädetty nopeus (osuus c:stä)
  targetFrac: 0,     // tavoitenopeus, johon speedFrac liukuu
  effFrac: 0,        // todellinen nopeus (osuus c:stä) lähialuetila huomioiden
  dragBody: null,    // kehysseurannan planeetta
  dragWeight: 0,     // kehysseurannan paino 0–1
  hullHeat: 0,       // rungon kuumennus 0–1 (ilmakehäsyöksy) — näkyy kojelaudalla
  inv: {},           // louhittu/jalostettu varasto: { resurssi-id: määrä }
  targetIdx: 8,      // Neptunus oletuskohteena
  keys: {},
};

export function clamp01(v){ return Math.max(0, Math.min(0.99, v)); }
