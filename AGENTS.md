# Tofu

Client torrent de bureau : React/Furin → API Elysia → WebTorrent sous Bun, embarqué par Electrobun. Utiliser Bun pour toutes les commandes ; ne pas introduire Node, npm, Vite ou un autre moteur torrent.

- Lire la skill TDD avant de modifier le comportement. Tester les transferts et le cycle de vie par les API publiques avec des pairs réels, dans des dossiers temporaires.
- Conserver le moteur côté Bun et les types partagés dans `src/types.ts`.
- Les addons WebTorrent sont externes au bundling. Le SDK Electrobun est résolu depuis le devkit Hutch.
- La passerelle tracker/wires est liée à WebTorrent 3.0.21 ; repasser les tests lors d’une mise à jour.
- Ne jamais effacer les fichiers lors d’une pause, d’un changement de trackers ou d’une reprise. La suppression des données nécessite l’option explicite du formulaire.
- Afficher les statistiques réelles. Une valeur inconnue reste `null` dans l’API et `—` dans l’interface.
- Pas de valeurs par défaut dans les paramètres de fonctions ; préférer des types précis aux dictionnaires non structurés.
- Garder les modifications ciblées, expliquer le choix d’architecture et son alternative.
- Après une modification : `bun run tscheck`, `bun run fix`, `bun run test`, `bun run build:desktop`. Pour une modification de l’interface ou de l’intégration native : `bun run test:native`.
- Le script natif de test est opt-in via `TOFU_SMOKE_SCRIPT`. Il ne doit jamais devenir un script injecté par défaut.
- Exécuter les hooks Git existants avant un commit ou un push.
