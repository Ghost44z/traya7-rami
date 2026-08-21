// Logique du jeu de Rami : création du paquet, distribution, validation des combinaisons

const COULEURS = ['coeur', 'carreau', 'trefle', 'pique'];
const VALEURS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R'];

/**
 * Crée un paquet complet : 2 jeux de 52 cartes + 2 jokers = 108 cartes
 */
function creerPaquet() {
  const paquet = [];
  let id = 0;

  // 2 jeux complets
  for (let jeu = 0; jeu < 2; jeu++) {
    for (const couleur of COULEURS) {
      for (const valeur of VALEURS) {
        paquet.push({ id: `c${id++}`, valeur, couleur, joker: false });
      }
    }
  }

  // 4 jokers (2 par jeu de 52) pour atteindre 108 cartes au total
  for (let i = 0; i < 4; i++) {
    paquet.push({ id: `j${id++}`, valeur: 'JOKER', couleur: null, joker: true });
  }

  return paquet;
}

/**
 * Mélange un paquet (algorithme de Fisher-Yates)
 */
function melanger(paquet) {
  const copie = [...paquet];
  for (let i = copie.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

/**
 * Détermine le donneur : chaque joueur tire une carte d'un paquet mélangé,
 * celui qui obtient la carte de plus haute valeur en points devient donneur
 */
function determinerDonneur(joueurIds) {
  const paquetTemp = melanger(creerPaquet());
  const tirages = joueurIds.map((id, i) => ({ joueurId: id, carte: paquetTemp[i] }));

  let meilleur = tirages[0];
  for (const t of tirages) {
    if (valeurPoints(t.carte) > valeurPoints(meilleur.carte)) meilleur = t;
  }

  return { donneurId: meilleur.joueurId, tirages };
}

/**
 * Coupe le paquet en deux tas à un point aléatoire et inverse leur ordre
 */
function couperPaquet(paquet) {
  const tiers = Math.floor(paquet.length / 3);
  const pointCoupe = tiers + Math.floor(Math.random() * tiers);
  return [...paquet.slice(pointCoupe), ...paquet.slice(0, pointCoupe)];
}

/**
 * Crée un nouvel état de partie pour une liste de joueurs.
 * Règles : tirage au sort du donneur, coupe du paquet, distribution à partir
 * du joueur suivant le donneur, ce premier joueur reçoit 15 cartes (au lieu de 14)
 * car il ne pioche pas lors de son premier tour, et la défausse démarre vide.
 */
function creerPartie(joueurIds) {
  const { donneurId, tirages } = determinerDonneur(joueurIds);

  let paquet = couperPaquet(melanger(creerPaquet()));

  const donneurIndex = joueurIds.indexOf(donneurId);
  // Ordre de distribution à partir du joueur qui suit le donneur
  const ordreDistribution = joueurIds.map((_, i) => joueurIds[(donneurIndex + 1 + i) % joueurIds.length]);

  const mains = {};
  for (const id of ordreDistribution) {
    mains[id] = paquet.splice(0, 14);
  }

  // Le premier joueur à jouer reçoit une carte supplémentaire (15 au total)
  // car il ne pioche pas lors de son premier tour
  const premierJoueurId = ordreDistribution[0];
  mains[premierJoueurId].push(paquet.shift());

  return {
    pioche: paquet,
    defausse: [], // vide au départ : aucune carte retournée avant le premier tour
    mains,
    ordreJoueurs: joueurIds,
    donneurId,
    tirageDonneur: tirages,
    tourActuel: joueurIds.indexOf(premierJoueurId),
    joueursOuverts: {}, // { joueurId: true } une fois qu'ils ont posé leur première combinaison (51 pts)
    doitOuvrirCeTour: false, // true si le joueur actuel a pioché dans la défausse sans avoir encore ouvert
    doitSauterPiocheProchainement: {}, // { joueurId: true } : ce joueur doit sauter sa prochaine pioche (garde une carte en trop)
    aDejaPiocheCeTour: false, // true dès que le joueur courant a pioché lors de ce tour
    premierTourDeLaPartie: true, // true seulement avant que le tout premier joueur n'ait défaussé
    numeroTour: 1, // 1 = premier joueur (ne pioche pas), 2 = deuxième joueur (pioche paquet uniquement), 3+ = normal
    combinaisonsPosees: [], // combinaisons posées sur la table, visibles par tous
    phase: 'jouer' // le premier joueur commence directement à jouer, sans piocher
  };
}

/**
 * Valeur en points d'une carte pour le calcul des 51 points d'ouverture
 */
function valeurPoints(carte) {
  if (carte.joker) return 25;
  if (carte.valeur === 'A') return 11;
  if (['V', 'D', 'R'].includes(carte.valeur)) return 10;
  return parseInt(carte.valeur, 10);
}

/**
 * Vérifie si une combinaison est une tierce franche valide (même couleur, valeurs consécutives, min 3 cartes)
 */
function estTierceFranche(cartes) {
  if (cartes.length < 3) return false;
  const nonJokers = cartes.filter(c => !c.joker);
  const nbJokers = cartes.length - nonJokers.length;

  const couleur = nonJokers[0]?.couleur;
  if (!nonJokers.every(c => c.couleur === couleur)) return false;

  const ordreValeurs = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R'];
  const indices = nonJokers.map(c => ordreValeurs.indexOf(c.valeur)).sort((a, b) => a - b);

  // Vérifie les trous comblés par des jokers
  let trous = 0;
  for (let i = 1; i < indices.length; i++) {
    const ecart = indices[i] - indices[i - 1];
    if (ecart === 0) return false; // doublon = invalide
    trous += ecart - 1;
  }

  return trous <= nbJokers;
}

/**
 * Vérifie si une combinaison est un brelan/carré valide (même valeur, couleurs différentes, min 3 cartes)
 */
function estBrelan(cartes) {
  if (cartes.length < 3 || cartes.length > 4) return false;
  const nonJokers = cartes.filter(c => !c.joker);
  const nbJokers = cartes.length - nonJokers.length;

  const valeur = nonJokers[0]?.valeur;
  if (!nonJokers.every(c => c.valeur === valeur)) return false;

  const couleursUtilisees = new Set(nonJokers.map(c => c.couleur));
  if (couleursUtilisees.size !== nonJokers.length) return false; // couleurs en double = invalide

  return nbJokers >= 0;
}

/**
 * Vérifie si une combinaison de cartes est valide (tierce ou brelan)
 */
function estCombinaisonValide(cartes) {
  return estTierceFranche(cartes) || estBrelan(cartes);
}

/**
 * Vérifie si un ensemble de groupes de cartes permet une ouverture valide :
 * chaque groupe doit être une combinaison valide, le total des points doit
 * atteindre au moins 51, et au moins un groupe doit être une tierce franche.
 */
function verifierOuverture(groupes) {
  if (!groupes.every(estCombinaisonValide)) {
    return { valide: false, raison: 'Un ou plusieurs groupes ne sont pas des combinaisons valides.' };
  }

  const total = groupes.reduce((somme, g) => somme + g.reduce((s, c) => s + valeurPoints(c), 0), 0);
  if (total < 51) {
    return { valide: false, raison: `Il faut au moins 51 points pour ouvrir (actuellement ${total}).` };
  }

  if (!groupes.some(estTierceFranche)) {
    return { valide: false, raison: "L'ouverture doit contenir au moins une tierce franche." };
  }

  return { valide: true, total };
}

module.exports = {
  creerPaquet,
  melanger,
  couperPaquet,
  determinerDonneur,
  creerPartie,
  valeurPoints,
  estTierceFranche,
  estBrelan,
  estCombinaisonValide,
  verifierOuverture
};
