import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function requiredArtifactDirectory(): string {
  const directory = process.env.CCSM_E2E_ARTIFACT_DIR;
  if (!directory) throw new Error("CCSM_E2E_ARTIFACT_DIR is required");
  return directory;
}

export class ScenarioEvidence {
  readonly #scenarioId: string;
  readonly #frameDirectory: string;
  readonly #acceptanceDirectory: string;
  readonly #timelinePath: string;
  #frame = 0;

  constructor(scenarioId: string) {
    this.#scenarioId = scenarioId;
    const artifactDirectory = requiredArtifactDirectory();
    this.#frameDirectory = join(artifactDirectory, "screenshots", scenarioId);
    this.#acceptanceDirectory = join(artifactDirectory, "acceptance");
    this.#timelinePath = join(this.#frameDirectory, "timeline.txt");
    mkdirSync(this.#frameDirectory, { recursive: true });
    mkdirSync(this.#acceptanceDirectory, { recursive: true });
  }

  async checkpoint(name: string): Promise<void> {
    const nextFrame = this.#frame + 1;
    const frameName = `${String(nextFrame).padStart(3, "0")}.png`;
    const label = `${process.env.CCSM_E2E_PLATFORM ?? process.platform} · ${this.#scenarioId} · ${name}`;
    await browser.execute((text) => {
      const existing = document.querySelector("#ccsm-e2e-evidence-label");
      existing?.remove();
      const banner = document.createElement("div");
      banner.id = "ccsm-e2e-evidence-label";
      banner.textContent = text;
      Object.assign(banner.style, {
        position: "fixed",
        zIndex: "2147483647",
        top: "8px",
        left: "50%",
        transform: "translateX(-50%)",
        padding: "5px 10px",
        borderRadius: "5px",
        background: "rgba(0, 0, 0, 0.82)",
        color: "white",
        font: "12px/1.4 system-ui, sans-serif",
        pointerEvents: "none",
      });
      document.body.append(banner);
    }, label);
    try {
      await browser.saveScreenshot(join(this.#frameDirectory, frameName));
    } finally {
      await browser.execute(() =>
        document.querySelector("#ccsm-e2e-evidence-label")?.remove(),
      );
    }
    this.#frame = nextFrame;
    appendFileSync(
      this.#timelinePath,
      `${String(this.#frame).padStart(3, "0")} ${name}\n`,
    );
  }

  finalize(): boolean {
    if (this.#frame === 0) {
      return false;
    }
    execFileSync(
      ffmpeg.path,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-framerate",
        "1",
        "-i",
        join(this.#frameDirectory, "%03d.png"),
        "-vf",
        "fps=1,scale=960:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer",
        "-loop",
        "0",
        join(this.#acceptanceDirectory, `${this.#scenarioId}.gif`),
      ],
      { stdio: "pipe" },
    );
    return true;
  }
}
