const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { creerPartie, estCombinaisonValide, verifierOuverture } = require('./jeu');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));

// Stockage en mémoire des salons de jeu (à remplacer par une base de données plus tard)
const rooms = {};

function envoyerEtatSalon(salonId) {
  const salon = rooms[salonId];
  if (!salon) return;

  // Chaque joueur ne reçoit que sa propre main, pas celles des autres
  for (const joueur of salon.joueurs) {
    const etatPourLui = {
      joueurs: salon.joueurs.map(j => ({ id: j.id, pseudo: j.pseudo, nbCartes: salon.partie?.mains[j.id]?.length ?? 0 })),
      phase: salon.partie?.phase || 'attente',
      tourActuel: salon.partie ? salon.joueurs[salon.partie.tourActuel]?.id : null,
      maMain: salon.partie?.mains[joueur.id] || [],
      defausse: salon.partie?.defausse || [],
      nbCartesPioche: salon.partie?.pioche.length ?? 0,
      combinaisonsPosees: salon.partie?.combinaisonsPosees || [],
      donneurId: salon.partie?.donneurId || null,
      estOuvert: !!salon.partie?.joueursOuverts[joueur.id],
      doitOuvrirCeTour: !!salon.partie?.doitOuvrirCeTour,
      premierTourDeLaPartie: !!salon.partie?.premierTourDeLaPartie,
      numeroTour: salon.partie?.numeroTour ?? 1,
      aDejaPiocheCeTour: !!salon.partie?.aDejaPiocheCeTour
    };
    io.to(joueur.id).emit('etat-partie', etatPourLui);
  }
}

/**
 * Fait passer la main au joueur suivant. Si ce joueur doit sauter sa pioche
 * (parce qu'il a gardé une carte en trop lors d'un tour précédent), il démarre
 * directement en phase 'jouer' sans piocher.
 */
function passerAuJoueurSuivant(salon) {
  const partie = salon.partie;
  partie.tourActuel = (partie.tourActuel + 1) % salon.joueurs.length;
  const prochainId = salon.joueurs[partie.tourActuel]?.id;
  partie.aDejaPiocheCeTour = false;

  if (partie.doitSauterPiocheProchainement[prochainId]) {
    partie.phase = 'jouer';
    delete partie.doitSauterPiocheProchainement[prochainId];
  } else {
    partie.phase = 'piocher';
  }
}

