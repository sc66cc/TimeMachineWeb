<script setup lang="ts">
import { computed } from "vue";
import { Button } from "@/components/vueui/button";
import { Input } from "@/components/vueui/input";
import { Label } from "@/components/vueui/label";
import { NativeSelect, NativeSelectOption } from "@/components/vueui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/vueui/tabs";
import { X } from "@lucide/vue";

/**
 * The collapsed "add layer or group" panel.
 *
 * All six existing forms moved here unchanged in behaviour: the draft values
 * stay in `AppShell.vue` (as `v-model:*` models) and the submit handlers are the
 * same functions the buttons used before. No node that `main.ts` captures at
 * boot lives in this panel, so `Tabs` may unmount the inactive forms.
 *
 * Group/layer feedback is NOT rendered here: it moved to the always-present
 * sidebar region in `AppShell.vue` so a retry failure stays visible while the
 * panel is closed.
 */
export type AddLayerKind = "group" | "point" | "line" | "polygon" | "raster" | "atlas";

export interface AddLayerGroupOption {
  id: number;
  name: string;
  depth: number;
}

const props = defineProps<{
  readOnly: boolean;
  groupBusy: boolean;
  layerBusy: boolean;
  groups: AddLayerGroupOption[];
  rasterOptions: { id: string; label: string }[];
  atlasAvailable: boolean;
  atlasLabel: string;
  pointSourceRef: string;
  lineSourceRef: string;
  polygonSourceRef: string;
  rasterSourceRef: string;
}>();

/* The `open`, `kind` and draft values are `defineModel` props below. */
const emit = defineEmits<{
  "add-group": [];
  "add-point": [];
  "add-line": [];
  "add-polygon": [];
  "add-raster": [];
  "add-atlas": [];
  close: [];
}>();

const open = defineModel<boolean>("open", { required: true });
const kind = defineModel<AddLayerKind>("kind", { required: true });
const groupName = defineModel<string>("groupName", { required: true });
const groupParent = defineModel<string>("groupParent", { required: true });
const pointName = defineModel<string>("pointName", { required: true });
const pointGroup = defineModel<string>("pointGroup", { required: true });
const lineName = defineModel<string>("lineName", { required: true });
const lineGroup = defineModel<string>("lineGroup", { required: true });
const polygonName = defineModel<string>("polygonName", { required: true });
const polygonGroup = defineModel<string>("polygonGroup", { required: true });
const rasterName = defineModel<string>("rasterName", { required: true });
const rasterGroup = defineModel<string>("rasterGroup", { required: true });
const rasterSelection = defineModel<string>("rasterSelection", { required: true });
const atlasName = defineModel<string>("atlasName", { required: true });
const atlasGroup = defineModel<string>("atlasGroup", { required: true });

interface KindTab {
  value: AddLayerKind;
  label: string;
}

const kindTabs: KindTab[] = [
  { value: "group", label: "Group" },
  { value: "point", label: "Point" },
  { value: "line", label: "Line" },
  { value: "polygon", label: "Polygon" },
  { value: "raster", label: "Raster" },
  { value: "atlas", label: "Atlas" },
];

const hasGroups = computed(() => props.groups.length > 0);

/** The same group-existence rule the pre-migration buttons used. */
function hasGroup(value: string): boolean {
  return props.groups.some((group) => String(group.id) === value);
}
</script>

