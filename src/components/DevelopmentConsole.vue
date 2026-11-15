<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { parseConsoleCommand, runConsoleCommand } from "../agent-actions/console-command";

interface Entry { id: number; command: string; state: "pending" | "returned" | "failed"; output: string }
const open = ref(false);
const input = ref("");
const inputElement = ref<HTMLInputElement>();
const outputElement = ref<HTMLTextAreaElement>();
const entries = ref<Entry[]>([]);
let sequence = 0;
const transcript = computed(() => entries.value.map(entry => `> ${entry.command}\n[${entry.state}]\n${entry.output}`).join("\n\n"));
const pending = computed(() => entries.value.filter(entry => entry.state === "pending").length);

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) { await nextTick(); inputElement.value?.focus(); }
}
async function submit(): Promise<void> {
  const line = input.value;
  input.value = "";
  let command;
  let parseError: string | undefined;
  try { command = parseConsoleCommand(line); }
  catch (error) { parseError = error instanceof Error ? error.message : "Invalid command."; }
  const entry: Entry = { id: ++sequence, command: command?.summary ?? "Invalid command (input discarded)", state: command ? "pending" : "failed", output: parseError ?? "" };
  entries.value.push(entry);
  if (!command) return;
  const result = await runConsoleCommand(command, window.timeMachineAgent?.v2);
  const retained = entries.value.find(item => item.id === entry.id);
  if (retained) { retained.state = result.failed ? "failed" : "returned"; retained.output = result.output; }
  await nextTick();
  if (outputElement.value) outputElement.value.scrollTop = outputElement.value.scrollHeight;
}
function clear(): void { entries.value = []; }
function selectOutput(): void { outputElement.value?.focus(); outputElement.value?.select(); }
</script>

<template>
  <aside class="development-console" data-testid="development-console">
    <button class="console-toggle" type="button" data-ui-local="console.toggle" aria-controls="development-console-panel" :aria-expanded="open" @click="toggle">
      {{ open ? "Close Console" : "Console" }}
    </button>
    <section v-show="open" id="development-console-panel" class="console-panel" aria-label="Development console" @keydown.esc="open = false">
      <header><strong>Development console</strong><span>Frontend API v2</span></header>
      <p>Enter an action + JSON, or <code>help</code>. History is held in memory and redacted. Closing keeps results; reloading clears them.</p>
      <form @submit.prevent="submit">
        <label for="console-command">Command</label>
        <div class="console-command-row">
          <input id="console-command" ref="inputElement" v-model="input" aria-label="Console command" name="console-command" type="text" autocomplete="off" autocapitalize="off" :spellcheck="false" placeholder='time.set {"ageMa":110}' @keydown.enter.prevent="submit" />
          <button type="submit" data-ui-local="console.run">Run</button>
        </div>
      </form>
      <div class="console-output-actions">
        <span role="status" data-testid="console-history-status">{{ entries.length }} entries · {{ pending }} pending</span>
        <button type="button" data-ui-local="console.selectOutput" :disabled="!transcript" @click="selectOutput">Select output</button>
        <button type="button" data-ui-local="console.clear" :disabled="!entries.length" @click="clear">Clear output</button>
      </div>
      <textarea ref="outputElement" aria-label="Console output" :value="transcript" readonly :spellcheck="false" placeholder="Results appear here. Type help to see commands." />
      <small>Select output, then press Ctrl/Cmd+C to copy. Clear output keeps jobs running. Use jobs cancel &lt;jobId&gt; to request cancellation; logs can be filtered by traceId.</small>
    </section>
  </aside>
</template>

<style scoped>
.development-console { position: fixed; right: 16px; bottom: 106px; z-index: 70; font: 12px/1.45 system-ui, sans-serif; color: #e6edf4; }
.development-console button { border: 1px solid #526a80; border-radius: 4px; padding: 6px 10px; background: #263c50; color: #f1f5f9; cursor: pointer; }
.development-console button:disabled { opacity: 0.45; cursor: default; }
.development-console button:focus-visible, .development-console input:focus-visible, .development-console textarea:focus-visible { outline: 2px solid #80c5ff; outline-offset: 2px; }
.console-toggle { display: block; margin-left: auto; }
.console-panel { position: absolute; right: 0; bottom: 42px; width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 175px); overflow: auto; padding: 14px; border: 1px solid #526a80; border-radius: 6px; background: #132331; box-shadow: 0 8px 30px #0005; box-sizing: border-box; }
.console-panel header { display: flex; justify-content: space-between; gap: 12px; }
.console-panel header span, .console-panel p, .console-panel small { color: #bdccda; }
.console-panel p { margin: 8px 0 12px; }
.console-panel label { display: block; margin-bottom: 4px; }
.console-command-row { display: flex; gap: 8px; }
.console-command-row input { flex: 1; min-width: 0; padding: 8px; border: 1px solid #526a80; border-radius: 3px; background: #0a1721; color: #f1f5f9; font: 12px/1.5 ui-monospace, monospace; }
.console-output-actions { display: flex; align-items: center; gap: 8px; margin: 12px 0 6px; flex-wrap: wrap; }
.console-output-actions > span { flex: 1; }
.console-panel textarea { display: block; width: 100%; min-height: 140px; height: min(300px, 35dvh); box-sizing: border-box; padding: 8px; border: 1px solid #526a80; border-radius: 3px; background: #0a1721; color: #e6edf4; font: 12px/1.5 ui-monospace, monospace; resize: vertical; }
.console-panel small { display: block; margin-top: 6px; }
</style>