io.on('connection', (socket) => {
  console.log(`Joueur connecté : ${socket.id}`);

  socket.on('rejoindre-salon', ({ salonId, pseudo }) => {
    socket.join(salonId);

    if (!rooms[salonId]) {
      rooms[salonId] = { joueurs: [], partie: null };
    }
    rooms[salonId].joueurs.push({ id: socket.id, pseudo });
    socket.data.salonId = salonId;

    io.to(salonId).emit('salon-mis-a-jour', rooms[salonId]);
  });

  socket.on('demarrer-partie', () => {
    const salonId = socket.data.salonId;
    const salon = rooms[salonId];
    if (!salon || salon.joueurs.length < 2) {
      socket.emit('erreur', 'Il faut au moins 2 joueurs pour commencer.');
      return;
    }

    const joueurIds = salon.joueurs.map(j => j.id);
    salon.partie = creerPartie(joueurIds);

    const donneurPseudo = salon.joueurs.find(j => j.id === salon.partie.donneurId)?.pseudo;
    io.to(salonId).emit('partie-demarree', { donneurPseudo });
    envoyerEtatSalon(salonId);
  });

  socket.on('piocher', ({ depuisDefausse }) => {
    const salonId = socket.data.salonId;
    const salon = rooms[salonId];
    if (!salon?.partie) return;

    const partie = salon.partie;
    const joueurActuelId = salon.joueurs[partie.tourActuel]?.id;
    if (socket.id !== joueurActuelId || partie.phase !== 'piocher') {
      let raison = "Ce n'est pas ton tour de piocher.";
      if (socket.id === joueurActuelId && partie.phase === 'jouer') {
        raison = partie.premierTourDeLaPartie
          ? "C'est le premier tour de la partie : tu ne pioches pas, joue directement avec tes 15 cartes."
          : "Tu as gardé une carte en trop la dernière fois : tu ne pioches pas ce tour-ci, défausse directement.";
      }
      socket.emit('erreur', raison);
      return;
    }

    if (depuisDefausse && partie.numeroTour === 2) {
      socket.emit('erreur', "Au deuxième tour de la partie, tu ne peux piocher que dans le paquet, pas dans la défausse.");
      return;
    }

    const carte = depuisDefausse ? partie.defausse.pop() : partie.pioche.pop();
    if (!carte) {
      socket.emit('erreur', 'Plus de cartes disponibles.');
      return;
    }

    partie.mains[socket.id].push(carte);
    partie.phase = 'jouer';
    partie.aDejaPiocheCeTour = true;

    // Si le joueur n'a pas encore ouvert et pioche dans la défausse, il doit
    // impérativement ouvrir (51 pts + tierce franche) ce même tour avant de défausser
    if (depuisDefausse && !partie.joueursOuverts[socket.id]) {
      partie.doitOuvrirCeTour = true;
    } else {
      partie.doitOuvrirCeTour = false;
    }

    envoyerEtatSalon(salonId);
  });

  socket.on('ouvrir', ({ groupes }) => {
    const salonId = socket.data.salonId;
    const salon = rooms[salonId];
    if (!salon?.partie) return;

    const partie = salon.partie;
    const joueurActuelId = salon.joueurs[partie.tourActuel]?.id;
    if (socket.id !== joueurActuelId) {
      socket.emit('erreur', "Ce n'est pas ton tour.");
      return;
    }
    if (partie.joueursOuverts[socket.id]) {
      socket.emit('erreur', 'Tu as déjà ouvert.');
      return;
    }

    const main = partie.mains[socket.id];
    const groupesCartes = groupes.map(cartesIds => cartesIds.map(id => main.find(c => c.id === id)).filter(Boolean));

    // Vérifie que toutes les cartes existent bien dans la main du joueur
    const toutesCartesValides = groupes.every((ids, i) => groupesCartes[i].length === ids.length);
    if (!toutesCartesValides) {
      socket.emit('erreur', 'Une ou plusieurs cartes sélectionnées sont introuvables.');
      return;
    }

    const resultat = verifierOuverture(groupesCartes);
    if (!resultat.valide) {
      socket.emit('erreur', resultat.raison);
      return;
    }

    const idsAPoser = new Set(groupes.flat());
    partie.mains[socket.id] = main.filter(c => !idsAPoser.has(c.id));
    for (const cartes of groupesCartes) {
      partie.combinaisonsPosees.push({ joueurId: socket.id, cartes });
    }
    partie.joueursOuverts[socket.id] = true;
    partie.doitOuvrirCeTour = false;

    envoyerEtatSalon(salonId);
  });

  socket.on('poser-combinaison', ({ cartesIds }) => {
    const salonId = socket.data.salonId;
    const salon = rooms[salonId];
    if (!salon?.partie) return;

    const partie = salon.partie;
    const joueurActuelId = salon.joueurs[partie.tourActuel]?.id;
    if (socket.id !== joueurActuelId) return;

    if (!partie.joueursOuverts[socket.id]) {
      socket.emit('erreur', "Tu dois d'abord ouvrir avec au moins 51 points et une tierce franche (bouton 'Ouvrir').");
      return;
    }

    const main = partie.mains[socket.id];
    const cartes = cartesIds.map(id => main.find(c => c.id === id)).filter(Boolean);

    if (cartes.length !== cartesIds.length || !estCombinaisonValide(cartes)) {
      socket.emit('erreur', 'Combinaison invalide.');
      return;
    }

    partie.mains[socket.id] = main.filter(c => !cartesIds.includes(c.id));
    partie.combinaisonsPosees.push({ joueurId: socket.id, cartes });

    envoyerEtatSalon(salonId);
  });

  socket.on('defausser', ({ carteId }) => {
    const salonId = socket.data.salonId;
    const salon = rooms[salonId];
    if (!salon?.partie) return;

    const partie = salon.partie;
    const joueurActuelId = salon.joueurs[partie.tourActuel]?.id;
    if (socket.id !== joueurActuelId || partie.phase !== 'jouer') {
      socket.emit('erreur', "Ce n'est pas ton tour de défausser.");
      return;
    }

    if (partie.doitOuvrirCeTour && !partie.joueursOuverts[socket.id]) {
      socket.emit('erreur', "Tu as pioché dans la défausse sans pouvoir ouvrir : utilise le bouton 'Passer' pour garder la carte, tu joueras sans piocher au tour suivant.");
      return;
    }

    const main = partie.mains[socket.id];
    const index = main.findIndex(c => c.id === carteId);
    if (index === -1) return;

    const [carte] = main.splice(index, 1);
    partie.defausse.push(carte);
    partie.doitOuvrirCeTour = false;
    partie.premierTourDeLaPartie = false;
    partie.numeroTour += 1;

    if (main.length === 0) {
      partie.phase = 'termine';
      io.to(salonId).emit('partie-terminee', { gagnantId: socket.id });
    } else {
      passerAuJoueurSuivant(salon);
    }

    envoyerEtatSalon(salonId);
  });

  socket.on('passer', () => {
    const salonId = socket.data.salonId;
    const salon = rooms[salonId];
    if (!salon?.partie) return;

    const partie = salon.partie;
    const joueurActuelId = salon.joueurs[partie.tourActuel]?.id;
    if (socket.id !== joueurActuelId || partie.phase !== 'jouer') {
      socket.emit('erreur', "Ce n'est pas ton tour.");
      return;
    }

    if (!partie.doitOuvrirCeTour || partie.joueursOuverts[socket.id]) {
      socket.emit('erreur', "Tu ne peux passer que si tu as pioché dans la défausse sans pouvoir ouvrir.");
      return;
    }

    // Le joueur garde la carte piochée (pas de défausse ce tour-ci) et devra
    // sauter sa prochaine pioche pour revenir à une main normale
    partie.doitOuvrirCeTour = false;
    partie.doitSauterPiocheProchainement[socket.id] = true;
    partie.premierTourDeLaPartie = false;
    partie.numeroTour += 1;

    passerAuJoueurSuivant(salon);
    envoyerEtatSalon(salonId);
  });

  socket.on('disconnect', () => {
    console.log(`Joueur déconnecté : ${socket.id}`);
    for (const salonId in rooms) {
      rooms[salonId].joueurs = rooms[salonId].joueurs.filter(j => j.id !== socket.id);
      io.to(salonId).emit('salon-mis-a-jour', rooms[salonId]);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
