# Benchmark de Tofu et WebTorrent Desktop

Mesure réalisée le 4 octobre 2026 sur le MacBook Air M2, 8 Go de RAM, avec les quatre fichiers torrent présents dans Downloads : **2,55 Gio** au total. Tofu utilise ici **66,4 % de mémoire en moins en médiane pendant la fenêtre de téléchargement** que la version installée de WebTorrent Desktop. Cette comparaison porte sur les deux applications complètes et leurs versions actuelles sur cette machine.

## Applications comparées

| Application | Interface et moteur | Architecture | Processus mesurés |
| --- | --- | --- | --- |
| Tofu 0.1.0 | Electrobun 2.0.2, WKWebView système, Bun 1.4.2, WebTorrent 3.0.21 | arm64 natif | 5 : launcher, Bun, WebContent, GPU, Networking |
| WebTorrent Desktop 0.24.0 installé | Electron 10.1.0, Chromium 85, WebTorrent 0.108.6 | Intel x64 via Rosetta | 6 : application, deux renderers, GPU, réseau, crash reporter |

Les versions ont été vérifiées dans les fichiers locaux et dans le moteur exécuté. WebTorrent Desktop est ancien et son moteur diffère de celui de Tofu : le résultat ne permet pas d'attribuer tout l'écart à Electrobun, ni de comparer tous les clients Electron récents. Deluge et qBittorrent n'ont pas été mesurés.

## Méthode

Les applications ont été exécutées successivement avec des profils distincts et des dossiers de téléchargement neufs, sans réutiliser les fichiers de l'autre application. Le dossier habituel de Tofu et l'installation originale de WebTorrent sont conservés. Pour isoler le profil de WebTorrent Desktop, une copie APFS de son application a été utilisée ; seul le chemin de configuration dans cette copie a été adapté à une variable d'environnement, puis la copie a été signée localement. Les moteurs, les binaires et le mode production de l'application ont été conservés.

Les deux fenêtres ont reçu une taille demandée de 1400 × 940. Le système peut ajuster la hauteur au bureau disponible. Les limites de bande passante sont celles par défaut, sans bridage ; Tofu utilise TCP avec uTP désactivé, WebTorrent Desktop conserve sa configuration réseau native. Le nombre de connexions autorisées et les stratégies de cache peuvent différer entre ces versions.

Le relevé commence une fois l'application ouverte : 15 secondes avec une liste vide, quatre téléchargements lancés simultanément pendant une fenêtre cible de 180 secondes, puis environ 20 secondes supplémentaires de transfert et 15 secondes de pause globale. Les durées constatées de la fenêtre de téléchargement sont **184,3 s pour Tofu** et **180,7 s pour WebTorrent Desktop**, à cause du temps des requêtes et de l'échantillonnage. Les trois minutes ne correspondent pas au téléchargement intégral des quatre fichiers.

La mémoire est le **total physical footprint** de l'ensemble des processus, fourni par l'outil macOS `footprint --noCategories --swapped -j`. Il inclut les pages compressées et tient compte des partages entre les processus sélectionnés. Les données contiennent 167 mesures pour Tofu et 185 pour WebTorrent Desktop, avec un intervalle médian de 1 s et 1 s. Certains relevés prennent plus longtemps sous charge. Le pic est le **plus haut total observé lors d'un relevé**, pas une borne maximale garantie pour toutes les utilisations. Les pics individuels des processus n'ont pas été additionnés.

Les débits et la progression ont été lus par l'API de Tofu et le moteur réel de la fenêtre cachée de WebTorrent Desktop. La mesure mémoire de WebTorrent reste indépendante des réponses du moteur, afin de mesurer également ses blocages. Le CPU est la somme des valeurs `ps %cpu` des processus, donc une indication lissée ; 100 % représente un cœur et non la machine entière.

## Résultats

| Mesure | Tofu | WebTorrent Desktop installé |
| --- | ---: | ---: |
| Mémoire au repos avec liste vide, médiane | 188,6 Mio | 297,2 Mio |
| Mémoire en téléchargement, médiane | 344,7 Mio | 1 026 Mio |
| Pic mémoire observé, toutes phases | 388,1 Mio | 1 144,2 Mio |
| Mémoire après pause globale, médiane | 307,8 Mio | 1 033 Mio |
| CPU pendant le téléchargement, médiane | 78,7 % d'un cœur | 43,7 % d'un cœur |
| Plus haut débit mesuré sur la fenêtre | 42,6 Mio/s | 104,8 Mio/s |
| Données de fichiers téléchargées au terme de la fenêtre | 1,8 Gio | 1,2 Gio |
| Taille de l'application sur disque, `du -sh` | 114 Mio | 206 Mio |

