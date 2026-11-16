<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Download, Eraser, Terminal, X } from "@lucide/vue";
import { Button } from "./vueui/button";
import { parseConsoleCommand, runConsoleCommand } from "../agent-actions/console-command";

interface Entry { id: number; command: string; state: "pending" | "returned" | "failed"; output: string }

/**
 * The open state is owned by `AppShell.vue` so the action facade, the toggle
 * button and `Esc` all write the same value (`ui.console.setVisible`).
 */
const open = defineModel<boolean>("open", { required: true });

const input = ref("");
const inputElement = ref<HTMLInputElement>();
const outputElement = ref<HTMLTextAreaElement>();
const entries = ref<Entry[]>([]);
let sequence = 0;
const transcript = computed(() => entries.value.map(entry => `> ${entry.command}\n[${entry.state}]\n${entry.output}`).join("\n\n"));
const pending = computed(() => entries.value.filter(entry => entry.state === "pending").length);

async function toggle(): Promise<void> {
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  await nextTick();
  inputElement.value?.focus();
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

/**
 * Clears retained output only; a running job keeps running. When the panel is
 * open the command input takes focus back, so the Clear button becoming
 * disabled cannot strand focus on `<body>` (where Escape would not reach the
 * panel); a closed panel is left exactly as it is.
 */
function clear(): void {
  entries.value = [];
  if (open.value) void nextTick(() => inputElement.value?.focus());
}

/**
 * Focuses and selects the retained transcript. Returns false — never a fake
 * success — when the panel is closed or there is nothing to select.
 */
function selectOutput(): boolean {
  const element = outputElement.value;
  if (!open.value || !element || !element.value) return false;
  element.focus();
  element.select();
  return true;
}

/** Bounded counters only: output text never leaves the component. */
function snapshot(): { entries: number; pending: number } {
  return { entries: entries.value.length, pending: pending.value };
}

/** Closing always leaves focus on the visible console toggle. */
function close(): void {
  open.value = false;
  void nextTick(() => {
    document.querySelector<HTMLElement>(".console-toggle")?.focus();
  });
}

defineExpose({ clear, selectOutput, snapshot });
</script>

<template>
  <aside class="development-console tm-ui" data-testid="development-console">
    <Button
      variant="secondary"
      size="sm"
      class="console-toggle"
      data-ui-local="console.toggle"
      aria-controls="development-console-panel"
      :aria-expanded="open"
      @click="toggle"
    >
      <Terminal />
      {{ open ? "Close Console" : "Console" }}
    </Button>
    <section
      v-show="open"
      id="development-console-panel"
      class="console-panel"
      aria-label="Development console"
      @keydown.esc.stop="close"
    >
      <header>
        <strong>Development console</strong>
        <span>Frontend API v2</span>
        <Button variant="ghost" size="icon-xs" aria-label="Close console" data-ui-local="console.toggle" @click="close">
          <X />
        </Button>
      </header>
      <p>Enter an action + JSON, or <code>help</code>. History is held in memory and redacted. Closing keeps results; reloading clears them.</p>
      <form @submit.prevent="submit">
        <label for="console-command">Command</label>
        <div class="console-command-row">
          <!-- A native input, not the shared Input component: `submit()` must
               read the command synchronously in the same tick as the keydown,
               and the ref must be the real element that can take focus. The
               shared Input forwards its model passively (one tick later), so
               that pairing would display a stale value. Styling stays on the
               same theme tokens as the other controls. -->
          <input
            id="console-command"
            ref="inputElement"
            v-model="input"
            aria-label="Console command"
            name="console-command"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            placeholder='time.set {"ageMa":110}'
            @keydown.enter.prevent="submit"
          />
          <Button type="submit" size="sm" data-ui-local="console.run">Run</Button>
        </div>
      </form>
      <div class="console-output-actions">
        <span role="status" data-testid="console-history-status">{{ entries.length }} entries · {{ pending }} pending</span>
        <Button type="button" variant="outline" size="xs" data-ui-local="console.selectOutput" :disabled="!transcript" @click="selectOutput">
          <Download />
          Select output
        </Button>
        <Button type="button" variant="outline" size="xs" data-ui-local="console.clear" :disabled="!entries.length" @click="clear">
          <Eraser />
          Clear output
        </Button>
      </div>
      <textarea ref="outputElement" aria-label="Console output" :value="transcript" readonly :spellcheck="false" placeholder="Results appear here. Type help to see commands." />
      <small>Select output, then press Ctrl/Cmd+C to copy. Clear output keeps jobs running. Use jobs cancel &lt;jobId&gt; to request cancellation; logs can be filtered by traceId.</small>
    </section>
  </aside>
</template>

<style scoped>
.development-console {
  position: fixed;
  right: 16px;
  bottom: 106px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  color: var(--foreground);
  font-size: var(--tm-text-body);
  line-height: var(--tm-line-body);
}
.console-panel {
  position: absolute;
  right: 0;
  bottom: 38px;
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100dvh - 175px);
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--popover);
  box-shadow: 0 8px 30px rgb(16 24 32 / 22%);
  box-sizing: border-box;
}
.console-panel header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.console-panel header strong {
  flex: 1;
  font-size: var(--tm-text-label);
}
.console-panel header span,
.console-panel p {
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  color: var(--muted-foreground);
}
.console-panel p {
  margin: 6px 0 10px;
}
.console-panel label {
  display: block;
  margin-bottom: 4px;
  font-size: var(--tm-text-meta);
  color: var(--muted-foreground);
}
.console-command-row {
  display: flex;
  gap: 6px;
}
.console-command-row input {
  flex: 1;
  min-width: 0;
  height: var(--tm-control-height);
  padding: 0 10px;
  border: 1px solid var(--input);
  border-radius: var(--radius-md);
  background: var(--background);
  color: var(--foreground);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--tm-text-label);
}
.console-command-row input:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.console-command-row input:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.console-output-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 6px;
  flex-wrap: wrap;
}
.console-output-actions > span {
  flex: 1;
  font-size: var(--tm-text-meta);
  color: var(--muted-foreground);
}
.console-panel textarea {
  display: block;
  width: 100%;
  min-height: 140px;
  height: min(300px, 35dvh);
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--input);
  border-radius: var(--radius-md);
  background: var(--muted);
  color: var(--foreground);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  resize: vertical;
}
.console-panel small {
  display: block;
  margin-top: 6px;
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  color: var(--muted-foreground);
}
.console-panel code {
  padding: 0 3px;
  border-radius: var(--radius-sm);
  background: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
