# CCSM for Ubuntu 24.04 x86_64

This archive contains the CCSM release binary tested on Ubuntu 24.04 with WSLg.

Install the runtime libraries:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1 \
  librsvg2-2 \
  libxdo3
```

Extract and run:

```bash
tar -xzf CCSM-0.1.0-beta.2-ubuntu-24.04-x86_64.tar.gz
cd CCSM-0.1.0-beta.2-ubuntu-24.04-x86_64
./run.sh
```

Claude Code, Codex, and GitHub Copilot tabs require their Linux CLIs to be installed and authenticated on `PATH`. Browser tabs use the system WebKitGTK runtime. WSL users need WSLg; native Ubuntu users need a graphical desktop session.

`BUILD-INFO.txt` records the source revision and binary SHA-256. The archive SHA-256 is distributed beside the archive.