Le CPU et le débit ne constituent pas une comparaison contrôlée de rendement : les deux passes successives rencontrent des pairs différents et ne reçoivent pas exactement le même volume. Les listes vides et les versions différentes limitent aussi l'interprétation de la mémoire. La mémoire après pause peut rester supérieure au repos initial : les moteurs et les runtimes conservent une partie de leurs allocations.

## Progression au terme des trois minutes

| Torrent | Taille en Mio | Tofu | WebTorrent Desktop |
| --- | ---: | ---: | ---: |
| I Became a Legend After My 10 Year-Long Last Stand S01E03 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) | 699,4 | 68,55 % | 0 % |
| I Became a Legend After My 10 Year-Long Last Stand S01E01 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) | 694,3 | 21,7 % | 99,99 % |
| Tougen.Anki.S02E01.VOSTFR.1080p.WEBRiP.x265-KAF_(NYAA) | 522,2 | 100 % | 100 % |
| I Became a Legend After My 10 Year-Long Last Stand S01E02 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) | 699,2 | 99,48 % | 0 % |

WebTorrent Desktop n'a reçu aucune pièce pour deux torrents pendant cette passe, bien qu'ils aient des pairs connectés. Cette différence limite la comparaison de charge et de débit. La progression du moteur et ses bitfields de pièces ont été relevés. Les transferts poursuivis pendant les 20 secondes suivantes peuvent terminer un fichier de plus ; les valeurs du tableau sont celles enregistrées à la fin de la fenêtre principale. Les vérifications hors ligne des pièces et les éventuels SHA-256 de fichiers complets sont dans [integrity.json](.cache/desktop-bench/integrity.json).

## Réception après 100 pour cent

Sur le torrent déjà terminé dans le profil habituel, tous les 454 morceaux étaient vérifiés alors que les octets réseau continuaient à augmenter. Deux connexions utilisaient le propre identifiant de pair de Tofu, dont une via son adresse publique. Le contrôle anti-boucle interne de WebTorrent 3.0.21 compare l'identifiant à `torrent.peerId`, tandis que l'identifiant existe sur `torrent.client.peerId`.

Le correctif dans [engine.ts](src/server/engine.ts) rejette un wire portant l'identifiant du client et retire son adresse des pairs candidats. Le test [self-peer.test.ts](tests/self-peer.test.ts) envoie un vrai handshake TCP entrant avec cet identifiant : il échoue avant correction et passe après. Dix tests d'intégration, 52 assertions, la vérification TypeScript, le lint et le build passent ; les dix vérifications dans la vraie fenêtre native passent aussi.

Un faible trafic peut encore exister à 100 % : les débits de WebTorrent comptent les messages du protocole échangés entre pairs, pas uniquement le contenu des fichiers. Le correctif conserve le seeding. Forcer le débit affiché à zéro à 100 % cacherait ce trafic ; arrêter les connexions empêcherait le partage. Le rejet du propre identifiant est le changement recommandé pour cette anomalie.

Après redémarrage de Tofu avec le profil habituel, les 454/454 pièces du fichier restent vérifiées. Le relevé conserve un débit réseau d'environ 7 Kio/s, mais aucun octet de contenu téléchargé supplémentaire et aucun octet de contenu reçu sur les wires observés. Les connexions vers le propre client ne sont plus présentes. La boucle était une anomalie réelle, mais elle ne suffit donc pas à expliquer tout le trafic affiché à 100 %. Relevé : [speed-after.json](.cache/speed-after.json).

## Recommandation et limites

Garder l'architecture actuelle Furin et WebTorrent dans Bun avec la WebView native est cohérent avec ces résultats. Il n'est pas nécessaire de reconstruire le moteur ou de remplacer le runtime pour résoudre la boucle. Pour isoler l'effet du runtime, un autre protocole de benchmark devrait utiliser la même version de WebTorrent, la même architecture arm64, les mêmes options réseau et un essaim local contrôlé sur les deux applications.

Cette passe mesure une charge Internet réelle et bornée avec quatre torrents, sans répétitions statistiques ni mesure exhaustive du démarrage à froid. Le pic pourra être supérieur avec davantage de torrents, de pairs, de fichiers, du trafic ou des actions d'interface. Les mesures ne prouvent pas un gain universel sur Deluge, qBittorrent ou une version plus récente de WebTorrent Desktop.

