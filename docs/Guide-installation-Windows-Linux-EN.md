# Installation Guide Windows & Linux EN

*[Version française](Guide-installation-Windows-Linux-FR.md)*

## Before you start

Mantiphy is a free photo library and RAW editor, in the spirit of Lightroom Classic. It runs on Linux; on Windows, it installs inside WSL, the Linux built into Windows 10 and 11.

| | Linux | Windows 10 / 11 |
| --- | --- | --- |
| Method | Direct install | Through WSL (Linux built into Windows) |
| Time | 5 to 10 min | 15 to 25 min, including a restart |
| Disk space | ≈ 200 MB (+ 1 to 5 GB with the AI options) | ≈ 2 GB for WSL + ≈ 200 MB for Mantiphy |
| Browser | Chrome, Chromium, Brave, Edge or Firefox | Edge or Chrome (already on Windows) |

You need an Internet connection to install it, then none at all to edit. Your photos never leave your computer.

Wherever you see a code block, copy it as is into the terminal and press Enter. The terminal sometimes asks for your password: that is normal, and nothing appears on screen while you type it.

## Install on Linux

Four commands are enough. Open a terminal (Konsole, GNOME Terminal…).

1. Install Git and Python for your distribution:
    - Ubuntu, Debian, Linux Mint, Pop!_OS: `sudo apt install git python3-venv`
    - Fedora, Nobara: `sudo dnf install git python3`
    - Arch, Manjaro, CachyOS: `sudo pacman -S --needed git python`
2. Download Mantiphy into your home folder:

    ```bash
    cd ~ && git clone https://github.com/Ondormish/Mantiphy_Public.git mantiphy
    ```

3. Start it:

    ```bash
    cd ~/mantiphy && ./run.sh
    ```

    The first start installs its components (one to two minutes), then Mantiphy opens in its own window. Without Chrome, Chromium, Brave or Edge, it opens in your usual browser at http://127.0.0.1:7878.

4. Add Mantiphy to your application menu, so you no longer need the terminal:

    ```bash
    cd ~/mantiphy && ./run.sh --install-desktop
    ```

Mantiphy now shows up in the menu with its icon. To begin, click **Import a folder** and pick a folder of photos: they stay where they are, nothing is copied.

## Install on Windows

On Windows, Mantiphy runs inside WSL, a Linux provided by Microsoft, and shows up in Edge or Chrome. You need Windows 10 (version 2004 or later) or Windows 11.

