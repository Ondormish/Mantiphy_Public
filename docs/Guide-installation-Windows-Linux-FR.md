# Guide d'installation Windows & Linux FR

*[English version](Guide-installation-Windows-Linux-EN.md)*

## Avant de commencer

Mantiphy est une photothèque et un éditeur RAW gratuits, dans l'esprit de Lightroom Classic. Il tourne sous Linux ; sous Windows, il s'installe dans WSL, le Linux intégré à Windows 10 et 11.

| | Linux | Windows 10 / 11 |
| --- | --- | --- |
| Méthode | Installation directe | Via WSL (Linux intégré à Windows) |
| Temps | 5 à 10 min | 15 à 25 min, redémarrage compris |
| Espace disque | ≈ 200 Mo (+ 1 à 5 Go avec les options IA) | ≈ 2 Go pour WSL + ≈ 200 Mo pour Mantiphy |
| Navigateur | Chrome, Chromium, Brave, Edge ou Firefox | Edge ou Chrome (déjà sur Windows) |

Il faut une connexion Internet pour l'installation, puis plus du tout pour retoucher. Vos photos ne quittent jamais votre ordinateur.

Partout où vous voyez un bloc de code, copiez-le tel quel dans le terminal et appuyez sur Entrée. Le terminal demande parfois votre mot de passe : c'est normal, les caractères ne s'affichent pas quand vous le tapez.

## Installer sur Linux

Quatre commandes suffisent. Ouvrez un terminal (Konsole, GNOME Terminal…).

1. Installez Git et Python, selon votre distribution :
    - Ubuntu, Debian, Linux Mint, Pop!_OS : `sudo apt install git python3-venv`
    - Fedora, Nobara : `sudo dnf install git python3`
    - Arch, Manjaro, CachyOS : `sudo pacman -S --needed git python`
2. Téléchargez Mantiphy dans votre dossier personnel :

    ```bash
    cd ~ && git clone https://github.com/Ondormish/Mantiphy_Public.git mantiphy
    ```

3. Lancez-le :

    ```bash
    cd ~/mantiphy && ./run.sh
    ```

    Le premier lancement installe ses composants (une à deux minutes), puis Mantiphy s'ouvre dans sa propre fenêtre. Sans Chrome, Chromium, Brave ou Edge, il s'ouvre dans votre navigateur habituel, à l'adresse http://127.0.0.1:7878.

4. Ajoutez Mantiphy au menu des applications, pour ne plus passer par le terminal :

    ```bash
    cd ~/mantiphy && ./run.sh --install-desktop
    ```

Mantiphy apparaît alors dans le menu, avec son icône. Pour commencer, cliquez sur **Import a folder** et choisissez un dossier de photos : elles restent où elles sont, rien n'est copié.

## Installer sur Windows

Sous Windows, Mantiphy tourne dans WSL, un Linux fourni par Microsoft, et s'affiche dans Edge ou Chrome. Il faut Windows 10 (version 2004 ou plus récente) ou Windows 11.

