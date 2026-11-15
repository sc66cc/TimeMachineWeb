import { useState } from "react";
import { BentoGrid, BentoGridItem } from "@/components/ui/bento-grid";

const features = [
  {
    title: "Travel through deep time",
    description: "Explore Earth's changing geography with the geological timeline and plate reconstructions.",
    label: "01 / RECONSTRUCT",
    gradient: "linear-gradient(135deg, #e0f2fe, #ecfeff, #ffffff)",
    symbol: "◎",
  },
  {
    title: "Discover the layers",
    description: "Combine paleogeographic maps, raster imagery, and point datasets in one globe.",
    label: "02 / EXPLORE",
    gradient: "linear-gradient(135deg, #d1fae5, #f0fdfa, #ffffff)",
    symbol: "▱",
  },
  {
    title: "Build your perspective",
    description: "Adjust your view, organize your layers, and save your project to the cloud when signed in.",
    label: "03 / CREATE",
    gradient: "linear-gradient(135deg, #fef3c7, #fff7ed, #ffffff)",
    symbol: "◈",
  },
];

export function BentoWelcome() {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button
        type="button"
        className="fixed right-4 bottom-4 cursor-pointer rounded-full border border-neutral-200 bg-white px-5 py-3 text-sm font-semibold text-neutral-800 shadow-lg focus-visible:outline-2 focus-visible:outline-sky-600"
        onClick={() => setOpen(true)}
      >
        Welcome to Time Machine
      </button>
    );
  }

  return (
    <section
      aria-labelledby="bento-welcome-title"
      className="fixed right-4 bottom-4 left-4 mx-auto max-h-[85dvh] max-w-4xl overflow-y-auto rounded-2xl border border-neutral-200 bg-neutral-50 p-5 text-neutral-900 shadow-2xl md:p-8"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-widest text-sky-700">TIME MACHINE / EARTH THROUGH TIME</p>
          <h1 id="bento-welcome-title" className="text-2xl font-bold tracking-tight md:text-3xl">A world of discovery.</h1>
          <p className="mt-2 text-sm text-neutral-600">Explore the past. Understand the planet.</p>
        </div>
        <button
          type="button"
          aria-label="Close welcome panel"
          className="cursor-pointer rounded-lg px-3 py-1 text-xl text-neutral-600 hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-sky-600"
          onClick={() => setOpen(false)}
        >×</button>
      </div>
      <BentoGrid>
        {features.map((feature) => (
          <BentoGridItem
            key={feature.title}
            title={feature.title}
            description={feature.description}
            header={
              <div aria-hidden="true" className="flex min-h-28 flex-1 items-center justify-center rounded-lg" style={{ backgroundImage: feature.gradient }}>
                <span className="text-7xl text-neutral-600">{feature.symbol}</span>
              </div>
            }
            icon={<span className="text-[10px] font-semibold tracking-widest text-sky-700">{feature.label}</span>}
          />
        ))}
      </BentoGrid>
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          className="cursor-pointer rounded-lg bg-sky-700 px-5 py-3 text-sm font-semibold text-white hover:bg-sky-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          onClick={() => setOpen(false)}
        >Explore the globe →</button>
      </div>
    </section>
  );
}
