// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { GeologicalTimeline } from "../ui/geological-timeline";

function createTimeline(reverse: boolean): {
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
      onChange: vi.fn(),
      reverse,
    },
  );
  return { needle, slider, timeline };
}

describe("GeologicalTimeline", () => {
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
