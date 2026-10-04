# Arrière-plan et distribution de Tofu

Dans **Préférences**, activer **Tourner en arrière-plan**, puis enregistrer. Fermer la fenêtre, ou choisir **Passer en arrière-plan maintenant**, détruit la fenêtre native et sa WebView. Le processus Bun conserve le serveur HTTP, les torrents et les automatisations. L’icône Tofu de la barre de menus permet d’ouvrir l’application, d’ouvrir la même interface dans le navigateur, de rechercher une mise à jour ou de quitter complètement. Sans cette préférence, fermer la fenêtre quitte l’application.

Cette architecture évite de garder une WebView masquée en mémoire. Elle réutilise le moteur et le serveur du mode web plutôt qu’un second service. Bun, les connexions BitTorrent et les tâches actives continuent de consommer des ressources. Elle ne démarre pas automatiquement à l’ouverture de session et ne maintient pas macOS éveillé.

Le test `bun run test:background` active la préférence depuis la vraie WebView, ferme celle-ci pendant un transfert avec un pair réel, vérifie l’absence de WebView, l’accès aux automatisations et le SHA-256 du fichier terminé, puis recrée une unique fenêtre. L’injection reste exclusivement opt-in via `TOFU_SMOKE_SCRIPT`.

## Accès aux releases privées

Le code et les installateurs restent dans [Teyik0/Tofu](https://github.com/Teyik0/Tofu), **privé**. Les utilisateurs doivent être collaborateurs du dépôt. Dans **Préférences → Mises à jour → Connecter GitHub**, chacun configure son propre jeton GitHub personnel, limité à ce dépôt avec **Contents : lecture**. Le jeton reste côté Bun, dans `release-access.json` du dossier de données, accessible uniquement au compte local (permissions 0600). L’API et le journal ne renvoient jamais sa valeur. **Déconnecter** efface l’accès enregistré.

Tofu vérifie les releases stables au démarrage puis toutes les six heures. Une nouvelle version compatible avec l’architecture du Mac déclenche une notification native, une seule fois par version, et une bannière **Télécharger**. Le serveur local transmet l’installateur DMG avec l’accès personnel de l’utilisateur. Il ne transmet jamais le jeton au serveur des assets GitHub lors de la redirection.

Après téléchargement, choisir **Quitter Tofu**, ouvrir le DMG et remplacer l’application dans Applications. Les préférences et les fichiers téléchargés sont conservés. Le remplacement automatique de l’application n’est pas implémenté : l’updater Electrobun attend des artefacts accessibles par URL, alors que les releases de ce dépôt nécessitent l’authentification GitHub. La vérification et le téléchargement passent donc par l’API GitHub authentifiée côté Bun.

## Pipeline GitHub Actions

- **Checks** vérifie les types, le lint, les tests avec de vrais pairs et la compilation bureau à chaque push sur main ou pull request.
- **Release** compile et teste séparément sur macOS Apple Silicon et Intel. Un tag `vX.Y.Z` correspondant exactement à `package.json` publie les DMG, archives et métadonnées Electrobun ainsi que `SHA256SUMS` dans les releases du dépôt privé. La version native provient du même package.json.
- Un lancement manuel de **Release** teste les deux builds et conserve les artefacts pendant sept jours, sans publier de release. Les tests d’interface native se lancent localement sur un Mac disposant d’une session graphique.

Pour préparer une version : modifier la version dans package.json, exécuter `bun run tscheck`, `bun run fix`, `bun run test`, `bun run build:desktop`, `bun run test:native` et `bun run test:background`, puis committer et pousser le tag correspondant. Respecter les hooks Git du projet avant commit et push. `bun run build:release` produit également le DMG localement.

## Signature Apple

Sans secrets Apple, le workflow produit des installateurs non signés pour le développement. Pour la distribution signée et notarisée, configurer ensemble dans les secrets Actions :

| Secret | Valeur |
| --- | --- |
| APPLE_CERTIFICATE_P12 | Certificat Developer ID Application avec sa clé privée, exporté en P12 et encodé en base64 |
| APPLE_CERTIFICATE_PASSWORD | Mot de passe du P12 |
| ELECTROBUN_DEVELOPER_ID | Nom complet de l’identité Developer ID Application |
| APPLE_API_KEY_P8 | Contenu de la clé privée App Store Connect pour la notarisation |
| ELECTROBUN_APPLEAPIKEY | Identifiant de cette clé |
| ELECTROBUN_APPLEAPIISSUER | Identifiant de l’émetteur |

Le pipeline importe le certificat dans un trousseau temporaire et nettoie les clés après le build. La publication utilise uniquement le GITHUB_TOKEN temporaire du job, avec Contents en écriture. Les jetons personnels des utilisateurs ne sont pas des secrets de CI.