<template>
  <section
    v-show="open"
    id="add-layer-panel"
    class="add-layer-panel tm-ui"
    role="region"
    aria-label="Add layer or group"
    @keydown.esc.stop="emit('close')"
  >
    <header class="add-layer-panel__head">
      <strong>Add layer or group</strong>
      <Button variant="ghost" size="icon-xs" class="tm-btn" aria-label="Close add panel" data-ui-local="addPanel.close" @click="emit('close')">
        <X />
      </Button>
    </header>

    <Tabs v-model="kind" class="add-layer-panel__tabs">
      <TabsList class="add-layer-panel__tablist" aria-label="Layer kind">
        <TabsTrigger
          v-for="tab in kindTabs"
          :key="tab.value"
          :value="tab.value"
          class="add-layer-panel__trigger"
        >{{ tab.label }}</TabsTrigger>
      </TabsList>

      <TabsContent value="group">
        <form class="add-layer-form" aria-label="Add layer group" @submit.prevent="emit('add-group')">
          <Label class="add-layer-form__field">
            <span>Group name</span>
            <Input v-model="groupName" aria-label="New group name" autocomplete="off" :disabled="readOnly || groupBusy" />
          </Label>
          <Label class="add-layer-form__field">
            <span>Parent</span>
            <NativeSelect v-model="groupParent" aria-label="New group parent" :disabled="readOnly || groupBusy">
              <NativeSelectOption value="">Root</NativeSelectOption>
              <NativeSelectOption v-for="parent in groups" :key="parent.id" :value="String(parent.id)">
                {{ "— ".repeat(parent.depth) + parent.name }}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Button type="submit" size="sm" data-action="layer.group.add" :disabled="readOnly || groupBusy || !groupName.trim()">Add group</Button>
        </form>
      </TabsContent>

      <TabsContent value="point">
        <form class="add-layer-form" aria-label="Add point layer" @submit.prevent="emit('add-point')">
          <Label class="add-layer-form__field">
            <span>Source</span>
            <NativeSelect aria-label="Point layer source" :model-value="pointSourceRef" :disabled="readOnly || layerBusy">
              <NativeSelectOption :value="pointSourceRef">Synthetic point sample</NativeSelectOption>
            </NativeSelect>
          </Label>
          <p class="add-layer-form__note">Present-day points · explicit synthetic sample</p>
          <Label class="add-layer-form__field">
            <span>Name</span>
            <Input v-model="pointName" aria-label="Point layer name" autocomplete="off" :disabled="readOnly || layerBusy" />
          </Label>
          <Label class="add-layer-form__field">
            <span>Group</span>
            <NativeSelect v-model="pointGroup" aria-label="Point layer group" :disabled="readOnly || layerBusy">
              <NativeSelectOption value="" disabled>Choose a group</NativeSelectOption>
              <NativeSelectOption v-for="group in groups" :key="group.id" :value="String(group.id)">
                {{ "— ".repeat(group.depth) + group.name }}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Button type="submit" size="sm" data-action="layer.add" :disabled="readOnly || layerBusy || !pointName.trim() || !hasGroup(pointGroup)">Add point layer</Button>
          <p v-if="!hasGroups" class="add-layer-form__note">Create a group before adding a point layer.</p>
        </form>
      </TabsContent>

      <TabsContent value="line">
        <form class="add-layer-form" aria-label="Add line layer" @submit.prevent="emit('add-line')">
          <Label class="add-layer-form__field">
            <span>Source</span>
            <NativeSelect aria-label="Line layer source" :model-value="lineSourceRef" :disabled="readOnly || layerBusy">
              <NativeSelectOption :value="lineSourceRef">Synthetic line sample</NativeSelectOption>
            </NativeSelect>
          </Label>
          <p class="add-layer-form__note">Source-coordinate lines · not reconstructed · explicit synthetic sample</p>
          <Label class="add-layer-form__field">
            <span>Name</span>
            <Input v-model="lineName" aria-label="Line layer name" autocomplete="off" :disabled="readOnly || layerBusy" />
          </Label>
          <Label class="add-layer-form__field">
            <span>Group</span>
            <NativeSelect v-model="lineGroup" aria-label="Line layer group" :disabled="readOnly || layerBusy">
              <NativeSelectOption value="" disabled>Choose a group</NativeSelectOption>
              <NativeSelectOption v-for="group in groups" :key="group.id" :value="String(group.id)">
                {{ "— ".repeat(group.depth) + group.name }}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Button type="submit" size="sm" data-action="layer.add" :disabled="readOnly || layerBusy || !lineName.trim() || !hasGroup(lineGroup)">Add line layer</Button>
          <p v-if="!hasGroups" class="add-layer-form__note">Create a group before adding a line layer.</p>
        </form>
      </TabsContent>

      <TabsContent value="polygon">
        <form class="add-layer-form" aria-label="Add polygon layer" @submit.prevent="emit('add-polygon')">
          <Label class="add-layer-form__field">
            <span>Source</span>
            <NativeSelect aria-label="Polygon layer source" :model-value="polygonSourceRef" :disabled="readOnly || layerBusy">
              <NativeSelectOption :value="polygonSourceRef">Synthetic polygon sample</NativeSelectOption>
            </NativeSelect>
          </Label>
          <p class="add-layer-form__note">Source-coordinate polygons · not reconstructed · explicit synthetic sample</p>
          <Label class="add-layer-form__field">
            <span>Name</span>
            <Input v-model="polygonName" aria-label="Polygon layer name" autocomplete="off" :disabled="readOnly || layerBusy" />
          </Label>
          <Label class="add-layer-form__field">
            <span>Group</span>
            <NativeSelect v-model="polygonGroup" aria-label="Polygon layer group" :disabled="readOnly || layerBusy">
              <NativeSelectOption value="" disabled>Choose a group</NativeSelectOption>
              <NativeSelectOption v-for="group in groups" :key="group.id" :value="String(group.id)">
                {{ "— ".repeat(group.depth) + group.name }}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Button type="submit" size="sm" data-action="layer.add" :disabled="readOnly || layerBusy || !polygonName.trim() || !hasGroup(polygonGroup)">Add polygon layer</Button>
          <p v-if="!hasGroups" class="add-layer-form__note">Create a group before adding a polygon layer.</p>
        </form>
      </TabsContent>

      <TabsContent value="raster">
        <form class="add-layer-form" aria-label="Add raster layer" @submit.prevent="emit('add-raster')">
          <Label class="add-layer-form__field">
            <span>Source</span>
            <NativeSelect aria-label="Raster layer source" :model-value="rasterSourceRef" :disabled="readOnly || layerBusy" data-action="layer.add">
              <NativeSelectOption :value="rasterSourceRef">Single raster manifest</NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label class="add-layer-form__field">
            <span>Raster</span>
            <NativeSelect v-model="rasterSelection" aria-label="Raster layer selection" :disabled="readOnly || layerBusy || rasterOptions.length === 0" data-action="layer.add">
              <NativeSelectOption value="" disabled>Choose a raster</NativeSelectOption>
              <NativeSelectOption v-for="option in rasterOptions" :key="option.id" :value="option.id">{{ option.label }}</NativeSelectOption>
            </NativeSelect>
          </Label>
          <p v-if="rasterOptions.length === 0" class="add-layer-form__note">No raster manifest choices are available.</p>
          <Label class="add-layer-form__field">
            <span>Name</span>
            <Input v-model="rasterName" aria-label="Raster layer name" autocomplete="off" :disabled="readOnly || layerBusy" data-action="layer.add" />
          </Label>
          <Label class="add-layer-form__field">
            <span>Group</span>
            <NativeSelect v-model="rasterGroup" aria-label="Raster layer group" :disabled="readOnly || layerBusy" data-action="layer.add">
              <NativeSelectOption value="" disabled>Choose a group</NativeSelectOption>
              <NativeSelectOption v-for="group in groups" :key="group.id" :value="String(group.id)">
                {{ "— ".repeat(group.depth) + group.name }}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Button type="submit" size="sm" data-action="layer.add" :disabled="readOnly || layerBusy || !rasterName.trim() || !hasGroup(rasterGroup) || !rasterOptions.some(option => option.id === rasterSelection)">Add raster layer</Button>
          <p v-if="!hasGroups" class="add-layer-form__note">Create a group before adding a raster layer.</p>
        </form>
      </TabsContent>

      <TabsContent value="atlas">
        <form class="add-layer-form" aria-label="Add Atlas layer" @submit.prevent="emit('add-atlas')">
          <p class="add-layer-form__note">Source: <span aria-label="Atlas layer source">{{ atlasAvailable ? atlasLabel : "Atlas manifest unavailable" }}</span></p>
          <p class="add-layer-form__note">Follows the view's committed age; the nearest available frame is used.</p>
          <Label class="add-layer-form__field">
            <span>Name</span>
            <Input v-model="atlasName" aria-label="Atlas layer name" autocomplete="off" :disabled="readOnly || layerBusy" data-action="layer.add" />
          </Label>
          <Label class="add-layer-form__field">
            <span>Group</span>
            <NativeSelect v-model="atlasGroup" aria-label="Atlas layer group" :disabled="readOnly || layerBusy" data-action="layer.add">
              <NativeSelectOption value="" disabled>Choose a group</NativeSelectOption>
              <NativeSelectOption v-for="group in groups" :key="group.id" :value="String(group.id)">
                {{ "— ".repeat(group.depth) + group.name }}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Button type="submit" size="sm" data-action="layer.add" :disabled="readOnly || layerBusy || !atlasName.trim() || !hasGroup(atlasGroup) || !atlasAvailable">Add Atlas layer</Button>
          <p v-if="!hasGroups" class="add-layer-form__note">Create a group before adding an Atlas layer.</p>
        </form>
      </TabsContent>
    </Tabs>
  </section>
</template>

<style scoped>
.add-layer-panel {
  border-bottom: 1px solid var(--sidebar-border);
  background: var(--card);
  color: var(--foreground);
  font-size: var(--tm-text-body);
}
.add-layer-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 4px 12px;
}
.add-layer-panel__head strong {
  font-size: var(--tm-text-label);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.add-layer-panel__tablist {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  height: auto;
  padding: 0 8px 6px;
  background: transparent;
}
.add-layer-panel__tablist :deep(.add-layer-panel__trigger) {
  width: 100%;
  height: 24px;
  padding: 0 4px;
  font-size: var(--tm-text-meta);
}
.add-layer-form {
  display: grid;
  gap: 6px;
  padding: 4px 12px 12px;
}
.add-layer-form__field {
  display: grid;
  gap: 3px;
}
.add-layer-form__field > span {
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  color: var(--muted-foreground);
}
.add-layer-form__note {
  margin: 0;
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
</style>