Données brutes : [Tofu](.cache/desktop-bench/tofu-result.json), [WebTorrent Desktop](.cache/desktop-bench/wt-result.json), [résumé](.cache/desktop-bench/summary.json). Le script ponctuel utilisé est [run.ts](.cache/desktop-bench/run.ts), exécuté sous Bun ; ses profils doivent être neufs pour refaire une passe.

Documentation : [API WebTorrent](https://webtorrent.io/docs), code réellement installé dans `node_modules/webtorrent/lib/peer.js` et `/Applications/WebTorrent.app/Contents/Resources/app.asar`, aide locale de `footprint` et `ps`. [Electrobun et la WebView système](https://framework.blackboard.sh/electrobun/apis/bundling-cef/).

## Interface shadcn et sélection des torrents — 4 octobre 2026

Le parcours [native-latency.ts](scripts/native-latency.ts), exécuté avec Bun dans la vraie WKWebView, ajoute quatre fichiers aléatoires de 8 Mio servis par TCP local. La réception globale est limitée à 512 Kio/s pour conserver quatre transferts actifs pendant les mesures. Après consultation initiale des quatre torrents, il mesure seize changements de sélection. Les temps incluent l’observation du DOM et l’attente des frames ; la mesure des détails attend une frame supplémentaire après celle de la sélection.

| Mesure | Ancienne interface | Interface shadcn |
| --- | ---: | ---: |
| Sélection, médiane | 16 ms | 17 ms |
| Sélection, p95 | 33 ms | 65 ms |
| Détails, médiane | 33 ms | 34 ms |
| Détails, p95 | 50 ms | 79 ms |

Ce petit échantillon local ne démontre pas une amélioration de la latence normale : les médianes sont proches et les valeurs hautes sont plus variables avec la nouvelle interface. Il ne reproduit pas un essaim Internet ni un grand nombre de fichiers/pairs. Il ne faut pas en déduire un gain universel de vitesse ou de mémoire.

Une vérification supplémentaire retarde artificiellement les réponses API d’une seconde : les quatre changements vers des détails déjà consultés prennent 33 ms en médiane, avec un maximum de 49 ms. Après libération des réponses, la dernière sélection reste affichée. Ce test valide que la sélection en cache ne dépend plus de la durée du rafraîchissement HTTP.

Le moteur calcule désormais les résumés de tous les torrents et les listes de fichiers, pairs et pièces du seul torrent consulté. Les écritures périodiques sont regroupées toutes les cinq secondes. L’interface conserve les détails consultés, annule les requêtes d’anciennes sélections, actualise les statistiques dans une transition React et évite de bloquer toutes les actions pendant une opération individuelle.

Validation : 14 tests d’intégration, 77 assertions, 14 vérifications dans la fenêtre native, TypeScript, lint et build macOS arm64. Données : [avant](.cache/native-latency-before.json), [après](.cache/native-latency-after.json), [parcours natif](.cache/native-smoke.json).

## Pages natives et Furin Sync — 4 octobre 2026

La bibliothèque passe aux routes et au layout partagé de Furin. Les loaders servent les données initiales, les détails utilisent `defer`/Suspense et `useQuery`, et Furin Sync remplace le polling React. Une première mesure a révélé que placer `Await` avant la lecture du cache imposait parfois environ 300 ms d’attente sur des détails déjà consultés. Le cache est maintenant lu en priorité ; Suspense intervient si les données manquent.

Le passage final utilise quatre fichiers de **16 Mio**, au lieu de 8 Mio, afin de conserver les quatre transferts actifs. Le débit global reste limité à 512 Kio/s. Seize changements sont mesurés après consultation des quatre torrents, dans la vraie WKWebView visible. Il s’agit d’un petit essai local, pas d’une comparaison universelle de performance.

| Mesure | Pages natives + Sync |
| --- | ---: |
| Sélection, médiane / p95 | 17 / 33 ms |
| Détails en cache, médiane / p95 | 34 / 49 ms |
| Détails en cache avec réponses retardées de 1 s, médiane / maximum | 34 / 34 ms |

Les quatre téléchargements étaient encore actifs à la fin ; la dernière sélection reste correcte après les réponses retardées. Un passage avec WebView masquée a expiré et a été écarté. Rapport final : [native-latency-furin-sync.json](.cache/native-latency-furin-sync.json).

Validation : **15 tests d’intégration, 83 assertions, 19 vérifications natives**, TypeScript, lint et build macOS arm64. Le parcours natif vérifie notamment le HTML initial rempli, une modification externe reçue automatiquement via Sync, le maintien de la sidebar pendant la navigation et le retour arrière. Rapport : [native-smoke.json](.cache/native-smoke.json).
