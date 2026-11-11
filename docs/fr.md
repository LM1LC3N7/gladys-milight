# MiLight

Pilotez des lampes **MiLight / LimitlessLED** (aussi vendues sous les noms
Easybulb, LimitlessLED, Boxlight…) par leur **pont Wi-Fi**, sur le réseau
local : allumer, éteindre, luminosité, couleur et température du blanc.

Intégration non officielle, sans lien avec MiLight, Futlight ou
LimitlessLED. Elle n’a **jamais été testée avec un vrai pont** : elle est
écrite d’après le protocole publié par LimitlessLED et testée contre un pont
simulé seulement.

## Ce qu’il faut

- Un pont Wi-Fi MiLight déjà installé avec l’application officielle, avec une
  adresse IP fixe (réservation DHCP dans votre box) :
  - **v6** : iBox 1 (le pont avec une lampe dessus), iBox 2 et les ponts
    vendus depuis 2016 (port UDP 5987) ;
  - **ancien** : les ponts Wi-Fi v3 à v5 (port UDP 8899).
- Vos lampes appairées aux zones (groupes 1 à 4) du pont avec la
  télécommande ou l’application officielle.

## Configuration

1. **Adresse IP du pont** : l’adresse IPv4 du pont, par exemple
   `192.168.1.50` (ajoutez `:port` seulement si vous l’avez changé). Une
   adresse de diffusion, de multidiffusion ou de réseau (finissant par `.255`
   ou `.0`) est refusée : les commandes ne partent que vers le pont.
2. **Modèle du pont** : v6 ou ancien.
3. **Zones** : cochez les zones de chaque sorte de lampe :
   - **RGB+CCT** (couleur et blanc réglable, aussi vendues RGBWW) :
     allumage, luminosité, couleur, température du blanc (2700 K à 6500 K).
     Pont v6 seulement.
   - **RGBW** (couleur et un seul blanc) : allumage, luminosité, couleur (une
     couleur proche du blanc passe sur la LED blanche).
   - **Blanc double** (CCT) : allumer et éteindre seulement. Leur luminosité
     et leur température sont des pas vers le haut ou le bas sur la
     télécommande, jamais un niveau : Gladys ne peut pas les régler.
   - **Lampe du pont iBox 1** : allumage, luminosité, couleur. Pont v6
     seulement.
4. Enregistrez, puis ajoutez les lampes depuis l’onglet **Découverte**.

Un appareil Gladys par sorte et par zone : toutes les ampoules appairées à
une zone obéissent ensemble. Les identifiants des appareils ne dépendent que
de la sorte et de la zone, pas de l’adresse : une nouvelle adresse garde vos
appareils.

## L’état est supposé, jamais confirmé

Les ampoules MiLight reçoivent leurs ordres par radio et **ne répondent
jamais**. Rien ne peut dire à Gladys si une ampoule est vraiment allumée, ni
sa luminosité ou sa couleur :

- Gladys affiche la **dernière commande envoyée**, un **état supposé**. Le
  badge de chaque lampe le dit (point orange).
- Un pont **v6** accuse réception de chaque ordre : la commande réussit quand
  le pont l’a reçue (le pont, pas forcément l’ampoule, hors de portée ou
  débranchée). Sans accusé de réception, la commande échoue avec « envoyée,
  le pont n’a pas accusé réception » (l’ampoule a pu changer quand même).
- Un pont **ancien** ne répond jamais : une commande réussit dès qu’elle a
  quitté le serveur. L’intégration ne peut pas savoir si le pont l’a reçue.
- Une ampoule commandée avec la télécommande ou l’application officielle
  n’est pas vue par Gladys.

## Éteindre

« Éteindre » est traité comme la commande sûre :

- elle passe **devant toutes les autres commandes** et annule celles de la
  même lampe encore en attente (rien de cliqué avant elle ne part après
  elle) ;
- elle est **envoyée trois fois** (tout de suite, puis 0,5 s et 1,5 s après),
  car un ordre radio peut se perdre ; un renvoi n’est sauté que si une
  commande plus récente de cette lampe est déjà partie ;
- elle ne dépend d’aucune option, d’aucune limite de file, d’aucune
  vérification de l’identité du pont ni de la lecture de la configuration :
  l’adresse du pont est aussi gardée dans le stockage de l’intégration, donc
  un « éteindre » part même avant que la configuration soit lue ;
- sans accusé de réception d’un pont v6 (ou pas envoyée du tout), elle
  échoue avec un message qui le dit, et elle est **renvoyée toutes les 30 s
  pendant 10 min** après le clic, redémarrage de l’intégration compris. Elle
  s’arrête dès que le pont en accuse réception (Gladys affiche alors la lampe
  éteinte) ou qu’une commande plus récente de cette lampe part. Le badge de
  la lampe dit qu’elle attend, puis « jamais confirmée » après 10 min.

Un « éteindre » n’est refusé que si aucune adresse de pont n’est connue (pas
encore configurée), si la lampe n’existe pas sur cette sorte de pont (une
lampe RGB+CCT ou la lampe de l’iBox 1 sur un pont ancien), ou pendant
l’arrêt de l’intégration.

## Autres commandes

Allumer, luminosité, couleur et température :

- demandent la configuration lue et la zone cochée ;
- allument d’abord la lampe (un ordre MiLight à une zone l’allume aussi),
  Gladys affiche donc ensuite la lampe allumée ;
- partent une toutes les 100 ms au plus (le pont perd les ordres envoyés plus
  vite) et reçoivent une réponse sous 3,5 s (Gladys n’attend que 5 s) : une
  commande qui n’a pas pu partir à temps échoue avec « rien envoyé » ;
- sur un pont v6, sont refusées tant que le stockage de l’intégration est
  illisible, et tant qu’un autre pont répond à l’adresse (voir plus bas).

## Identité d’un pont v6

Le pont v6 donne son adresse MAC à chaque session. La première vue est
gardée. Si un autre pont répond plus tard à l’adresse (un bail DHCP passé à
un autre pont), seul « éteindre » lui est envoyé et l’état de la connexion
affiche les deux adresses MAC. Si vous avez remplacé votre pont, appuyez
deux fois sur **Tester le pont** en moins de 2 minutes pour accepter le
nouveau.

## Tester le pont

- v6 : demande une session au pont et affiche son adresse MAC (au plus une
  fois toutes les 5 s).
- ancien : le pont ne répond jamais, il n’y a rien à tester : allumez une
  lampe.

## Réseau et vie privée

- Réseau local seulement, UDP, sans compte, sans cloud, sans mot de passe.
- Un pont v6 est vérifié (une demande de session) au plus toutes les
  5 minutes, et pas du tout si une commande lui a parlé entre-temps.
- Le stockage de l’intégration (`/data`) garde l’adresse du pont, son adresse
  MAC, les « éteindre » en attente et l’heure de la dernière vérification.

## Limites

- Un seul pont par intégration.
- La zone 0 (« toutes les zones ») de la télécommande, le mode nuit, les
  effets (disco) et l’appairage des ampoules ne sont pas disponibles (voir le
  TODO du projet).
- La roue des couleurs des ampoules v6 vient d’une bibliothèque libre
  (node-milight-promise) et n’a pas été vérifiée sur une vraie ampoule : une
  couleur peut être un peu décalée.
