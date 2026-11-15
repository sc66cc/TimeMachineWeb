<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BentoWelcome } from "./BentoWelcome";
import styles from "../aceternity.css?inline";

const host = ref<HTMLElement | null>(null);
let root: Root | undefined;

onMounted(() => {
  if (!host.value) return;
  // Keep Tailwind's reset and component styles out of the Cesium/Vue workspace.
  const shadow = host.value.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = styles;
  const container = document.createElement("div");
  shadow.append(style, container);
  root = createRoot(container);
  root.render(createElement(BentoWelcome));
});

onBeforeUnmount(() => root?.unmount());
</script>

<template>
  <div ref="host" class="aceternity-welcome" />
</template>

<style scoped>
.aceternity-welcome {
  position: relative;
  z-index: 90;
  font-family: Arial, Helvetica, sans-serif;
}
</style>