> Les commandes Ubuntu de cette partie ont été vérifiées dans un Ubuntu 24.04 vierge, celui qu'installe WSL. Le parcours complet n'a pas encore été testé sur un vrai PC Windows : si quelque chose coince, [ouvrez une issue](https://github.com/Ondormish/Mantiphy_Public/issues).

### Étape 1 : installer WSL (une seule fois)

1. Clic droit sur le bouton Démarrer, puis **Terminal (administrateur)** (sur Windows 10 : **Windows PowerShell (admin)**).
2. Tapez cette commande, puis redémarrez l'ordinateur quand elle a fini :

    ```powershell
    wsl --install
    ```

3. Après le redémarrage, une fenêtre **Ubuntu** s'ouvre et termine l'installation. Choisissez un nom d'utilisateur et un mot de passe (en minuscules, sans espace), et notez-les : ce mot de passe vous sera demandé à l'étape 2.

### Étape 2 : installer Mantiphy

Dans la fenêtre Ubuntu (ensuite, retrouvez-la dans le menu Démarrer en tapant « Ubuntu »), collez ces deux commandes l'une après l'autre (clic droit pour coller) :

```bash
sudo apt update && sudo apt install -y git python3-venv
```

```bash
cd ~ && git clone https://github.com/Ondormish/Mantiphy_Public.git mantiphy
```

### Étape 3 : lancer Mantiphy

```bash
cd ~/mantiphy && ./run.sh
```

Le premier lancement installe ses composants (une à deux minutes). Si le navigateur ne s'ouvre pas tout seul et que le terminal affiche `Open http://127.0.0.1:7878 in your browser`, ouvrez Edge ou Chrome sous Windows et allez à l'adresse **http://127.0.0.1:7878**. Ajoutez-la à vos favoris.

Laissez la fenêtre Ubuntu ouverte tant que vous utilisez Mantiphy : c'est elle qui le fait tourner. Pour l'arrêter, appuyez sur Ctrl+C dans cette fenêtre ou fermez-la. Pour le relancer plus tard : ouvrez Ubuntu, retapez la commande de l'étape 3, puis rouvrez votre favori.

### Étape 4 : retrouver vos photos Windows

Dans Mantiphy, cliquez sur **Import a folder**. Vos disques Windows se trouvent dans `/mnt` : le disque C: est `/mnt/c`, le disque D: est `/mnt/d`. Vos images sont en général dans :

```text
/mnt/c/Users/VotreNomWindows/Pictures
```

Les photos restent sur le disque Windows ; rien n'est copié. La lecture y est un peu plus lente que sous Linux, surtout au premier import d'un gros dossier.

## Options facultatives

La retouche de base fonctionne sans rien ajouter. Chaque option s'installe une fois, en ajoutant son mot-clé au lancement, par exemple `./run.sh --with-ai` ; ensuite, `./run.sh` suffit.

| Mot-clé | Ce que ça ajoute | Taille |
| --- | --- | --- |
| `--with-ai` | Masques IA (sujet, personnes, ciel) et réduction du bruit | ≈ 300 Mo, plus les modèles téléchargés au premier usage |
| `--with-heal` | Suppression d'objets (effacer une branche, une poussière…) | 2 à 5 Go |
| `--with-hdr` | Fusion HDR de photos bracketées | ≈ 100 Mo |
| `--with-panorama` | Assemblage de panoramas | ≈ 100 Mo |
| `--with-camera-profile` | Calibration couleur avec une mire ColorChecker | ≈ 100 Mo |
| `--with-all` | Toutes les options ci-dessus | 3 à 6 Go |
| `--with-ai-gpu` | Fait tourner l'IA sur la carte graphique | variable |

La première utilisation de chaque fonction IA télécharge son modèle : l'application peut sembler figée une à plusieurs minutes, laissez-la travailler.

Sans carte graphique compatible, tout fonctionne sur le processeur, simplement plus lentement. `--with-ai-gpu` s'installe tout seul avec une carte NVIDIA. Avec une carte AMD sous Linux, il faut en plus les bibliothèques ROCm de votre distribution : la commande vous indique quoi installer. Sous Windows (WSL), restez sur le processeur si vous débutez.

## Mettre à jour et désinstaller

**Mettre à jour** (Linux, ou fenêtre Ubuntu sous Windows), puis relancer Mantiphy :

```bash
cd ~/mantiphy && git pull
```

Vos photos, notes et retouches sont conservées. Les nouvelles versions sont annoncées sur la page [Releases](https://github.com/Ondormish/Mantiphy_Public/releases) ; cliquez sur **Watch → Custom → Releases** pour être prévenu.

**Désinstaller sur Linux** : supprimez l'application, son catalogue et son cache.

```bash
rm -rf ~/mantiphy ~/.local/share/mantiphy ~/.cache/mantiphy ~/.local/share/applications/mantiphy.desktop
```

Vos photos ne sont pas touchées. À côté des photos retouchées restent de petits fichiers `.mantiphy.json` et `.xmp`, que vous pouvez garder ou supprimer.

**Désinstaller sur Windows** : la même commande dans la fenêtre Ubuntu retire Mantiphy seul. Pour supprimer tout Ubuntu, tapez `wsl --unregister Ubuntu` dans PowerShell ; attention, cela efface définitivement tout ce qui se trouve dans Ubuntu, mais pas vos photos sur le disque C:.

## Problèmes courants

| Ce que vous voyez | Solution |
| --- | --- |
| `No module named venv` ou `ensurepip is not available` | Installez le paquet manquant : `sudo apt install python3-venv`, puis supprimez le dossier `~/mantiphy/.venv` et relancez `./run.sh`. |
| `git: command not found` | Git n'est pas installé : reprenez l'étape 1 de votre système. |
| `Permission denied` sur `./run.sh` | Tapez `chmod +x ~/mantiphy/run.sh`, puis relancez. |
| La page affiche `Forbidden host` | Utilisez exactement l'adresse http://127.0.0.1:7878 (ou http://localhost:7878) : pour votre sécurité, Mantiphy refuse toute autre adresse. |
| `address already in use` | Mantiphy tourne déjà (fenêtre oubliée), ou un autre logiciel utilise le port 7878. Fermez l'autre fenêtre, ou lancez `MANTIPHY_PORT=7879 ./run.sh` et ouvrez http://127.0.0.1:7879. |
| `WebGL2 is required` | Activez l'accélération matérielle du navigateur (Paramètres → Système), ou essayez Chrome ou Edge. |
| L'application semble figée au premier masque IA ou à la première réduction du bruit | Normal : elle télécharge le modèle. Attendez quelques minutes. |
| Windows : la page ne s'ouvre pas | Vérifiez que la fenêtre Ubuntu est ouverte et que la commande `./run.sh` y tourne toujours. |
| Windows : `wsl --install` affiche l'aide au lieu d'installer | WSL est déjà présent : tapez `wsl --install -d Ubuntu`. |

Un autre problème ? Ouvrez une demande sur la page [Issues](https://github.com/Ondormish/Mantiphy_Public/issues) du projet, en copiant le message affiché dans le terminal.
