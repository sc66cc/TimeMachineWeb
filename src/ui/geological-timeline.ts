export interface GeologicalTimelineElements {
  slider: HTMLInputElement;
  needle: HTMLElement;
  ticks: HTMLElement;
  playButton: HTMLButtonElement;
  speedButton: HTMLButtonElement;
  todayButton: HTMLButtonElement;
  quickAgeButtons: NodeListOf<HTMLButtonElement>;
}

export interface GeologicalTimelineOptions {
  minAgeMa: number;
  maxAgeMa: number;
  initialAgeMa?: number;
  reverse?: boolean;
  onChange: (ageMa: number) => void;
}

const PLAYBACK_SPEEDS = [10, 25, 50] as const;
const TIMELINE_LEFT_RAIL_PX = 25;
const TIMELINE_END_GUTTER_PX = 48;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export class GeologicalTimeline {
  private readonly elements: GeologicalTimelineElements;
  private readonly options: GeologicalTimelineOptions;
  private ageMa: number;
  private isPlaying = false;
  private speedIndex = 1;
  private previousFrameTime: number | undefined;
  private animationFrame: number | undefined;

  constructor(
    elements: GeologicalTimelineElements,
    options: GeologicalTimelineOptions,
  ) {
    this.elements = elements;
    this.options = options;
    this.ageMa = options.initialAgeMa ?? options.minAgeMa;

    elements.slider.min = String(options.minAgeMa);
    elements.slider.max = String(options.maxAgeMa);
    elements.slider.step = "0.1";
    elements.slider.dir = options.reverse ? "rtl" : "ltr";
    elements.slider.addEventListener("input", () => {
      this.pause();
      this.setAge(Number(elements.slider.value));
    });
    elements.needle.addEventListener(
      "pointerdown",
      this.handleNeedlePointerDown,
    );
    elements.needle.addEventListener(
      "pointermove",
      this.handleNeedlePointerMove,
    );
    elements.needle.addEventListener("pointerup", this.handleNeedlePointerUp);
    elements.needle.addEventListener(
      "pointercancel",
      this.handleNeedlePointerUp,
    );
    elements.playButton.addEventListener("click", () => {
      if (this.isPlaying) {
        this.pause();
      } else {
        this.play();
      }
    });
    elements.speedButton.addEventListener("click", () => {
      this.speedIndex = (this.speedIndex + 1) % PLAYBACK_SPEEDS.length;
      this.updateControls();
    });
    elements.todayButton.addEventListener("click", () => {
      this.pause();
      this.setAge(0);
    });
    elements.quickAgeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        this.pause();
        this.setAge(Number(button.dataset.age ?? 0));
      });
    });

    this.createTicks();
    this.setAge(this.ageMa);
  }

  get currentAgeMa(): number {
    return this.ageMa;
  }

  get minAgeMa(): number {
    return this.options.minAgeMa;
  }

  get maxAgeMa(): number {
    return this.options.maxAgeMa;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  /** Playback speed in Ma per second, snapped to the available presets. */
  get speedMaPerSecond(): number {
    return PLAYBACK_SPEEDS[this.speedIndex] ?? PLAYBACK_SPEEDS[0];
  }

  /** Starts or pauses playback without going through the button element. */
  setPlaying(playing: boolean): void {
    if (playing === this.isPlaying) {
      return;
    }
    if (playing) {
      this.play();
    } else {
      this.pause();
    }
  }

  /**
   * Selects the playback preset nearest to the requested speed. The timeline
   * only offers discrete presets, so the effective value is reported back by
   * `speedMaPerSecond`.
   */
  setSpeedMaPerSecond(speedMaPerSecond: number): void {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    PLAYBACK_SPEEDS.forEach((speed, index) => {
      const distance = Math.abs(speed - speedMaPerSecond);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    this.speedIndex = nearestIndex;
    this.updateControls();
  }

  setAge(ageMa: number): void {
    this.ageMa = clamp(
      ageMa,
      this.options.minAgeMa,
      this.options.maxAgeMa,
    );
    this.elements.slider.value = String(this.ageMa);
    this.updateControls();
    this.options.onChange(this.ageMa);
  }

  private createTicks(): void {
    this.elements.ticks.replaceChildren();
    const interval = this.options.maxAgeMa <= 600 ? 50 : 100;
    for (
      let age = this.options.minAgeMa;
      age <= this.options.maxAgeMa;
      age += interval
    ) {
      const tick = document.createElement("span");
      tick.className = "timeline-tick";
      const normalized =
        (age - this.options.minAgeMa) /
        (this.options.maxAgeMa - this.options.minAgeMa);
      tick.style.left = `${
        (this.options.reverse ? 1 - normalized : normalized) * 100
      }%`;
      tick.dataset.major = String(age % (interval * 2) === 0);
      tick.innerHTML = `<i></i><b>${age}</b>`;
      this.elements.ticks.append(tick);
    }
  }

  private updateControls(): void {
    const normalized =
      ((this.ageMa - this.options.minAgeMa) /
        (this.options.maxAgeMa - this.options.minAgeMa));
    const progress = (this.options.reverse ? 1 - normalized : normalized) * 100;
    const normalizedProgress = progress / 100;
    const railOffset = (1 - normalizedProgress) * TIMELINE_LEFT_RAIL_PX;
    const endGutterOffset =
      normalizedProgress * TIMELINE_END_GUTTER_PX;
    this.elements.needle.style.left =
      `calc(${progress}% + ${railOffset}px - ${endGutterOffset}px)`;
    this.elements.needle.style.setProperty(
      "--timeline-position",
      String(progress / 100),
    );
    this.elements.slider.style.setProperty(
      "--timeline-progress",
      `${progress}%`,
    );
    this.elements.playButton.dataset.playing = String(this.isPlaying);
    this.elements.playButton.setAttribute(
      "aria-label",
      this.isPlaying ? "暂停地质时间播放" : "播放地质时间",
    );
    const label = this.elements.playButton.querySelector("[data-play-label]");
    if (label) {
      label.textContent = this.isPlaying ? "暂停" : "播放";
    }
    this.elements.speedButton.textContent = `${
      PLAYBACK_SPEEDS[this.speedIndex]
    } Ma/s`;
  }

  private updateAgeFromPointer(clientX: number): void {
    const bounds = this.elements.slider.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const horizontalProgress = clamp(
      (clientX - bounds.left) / bounds.width,
      0,
      1,
    );
    const ageProgress = this.options.reverse
      ? 1 - horizontalProgress
      : horizontalProgress;
    this.setAge(
      this.options.minAgeMa +
        ageProgress * (this.options.maxAgeMa - this.options.minAgeMa),
    );
  }

  private readonly handleNeedlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    event.preventDefault();
    this.pause();
    this.elements.needle.setPointerCapture(event.pointerId);
    this.elements.needle.classList.add("is-dragging");
    this.updateAgeFromPointer(event.clientX);
  };

  private readonly handleNeedlePointerMove = (event: PointerEvent): void => {
    if (!this.elements.needle.hasPointerCapture(event.pointerId)) {
      return;
    }
    event.preventDefault();
    this.updateAgeFromPointer(event.clientX);
  };

  private readonly handleNeedlePointerUp = (event: PointerEvent): void => {
    if (this.elements.needle.hasPointerCapture(event.pointerId)) {
      this.elements.needle.releasePointerCapture(event.pointerId);
    }
    this.elements.needle.classList.remove("is-dragging");
  };

  private play(): void {
    if (this.ageMa >= this.options.maxAgeMa) {
      this.setAge(this.options.minAgeMa);
    }
    this.isPlaying = true;
    this.previousFrameTime = undefined;
    this.updateControls();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  private pause(): void {
    this.isPlaying = false;
    this.previousFrameTime = undefined;
    if (this.animationFrame !== undefined) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
    this.updateControls();
  }

  private readonly animate = (frameTime: number): void => {
    if (!this.isPlaying) {
      return;
    }
    if (this.previousFrameTime !== undefined) {
      const elapsedSeconds = (frameTime - this.previousFrameTime) / 1_000;
      const speed = PLAYBACK_SPEEDS[this.speedIndex] ?? PLAYBACK_SPEEDS[0];
      this.setAge(this.ageMa + elapsedSeconds * speed);
      if (this.ageMa >= this.options.maxAgeMa) {
        this.pause();
        return;
      }
    }
    this.previousFrameTime = frameTime;
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
