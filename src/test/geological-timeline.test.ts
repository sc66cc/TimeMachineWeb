// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { GeologicalTimeline } from "../ui/geological-timeline";

function createTimeline(reverse: boolean, onStateChange?: (state: { ageMa: number; playing: boolean; speedMaPerSecond: number }) => void, onChange: (ageMa: number, signal?: AbortSignal) => void = vi.fn()): {
  needle: HTMLDivElement;
  slider: HTMLInputElement;
  timeline: GeologicalTimeline;
} {
  document.body.innerHTML = `
    <input id="slider" type="range">
    <div id="needle"></div>
    <div id="ticks"></div>
    <button id="play"><span data-play-label></span></button>
    <button id="speed"></button>
    <button id="today"></button>
    <button data-age="32"></button>
  `;
  const slider = document.querySelector<HTMLInputElement>("#slider");
  const needle = document.querySelector<HTMLDivElement>("#needle");
  const ticks = document.querySelector<HTMLDivElement>("#ticks");
  const playButton = document.querySelector<HTMLButtonElement>("#play");
  const speedButton = document.querySelector<HTMLButtonElement>("#speed");
  const todayButton = document.querySelector<HTMLButtonElement>("#today");
  if (
    !slider ||
    !needle ||
    !ticks ||
    !playButton ||
    !speedButton ||
    !todayButton
  ) {
    throw new Error("Timeline fixture is incomplete.");
  }

  const timeline = new GeologicalTimeline(
    {
      slider,
      needle,
      ticks,
      playButton,
      speedButton,
      todayButton,
      quickAgeButtons:
        document.querySelectorAll<HTMLButtonElement>("[data-age]"),
    },
    {
      initialAgeMa: 0,
      maxAgeMa: 538.8,
      minAgeMa: 0,
      onChange,
      onStateChange,
      reverse,
    },
  );
  return { needle, slider, timeline };
}

describe("GeologicalTimeline", () => {
  it("passes an API request's cancellation signal without attaching it to later native input", () => {
    const changes: Array<{ ageMa: number; signal?: AbortSignal }> = [];
    const { timeline, slider } = createTimeline(true, undefined, (ageMa, signal) => changes.push({ ageMa, signal }));
    const abort = new AbortController();
    timeline.setAge(100, abort.signal);
    expect(changes.at(-1)).toEqual({ ageMa: 100, signal: abort.signal });
    abort.abort();
    slider.value = "200";
    slider.dispatchEvent(new Event("input"));
    expect(changes.at(-1)).toEqual({ ageMa: 200, signal: undefined });
  });

  it("notifies the same playback state for native controls and API setters", () => {
    const states: Array<{ ageMa: number; playing: boolean; speedMaPerSecond: number }> = [];
    const { timeline } = createTimeline(true, state => states.push(state));
    timeline.setSpeedMaPerSecond(50);
    expect(states.at(-1)).toMatchObject({ speedMaPerSecond: 50, playing: false });
    document.querySelector<HTMLButtonElement>("#speed")!.click();
    expect(states.at(-1)).toMatchObject({ speedMaPerSecond: 10 });
    document.querySelector<HTMLButtonElement>("#play")!.click();
    expect(states.at(-1)).toMatchObject({ playing: true });
    timeline.setPlaying(false);
    timeline.setAge(100);
    expect(states.at(-1)).toEqual({ ageMa: 100, playing: false, speedMaPerSecond: 10 });
  });

  it("places present day on the right for the canonical reversed scale", () => {
    const { needle, slider, timeline } = createTimeline(true);

    expect(slider.dir).toBe("rtl");
    expect(needle.style.left).toContain("100%");
    expect(needle.style.left).toContain("48px");

    timeline.setAge(538.8);
    expect(needle.style.left).toContain("25px");
  });

  it("keeps normal left-to-right positioning when reverse is disabled", () => {
    const { needle, slider, timeline } = createTimeline(false);

    expect(slider.dir).toBe("ltr");
    expect(needle.style.left).toContain("25px");

    timeline.setAge(538.8);
    expect(needle.style.left).toContain("100%");
    expect(needle.style.left).toContain("48px");
  });
});
