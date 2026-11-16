<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import BlurReveal from "@/components/vueui/blur-reveal/BlurReveal.vue";
import { Button } from "@/components/vueui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/vueui/dialog";

/**
 * The Vue welcome panel. It replaces the React island in the shell, but the
 * island files and their CSS stay on disk (historical implementation, no
 * runtime fallback).
 *
 * The only motion is a single BlurReveal pass over ONE child element with
 * `delay: 0` and `duration: 0.2` (<= 220ms). Under `prefers-reduced-motion:
 * reduce` the panel renders the same content statically — the animation path is
 * not even mounted.
 */
const open = defineModel<boolean>("open", { required: true });

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

const reducedMotion = ref(prefersReducedMotion());
const query = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : undefined;
const onChange = (event: MediaQueryListEvent): void => { reducedMotion.value = event.matches; };
query?.addEventListener?.("change", onChange);
onBeforeUnmount(() => query?.removeEventListener?.("change", onChange));
</script>

<template>
  <Dialog :open="open" @update:open="open = $event">
    <DialogContent class="welcome-panel tm-ui" :show-close-button="false">
      <DialogTitle>Time Machine workbench</DialogTitle>
      <DialogDescription>
        A paleogeographic reconstruction workbench: plate models, point and raster layers, and a
        geological timeline share one map.
      </DialogDescription>

      <BlurReveal
        v-if="!reducedMotion"
        :delay="0"
        :duration="0.2"
        blur="8px"
        :y-offset="6"
      >
        <div class="welcome-panel__lead">
          <p>
            Pick a plate model in the sidebar, choose an age on the timeline, and select features on
            the globe to inspect their finite rotations.
          </p>
        </div>
      </BlurReveal>
      <div v-else class="welcome-panel__lead">
        <p>
          Pick a plate model in the sidebar, choose an age on the timeline, and select features on
          the globe to inspect their finite rotations.
        </p>
      </div>

      <ul class="welcome-panel__list">
        <li><strong>Layers</strong> — add groups, points, lines, polygons, rasters and atlas frames.</li>
        <li><strong>Plate Model</strong> — shared and private catalogs, plus the local demo data.</li>
        <li><strong>Console</strong> — run any declared workbench action with <code>help</code> for the list.</li>
      </ul>

      <div class="welcome-panel__actions">
        <Button variant="secondary" size="sm" @click="open = false">Close</Button>
        <Button
          size="sm"
          data-action="ui.welcome.setVisible"
          @click="open = false"
        >Explore the globe</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.welcome-panel {
  max-width: min(520px, calc(100vw - 32px));
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--popover);
  color: var(--popover-foreground);
  font-size: var(--tm-text-body);
  line-height: var(--tm-line-body);
}
.welcome-panel :deep([data-slot="dialog-title"]) {
  font-size: 16px;
  line-height: 24px;
  color: var(--foreground);
}
.welcome-panel :deep([data-slot="dialog-description"]),
.welcome-panel__lead p,
.welcome-panel__list {
  margin: 0;
  font-size: var(--tm-text-body);
  line-height: var(--tm-line-body);
  color: var(--muted-foreground);
}
.welcome-panel__list {
  display: grid;
  gap: 4px;
  padding-left: 18px;
}
.welcome-panel__list strong {
  color: var(--foreground);
}
.welcome-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.welcome-panel code {
  padding: 0 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--tm-text-meta);
}
</style>
