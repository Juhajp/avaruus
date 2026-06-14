/* ---------------- Aluksen resurssit: runko + happi ----------------
   Kaksi resurssia (S.hull, S.oxygen) jotka pätevät ja kuluvat VAIN
   avaruusaluksessa (space-tila) — ei pinnalla eikä matalalennossa:
   - HAPPI kuluu jatkuvasti (elossapito). Loppuessa miehistö tukehtuu.
   - RUNGON KESTÄVYYS vaurioituu ilmakehäsyöksyn kuumuudesta (S.hullHeat).
     Nollassa runko pettää. Täydennys: jalostetaan Marsilla happisäiliö /
     runkopaneeli varastoon (mining.js) ja KÄYTETÄÄN ne erikseen (J/K).
   Arvot näkyvät ohjaamon oikealla "ALUS"-näytöllä (cockpit.js, drawTgt). */
import { S } from './state.js';
import { destroyShip } from './reentry.js';
import { renderHud as renderMiningHud } from './mining.js';

const OXY_RATE = 1 / 900;        // happi tyhjenee täydestä ~15 min:ssa
const HEAT_DMG_THRESH = 0.7;     // tämän ylittävä runkolämpö syö kestävyyttä
const HULL_BURN = 1.1;           // vaurionopeus (täysi lämpö → runko nollaan ~3 s)

// käyttötuotteet: varaston id → täytettävä resurssi + täyttömäärä
const USE = {
  happi:   { res: 'oxygen', amount: 0.5 },
  paneeli: { res: 'hull',   amount: 0.5 },
};

// käytä yksi happisäiliö ('happi') tai runkopaneeli ('paneeli') varastosta
export function useItem(kind){
  const u = USE[kind];
  if (!u) return false;
  if ((S.inv[kind] || 0) <= 0) return false;     // ei varastossa
  if ((S[u.res] || 0) >= 1) return false;        // jo täynnä — ei tuhlata
  S.inv[kind] -= 1;
  S[u.res] = Math.min(1, (S[u.res] || 0) + u.amount);
  renderMiningHud();
  return true;
}

export function updateResources(dt){
  // runko ja happi pätevät/kuluvat vain avaruusaluksessa
  if (S.mode !== 'space') return;
  const ov = document.getElementById('startOverlay');
  if ((ov && ov.style.display !== 'none') || S.paused) return;
  // happi kuluu jatkuvasti
  S.oxygen = Math.max(0, S.oxygen - OXY_RATE * dt);
  // runkolämpö (ilmakehäsyöksyssä) vaurioittaa runkoa
  const hh = S.hullHeat || 0;
  if (hh > HEAT_DMG_THRESH) S.hull = Math.max(0, S.hull - HULL_BURN * (hh - HEAT_DMG_THRESH) * dt);
  if (S.hull <= 0)   { destroyShip('Runko petti vaurioista.'); return; }
  if (S.oxygen <= 0) { destroyShip('Happi loppui — miehistö tukehtui.'); return; }
}
