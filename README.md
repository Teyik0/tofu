# Tofu

Un client torrent de bureau construit avec **Furin + React, Electrobun et WebTorrent**. L’interface française utilise les statistiques réelles du moteur. Aucun service qBittorrent ou Deluge n’est nécessaire.

## Lancer l’application

Les versions sont distribuées dans les releases du dépôt privé [Teyik0/Tofu](https://github.com/Teyik0/Tofu). Voir [le mode arrière-plan, les mises à jour et le pipeline de release](docs/releases.md).

Pré requis : Bun et, pour le build macOS, les outils de ligne de commande Xcode. Le prototype a été compilé et testé sur **macOS Apple Silicon**.

```sh
cd /Users/teyik0/Documents/Tofu
bun install --ignore-scripts
bun run setup
bun run prepare
bun run build:desktop
bun run desktop
```

Le build déjà présent peut être ouvert directement : `build/dev-macos-arm64/Tofu-dev.app`.

Pour l’installer, glisser `Tofu-dev.app` dans `/Applications`, puis l’ouvrir depuis le Finder. Ce build de développement n’est pas signé ni notarisé. Pour mettre à jour l’application après des modifications, fermer Tofu, relancer `bun run build:desktop` et remplacer la copie dans `/Applications`. Les réglages et téléchargements restent dans vos dossiers utilisateur.

`setup` télécharge le SDK Electrobun via Hutch et installe le binaire précompilé de `node-datachannel`. Le moteur s’exécute sous Bun, y compris ses imports compatibles avec les API Node. Aucun processus Node ni gestionnaire npm n’est nécessaire.

Pour travailler sur l’interface ou utiliser le mode web sur la machine de téléchargement :

```sh
bun run dev
# http://127.0.0.1:3030
```

Pour le serveur compilé :

```sh
bun run build
bun run start
```

Un seul processus Bun héberge Furin/Elysia et le moteur torrent. Le moteur est conservé pendant les rechargements de l’interface en développement ; après une modification du code du moteur lui-même, redémarrer le serveur. Le mode bureau ouvre la même interface dans la WebView système et choisit un port local libre. Le serveur écoute uniquement sur l’adresse de boucle locale. Un contrôle depuis une autre machine peut utiliser un tunnel SSH ; l’exposition directe sur un réseau et l’authentification ne sont pas implémentées dans ce prototype.

## Essayer avec de vrais transferts locaux

Après avoir démarré l’application :

```sh
bun run demo
# Ou, pour une instance web spécifique :
bun run demo -- http://127.0.0.1:3030
```

Trois fichiers identifiés comme « Démo » sont servis par un véritable pair TCP et un tracker HTTP local : un petit texte, un transfert de 32 Mio et un fichier ajouté en pause. Les compteurs ne sont pas simulés. Garder le terminal de démonstration ouvert maintient le pair et le tracker en ligne. Les sources de démonstration sont dans `.cache/demo-source` ; les téléchargements suivent les préférences de Tofu.

## Fonctionnalités

- Ajout par magnet, URL HTTP(S) ou fichier `.torrent`, dans le dossier de l’onglet choisi, avec ajout en pause.
- Sidebar shadcn compacte et réductible : création et renommage d’onglets, modification de leur dossier et filtrage des torrents. Plusieurs onglets peuvent utiliser le même dossier avec des identifiants distincts.
- Un changement de dossier propose de déplacer les fichiers existants. Sans cette option, seul l’emplacement des prochains ajouts change. Les transferts reprennent après déplacement ; les torrents en pause restent en pause. Les fichiers manquants, conflits de destination et vérifications en cours produisent une erreur explicite.
- Pause et reprise individuelles ou limitées aux torrents affichés ; suppression du torrent avec choix explicite de conserver ou supprimer ses fichiers.
- Trackers : affichage des URLs, état, erreur, sources, pairs et dernière annonce ; ajout, modification, suppression et réannonce manuelle.
- Fichiers : taille, progression, priorité ignorée/normale/haute et récupération HTTP du fichier terminé.
- Pairs : adresse, client, transport, débits, progression et indicateurs de connexion ; ajout d’un pair direct.
- Statistiques : réception, envoi, octets reçus et partagés, ratio, temps restant, sources/pairs connectés, essaim annoncé, temps actif et temps en partage.
- Historique des débits des deux dernières minutes, carte des pièces vérifiées, hash, métadonnées, dates et dossier de destination.
- Vérification forcée des données présentes sur disque ; les pièces endommagées sont retéléchargées lors de la reprise.
- Préférences persistantes : dossier et limites globales de débit. Champ vide = illimité ; zéro = trafic bloqué.
- État des torrents, métadonnées, trackers, priorités et compteurs enregistrés en SQLite. Reprise après redémarrage.
- Choix natif d’un dossier et ouverture de son emplacement dans le Finder en mode bureau.

Les valeurs non disponibles apparaissent comme `—`. Les nombres de l’essaim viennent des réponses des trackers ; ils ne sont pas additionnés entre trackers, car ils peuvent décrire les mêmes pairs. Un pair connecté complet compte comme une source. Les graphes représentent le trafic de toute la session, et sont explicitement libellés ainsi.

Les débits et les octets reçus/partagés mesurent le trafic des connexions BitTorrent, messages entre pairs inclus. Ils peuvent donc rester non nuls après 100 % ; la progression et les pièces vérifiées mesurent les données du fichier. Tofu rejette les connexions portant son propre identifiant de pair : le contrôle interne de WebTorrent 3.0.21 compare cet identifiant au mauvais objet, ce qui peut laisser passer une boucle réseau via le routeur.

## Architecture et alternatives

```text
React + Furin (SSR / hydratation)
              │ HTTP local
          Elysia API
              │
      TorrentEngine / WebTorrent
              ├── TCP / DHT / trackers / WebRTC
              ├── fichiers sur disque
              └── SQLite

Electrobun : fenêtre native, dialogues et cycle de vie
```

**Choix recommandé : garder Furin et placer WebTorrent dans le processus Bun d’Electrobun.** Le navigateur affiche les données et déclenche les actions ; il ne possède ni le moteur ni les fichiers. L’API et le moteur peuvent être repris dans une application serveur sans changer l’interface.

Alternative : des appels RPC typés Electrobun entre la WebView et Bun. Cela évite le serveur HTTP pour le bureau, mais introduit un transport spécifique et du travail supplémentaire pour proposer le contrôle web. Pour ce prototype, HTTP est le choix le plus petit et le plus réutilisable.

L’interface utilise les composants officiels [shadcn/Radix](https://ui.shadcn.com/docs/components/radix/sidebar), avec le thème olive et les polices locales existants. `components.json` permet de les gérer par la CLI Bun. Les modales utilisent Dialog et AlertDialog, les détails Tabs, et les formulaires Field/Input/Checkbox/NativeSelect.

Le routage utilise les pages natives de Furin : `/library` ouvre Téléchargements, `/library/all` affiche tous les torrents et `/library/destinations/:id` ouvre un onglet. Le segment `src/pages/library/_route.tsx` charge le tableau de bord et conserve la sidebar, les modales et la sélection entre les navigations. Les liens Furin permettent le préchargement et le retour arrière. Le document reste dans `root.tsx` ; `/` redirige vers la bibliothèque.

Le loader du layout lit les résumés via le client Eden enrichi par Furin Sync. Les pages utilisent `defer()` et `Await` sous Suspense pour les détails initiaux ; `useQuery` conserve ensuite les détails consultés dans le cache Furin. L’ancien polling React et sa Map de cache ont été supprimés. Les statistiques ne bloquent pas les clics de sélection.

Le moteur WebTorrent évolue hors des requêtes HTTP. Un relais côté Bun publie une invalidation du layout toutes les secondes avec l’adaptateur public SQLite de Furin Sync, dans `sync.sqlite`. Le transport d’événements, la récupération par curseur et les rafraîchissements sont ceux de Furin. La version embarquée transmet un curseur global puis demande un rafraîchissement des caches ; elle ne pousse pas directement les valeurs des compteurs. Les actions WebTorrent et les dialogues natifs portent `sync: false` : leurs effets sur le moteur et le disque ne sont pas des transactions SQL rejouables. Les écritures périodiques du moteur restent regroupées toutes les cinq secondes ; les actions et l’arrêt restent enregistrés immédiatement.

Cette structure suit les principes de [Next.js](https://nextjs.org/docs/app/getting-started/fetching-data) et [TanStack Router](https://tanstack.com/router/latest/docs/guide/data-loading) : chargement attaché aux routes, layouts persistants et Suspense autour des données différées. L’alternative était de garder la navigation et le polling dans un composant monolithique ; utiliser les fonctions natives de Furin évite ce doublon. Cette version suit les dossiers et ne fournit pas de groupe sans segment d’URL de type `(group)`.

Les plugins de sources, Jev et AniList s’exécutent côté Bun. `AutomationService` conserve les règles, les décisions et les évaluations dans `feeds.sqlite`, puis remet les torrents retenus au moteur existant. Le navigateur prépare les règles et présente les décisions. L’alternative serait un service externe comme Sonarr/Jackett ; conserver ce travail dans Bun permet d’utiliser directement l’identité et le dossier des onglets, sans installer un service supplémentaire. C411 utilise directement son API Torznab.

## Plugins et automatisations

Ouvrir **Plugins** dans la sidebar. Nyaa, Tsundere-Raws, C411, Jev et AniList sont des plugins distincts, désactivés à la première installation. C411 et Jev utilisent vos clés personnelles. Les clés restent côté Bun et ne sont pas renvoyées dans l’état public ; la base locale les conserve dans un fichier privé, sans chiffrement.

- **Nyaa** : RSS de recherche et recherche HTML de secours si le RSS répond en erreur.
- **Tsundere-Raws** : les 250 dernières sorties torrent du flux JSON officiel, fournisseur Nyaa. Les liens vers des hébergeurs de fichiers sont exclus.
- **C411** : recherche Torznab authentifiée. Les requêtes de recherche sont espacées de 4,1 secondes ; les fichiers `.torrent` et leurs paramètres privés sont récupérés côté Bun.
- **Jev / TypeSafe** : interprétation de la demande et vérification de l’identité/ des exigences. Le classement par langues, formats et sources reste défini par vos priorités. Les évaluations sont mises en cache 24 heures et un plafond quotidien d’appels est configurable.
- **AniList** : lecture de Watching et Plan to Watch et création de règles à partir des noms et alias des titres. Aucun statut ni progrès n’est modifié sur AniList.

Dans **Découvrir**, toutes les sources activées sont sélectionnées par défaut. Les cases permettent de limiter une recherche à certaines sources sans désactiver leurs plugins. Sans Jev activé avec une clé configurée, la recherche reste classique : une seule requête transmet les mots-clés tels quels à chaque source sélectionnée, sans interprétation des saisons/épisodes ni résolution des alias par AniList. Le flux Tsundere-Raws est filtré localement par mots-clés.

Lorsque Jev est activé et configuré, la recherche naturelle est disponible : `re zero ep9 saison4`, `re zero s4 ep9` et `re zero S04E09` désignent la saison 4, épisode 9. Le catalogue public AniList fournit les titres anglais, japonais romanisés et japonais, sans compte ni activation du plugin de suivi. Les recherches utilisent plusieurs variantes anglaises et romanisées, puis filtrent les sorties selon leurs titres, saisons et épisodes ; les variantes d’une même sortie sont fusionnées. Un titre seul recherche toutes ses saisons et épisodes.

Cette préparation reste côté Bun, avec un cache des titres et des requêtes limitées par source. La disponibilité du mode naturel suit la configuration de Jev ; les alias restent issus du catalogue public, plutôt que de titres inventés par une IA. Si AniList est indisponible en mode naturel, la recherche continue avec le titre saisi et l’interface le signale. Une saison ou un épisode inconnu n’est pas considéré comme une correspondance. Tsundere-Raws est récupéré une seule fois et filtré localement, car son flux ne propose pas de recherche ni d’archives complètes.

Dans un onglet, ouvrir **Automatisations**, écrire par exemple `Télécharge les nouveaux épisodes de "Ao Ashi" en VOSTFR, préfère 1080p puis 720p, avec Tsundere-Raws avant Nyaa`, puis préparer la règle. Vérifier le titre et les critères, réordonner les priorités, prévisualiser et créer. Sans Jev, le matching utilise un nom exact ou une expression régulière explicite ; les critères restent éditables. Une règle Jev reprend le nom exact si le plugin est désactivé ; une panne de Jev diffère la vérification.

Une résolution/langue unique est une exigence ; plusieurs valeurs sont des replis autorisés, dans l’ordre indiqué. L’attente facultative laisse le temps à une meilleure version d’arriver. Une correspondance Jev incertaine apparaît dans **Historique** pour validation. Après l’ajout d’un repli (par exemple 720p dans une règle `1080p, 720p`), Tofu continue à chercher une version strictement meilleure selon l’ordre des critères. Les variations du nombre de pairs et les versions de qualité égale ne déclenchent aucun remplacement. Une combinaison idéale n’est plus évaluée pour cet épisode ; la recherche continue pour les nouveaux épisodes. Les sorties ignorées ou retirées volontairement de la bibliothèque restent exclues.

Le remplacement conserve l’ancien torrent jusqu’à ce que le nouveau soit entièrement téléchargé, puis le retire de la bibliothèque. Les anciens fichiers ne sont effacés que si **Supprimer les anciens fichiers après remplacement** est coché dans le formulaire (désactivé par défaut, y compris pour les règles existantes). La version précédente et le remplacement en cours sont enregistrés dans `feeds.sqlite`, afin de reprendre ce cycle après redémarrage. Cette orchestration reste dans le service d’automatisation côté Bun et utilise les méthodes publiques du moteur ; supprimer immédiatement l’ancien torrent aurait risqué de perdre la seule copie complète en cas d’échec du nouveau téléchargement.

Les règles sont liées à l’identifiant de l’onglet, et les ajouts utilisent directement son dossier courant. Elles sont exécutées au démarrage, puis selon leur intervalle tant que Tofu tourne. Le rattrapage dépend des sorties encore présentes dans la recherche ou le flux de chaque source : un RSS limité aux sorties récentes ne constitue pas une archive complète. Les sorties en attente restent conservées localement pour les prochains essais.

Dans **AniList**, renseigner l’ID et le secret du client OAuth, avec exactement la même URL de retour que dans AniList → Settings → Developer (par exemple `http://localhost:3000/`). **Connecter AniList** ouvre l’autorisation dans le navigateur ; après autorisation, revenir dans Tofu et cliquer **Actualiser**. Le port de retour doit être libre. Un token OAuth déjà obtenu peut aussi être saisi dans Plugins → AniList. Pour une liste publique, le nom de compte suffit et ne nécessite pas de token.

Charger les listes et cocher les titres autorisés à télécharger, puis choisir Watching et/ou Plan to Watch, l’onglet de destination et les préférences communes. Chaque nouveau titre attend une validation dans Tofu ; les choix sont conservés par compte après redémarrage. Décocher un titre arrête immédiatement ses règles Tofu, sans changer son statut AniList ni supprimer les fichiers déjà téléchargés. Par exemple, laisser One Piece décoché l’exclut des téléchargements même s’il est en Watching sur AniList.

Le mode **Un thread par anime** propose une destination par titre à partir d’un dossier racine : `/video` donne `One Piece → /video/one-piece`. Cliquer **Préparer le suivi** pour vérifier les propositions, modifier le nom ou le dossier de chaque thread, ou choisir un thread existant. Le mode **Tous les animes dans le thread choisi** regroupe les téléchargements dans une seule destination, avec une règle par anime. Les préférences initiales ciblent Nyaa ; les sources restent modifiables. L’aperçu ne crée aucun dossier.

Les threads réutilisent les destinations du moteur Bun et les liens AniList existants entre identifiants de médias et règles. Un modèle distinct de thread demanderait une seconde gestion des dossiers. Les destinations choisies sont conservées lors des synchronisations et après redémarrage ; les titres validés ensuite suivent la même organisation. Les anciens suivis conservent leur destination commune.

Créer ensuite le suivi. La synchronisation utilise uniquement les titres validés, sans dupliquer leurs règles, exclut les épisodes déjà regardés et met en pause les titres retirés des listes choisies. Désactiver AniList ou supprimer son suivi arrête ses règles sans supprimer les téléchargements. Les suivis sont persistants, resynchronisés au démarrage et périodiquement.

Les [Route Handlers Next.js](https://nextjs.org/docs/app/guides/backend-for-frontend) et les [Server Functions TanStack Start](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions) constituent des alternatives pour le transport frontend/backend. Le téléchargement reste un travail de longue durée attaché à un processus et au disque : il doit survivre à la requête HTTP qui ajoute le torrent. L’API Elysia existante avec un moteur durable évite de remplacer Furin pour ce besoin.

Furin est installé depuis le registre avec une version publiée exacte : `@teyik0/furin@0.7.0-alpha.1`. `package.json` et `bun.lock` rendent l’installation reproductible ; aucune archive locale ni aucun lien vers le workspace Furin n’est requis. Aucun code du dépôt Furin n’est modifié. Eden est fixé à `2.0.0-beta.5`, y compris la dépendance transitive, pour rester compatible avec l’API plugin de Furin Sync. Pour une mise à jour, vérifier la nouvelle publication puis utiliser `bun add --exact @teyik0/furin@<version>` et relancer les validations.

Les dépendances natives de WebTorrent restent externes pendant les deux bundlings. `runtime/node_modules` est empaqueté avec l’application pour conserver les chemins de chargement des addons natifs. Le SDK `electrobun/main` reste externe pendant le build Furin, puis est résolu par Electrobun à partir de `.hutch/devkit`.

La passerelle vers le client tracker et les informations des wires se trouve exclusivement dans `src/server/webtorrent-stats.ts`. Elle est liée à **WebTorrent 3.0.21** ; une mise à jour du moteur doit repasser les tests trackers et pairs.

La pause retire le torrent du moteur en conservant son stockage, puis le recrée lors de la reprise. La méthode `torrent.pause()` seule de cette version conserve les connexions existantes et ne suffit pas à garantir l’arrêt des transferts. Les modifications de trackers reconstruisent également la découverte à partir des métadonnées en cache et des fichiers conservés, afin de retirer réellement les anciens trackers.

Les nouveaux torrents écrivent directement dans le dossier de destination, en conservant les sous-dossiers déclarés par le fichier .torrent. Les torrents déjà enregistrés gardent leur emplacement, y compris les anciens dossiers `<infohash>`. La suppression optionnelle retire uniquement les fichiers du torrent et conserve le dossier cible ainsi que les fichiers étrangers ou partagés. Deux torrents qui ciblent le même fichier ne peuvent pas télécharger simultanément : le second signale le conflit et conserve les données du premier.

## Données et configuration

Sur macOS :

- État : `~/Library/Application Support/Tofu/tofu.sqlite`.
- Plugins, clés, règles et suivis AniList : `~/Library/Application Support/Tofu/feeds.sqlite`.
- Téléchargements par défaut : `~/Downloads/Tofu/`.
- Adresse de l’instance en cours : `~/Library/Application Support/Tofu/server.json`.

Sur les autres systèmes, l’état utilise `~/.local/share/Tofu`.

Variables d’environnement facultatives : `TOFU_DATA_DIR`, `TOFU_DOWNLOAD_DIR`, `TOFU_PORT`, `TOFU_MODE=server|desktop`. `TOFU_DOWNLOAD_DIR` définit seulement le dossier initial : les préférences déjà enregistrées prennent ensuite le dessus. `HUTCH_HOME` peut désigner un cache Hutch partagé ; sinon il utilise `.cache/hutch` dans le projet.

## Validation

```sh
bun run tscheck
bun run fix
bun run test
bun run build
bun run build:desktop
bun run test:native
```

Les tests d’intégration utilisent des pairs TCP, de véritables trackers HTTP et des dossiers temporaires. Ils vérifient le téléchargement exact, la pause/reprise, les trackers, la persistance, les priorités, la suppression, les erreurs d’entrée, la vérification/réparation d’un fichier endommagé et le rejet d’une connexion entrante avec l’identifiant du client lui-même.

Le test natif lance le véritable `.app` avec un état temporaire et pilote son interface dans WKWebView : formulaires, trackers, pause/reprise, fichiers, préférences et suppression. Il vérifie le SHA-256 du fichier téléchargé, les polices locales, l’hydratation React et les erreurs JavaScript. Rapport : `.cache/native-smoke.json`. Il utilise un script injecté uniquement si `TOFU_SMOKE_SCRIPT` est explicitement défini ; l’application normale n’injecte aucun script de test.

Pour vérifier uniquement le formulaire d’organisation AniList dans la WebView : `TOFU_NATIVE_WORKFLOW=anilist bun run test:native`. Ce parcours valide le dossier racine, les préférences Nyaa, le choix entre un thread par anime et un thread commun, et l’absence de création avant validation des titres. Rapport : `.cache/native-anilist-smoke.json`. Les tests API couvrent les propositions, les overrides, les liens AniList, les transferts réels et la persistance.

Le dépôt de fichiers `.torrent` fonctionne dans toute la fenêtre. Dans un onglet de destination, le téléchargement démarre directement. Dans « Tous les torrents », un dialog permet de choisir un onglet existant ou d’en créer un avec son dossier. Les ajouts utilisent `useMutation` ; les lectures initiales restent dans les loaders Furin.

Le parcours natif vérifie le dépôt depuis la sidebar, l’annulation, les destinations existantes et nouvelles, et le SHA-256 des données téléchargées.

Il vérifie aussi les données du loader dans le HTML initial, une modification externe reçue via Furin Sync, la persistance du layout lors des navigations et le retour arrière, deux onglets partageant un dossier, le dossier choisi à l’ajout, le renommage et le changement de destination sans déplacement des fichiers.

`bun run bench:ui furin-sync` mesure les changements de sélection dans la fenêtre native pendant quatre transferts TCP locaux. Les profils et les fichiers sont temporaires. Il vérifie également que les détails en cache restent accessibles avec des réponses API retardées d’une seconde, sans retour à une ancienne sélection. Le passage actuel utilise quatre fichiers de 16 Mio. Rapport : `.cache/native-latency-furin-sync.json`. Fermer l’instance normale avant ces parcours natifs, puis la rouvrir avec `bun run desktop`.

## Limites du prototype

WebTorrent prend en charge les torrents BitTorrent v1 (hash SHA-1). Les torrents v2 seuls ne sont pas pris en charge. L’application native utilise une WebView système ; l’interface reste une interface React, ce ne sont pas des widgets AppKit.

Les plugins disponibles sont intégrés à Tofu : il n’y a pas encore de chargement de plugins tiers. Les catégories, la file d’attente du moteur, le rang de seeding, la disponibilité distribuée et le proxy configurable ne sont pas exposés. Le TCP est activé, l’uTP est désactivé dans cette version.

Les essais automatisés démontrent de vrais téléchargements locaux et une vraie découverte par tracker local. Ils ne constituent pas un benchmark de débit sur des essaims Internet. Seul le build macOS arm64 a été validé ; les builds Windows/Linux, la signature et la notarisation ne sont pas réalisés.

Une comparaison ponctuelle de mémoire et de transferts Internet avec la version installée de WebTorrent Desktop est documentée dans [BENCHMARK.md](BENCHMARK.md). Elle utilise quatre torrents et une fenêtre de trois minutes, avec les limites liées aux versions, à Rosetta et aux pairs disponibles.

## Documentation utilisée

Tofu est distribué sous [licence MIT](LICENSE.md), comme Furin. Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour les contributions, [SECURITY.md](SECURITY.md) pour les signalements privés et [CHANGELOG.md](CHANGELOG.md) pour les évolutions.

- [Electrobun : démarrer avec Bun](https://framework.blackboard.sh/electrobun/guides/hello-world-bun/), [migration v2](https://framework.blackboard.sh/electrobun/guides/migrating-to-v2/) et [configuration des builds](https://framework.blackboard.sh/electrobun/apis/cli/build-configuration/).
- [API WebTorrent](https://webtorrent.io/docs) et [API du client tracker](https://github.com/webtorrent/bittorrent-tracker).
- [Onglets de détails Deluge](https://github.com/deluge-torrent/deluge/blob/develop/deluge/ui/gtk3/torrentdetails.py), utilisés comme référence fonctionnelle.
- [SQLite dans Bun](https://bun.sh/docs/runtime/sqlite).
- [TypeSafe : API System One](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice) et [Noul](https://docs.typesafe.ai/primitives/noul).
- [AniList : connexion OAuth](https://docs.anilist.co/guide/auth/authorization-code) et [lecture des listes](https://docs.anilist.co/guide/graphql/queries/media-list).
- [Flux Nyaa](https://nyaa.si/?page=rss), [flux officiel Tsundere-Raws](https://tsundere.to/api/v1/feed.json?provider=nyaa.si&limit=250) et [API C411](https://c411.org/api/torznab).
