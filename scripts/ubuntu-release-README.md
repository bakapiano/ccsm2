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
tar -xzf CCSM-0.1.0-beta.3-ubuntu-24.04-x86_64.tar.gz
cd CCSM-0.1.0-beta.3-ubuntu-24.04-x86_64
./run.sh
```

Claude Code, Codex, and GitHub Copilot tabs require their Linux CLIs to be installed and authenticated on `PATH`. Browser tabs use the system WebKitGTK runtime. WSL users need WSLg; native Ubuntu users need a graphical desktop session.

On WSLg, CCSM automatically selects Mesa's D3D12 driver when `/dev/dxg`, the
WSL D3D12 runtime, and Mesa's D3D12 driver are available. WebKit software
compositing is selected when that WSLg graphics stack is incomplete. Native
Ubuntu uses its system graphics stack.

Set `CCSM_LINUX_RENDERER` before launch to select a renderer explicitly:

```bash
CCSM_LINUX_RENDERER=auto ./run.sh
CCSM_LINUX_RENDERER=d3d12 ./run.sh
CCSM_LINUX_RENDERER=software ./run.sh
CCSM_LINUX_RENDERER=system ./run.sh
```

`auto` preserves an existing Mesa or WebKit renderer override from the launch
environment.

`BUILD-INFO.txt` records the source revision and binary SHA-256. The archive SHA-256 is distributed beside the archive.