> The Ubuntu commands in this part were checked on a clean Ubuntu 24.04, the one WSL installs. The full path has not been tested on a real Windows PC yet: if something gets stuck, [open an issue](https://github.com/Ondormish/Mantiphy_Public/issues).

### Step 1: install WSL (once)

1. Right-click the Start button, then **Terminal (Admin)** (on Windows 10: **Windows PowerShell (Admin)**).
2. Type this command, then restart the computer when it is done:

    ```powershell
    wsl --install
    ```

3. After the restart, an **Ubuntu** window opens and finishes the setup. Pick a user name and a password (lowercase, no spaces) and write them down: the password is asked for in step 2.

### Step 2: install Mantiphy

In the Ubuntu window (later, find it in the Start menu by typing "Ubuntu"), paste these two commands one after the other (right-click to paste):

```bash
sudo apt update && sudo apt install -y git python3-venv
```

```bash
cd ~ && git clone https://github.com/Ondormish/Mantiphy_Public.git mantiphy
```

### Step 3: start Mantiphy

```bash
cd ~/mantiphy && ./run.sh
```

The first start installs its components (one to two minutes). If no browser opens by itself and the terminal shows `Open http://127.0.0.1:7878 in your browser`, open Edge or Chrome on Windows and go to **http://127.0.0.1:7878**. Bookmark it.

Keep the Ubuntu window open while you use Mantiphy: it is what runs it. To stop it, press Ctrl+C in that window or close it. To start it again later: open Ubuntu, type the step 3 command again, then open your bookmark.

### Step 4: find your Windows photos

In Mantiphy, click **Import a folder**. Your Windows drives are under `/mnt`: drive C: is `/mnt/c`, drive D: is `/mnt/d`. Your pictures are usually in:

```text
/mnt/c/Users/YourWindowsName/Pictures
```

The photos stay on the Windows drive; nothing is copied. Reading them is a little slower than on Linux, mostly on the first import of a large folder.

## Optional features

Basic editing works with nothing added. Each option is installed once, by adding its keyword when you start Mantiphy, for example `./run.sh --with-ai`; after that, `./run.sh` is enough.

| Keyword | What it adds | Size |
| --- | --- | --- |
| `--with-ai` | AI masks (subject, people, sky) and noise reduction | ≈ 300 MB, plus models downloaded on first use |
| `--with-heal` | Object removal (erase a branch, a dust spot…) | 2 to 5 GB |
| `--with-hdr` | HDR merge of bracketed photos | ≈ 100 MB |
| `--with-panorama` | Panorama stitching | ≈ 100 MB |
| `--with-camera-profile` | Colour calibration from a ColorChecker chart | ≈ 100 MB |
| `--with-all` | All the options above | 3 to 6 GB |
| `--with-ai-gpu` | Runs the AI on the graphics card | varies |

The first use of each AI feature downloads its model: the app may look frozen for one to several minutes, let it work.

Without a compatible graphics card, everything runs on the processor, just more slowly. `--with-ai-gpu` sets itself up with an NVIDIA card. With an AMD card on Linux, you also need your distribution's ROCm libraries: the command tells you what to install. On Windows (WSL), stay on the processor if you are just starting out.

## Update and uninstall

**Update** (Linux, or the Ubuntu window on Windows), then restart Mantiphy:

```bash
cd ~/mantiphy && git pull
```

Your photos, ratings and edits are kept. New versions are announced on the [Releases](https://github.com/Ondormish/Mantiphy_Public/releases) page; click **Watch → Custom → Releases** to be notified.

**Uninstall on Linux**: remove the app, its catalog and its cache.

```bash
rm -rf ~/mantiphy ~/.local/share/mantiphy ~/.cache/mantiphy ~/.local/share/applications/mantiphy.desktop
```

Your photos are not touched. Small `.mantiphy.json` and `.xmp` files remain next to edited photos; keep or delete them as you like.

**Uninstall on Windows**: the same command in the Ubuntu window removes Mantiphy alone. To remove Ubuntu entirely, type `wsl --unregister Ubuntu` in PowerShell; careful, this permanently erases everything inside Ubuntu, but not your photos on drive C:.

## Common problems

| What you see | Fix |
| --- | --- |
| `No module named venv` or `ensurepip is not available` | Install the missing package: `sudo apt install python3-venv`, then delete the `~/mantiphy/.venv` folder and run `./run.sh` again. |
| `git: command not found` | Git is not installed: redo step 1 for your system. |
| `Permission denied` on `./run.sh` | Type `chmod +x ~/mantiphy/run.sh`, then start it again. |
| The page shows `Forbidden host` | Use exactly http://127.0.0.1:7878 (or http://localhost:7878): for your safety, Mantiphy refuses any other address. |
| `address already in use` | Mantiphy is already running (a forgotten window), or another program uses port 7878. Close the other window, or run `MANTIPHY_PORT=7879 ./run.sh` and open http://127.0.0.1:7879. |
| `WebGL2 is required` | Turn on hardware acceleration in your browser (Settings → System), or try Chrome or Edge. |
| The app seems frozen on the first AI mask or the first noise reduction | Normal: it is downloading the model. Wait a few minutes. |
| Windows: the page does not open | Check that the Ubuntu window is open and that `./run.sh` is still running in it. |
| Windows: `wsl --install` shows its help instead of installing | WSL is already there: type `wsl --install -d Ubuntu`. |

Another problem? Open a request on the project's [Issues](https://github.com/Ondormish/Mantiphy_Public/issues) page and paste the message shown in the terminal.
