/**
 * The app's one Model instance (ADR 0022), chosen by build mode, and the
 * React binding renderers and the shell use to read it.
 */
import { useSyncExternalStore } from "react";
import {
  liveGardenModel,
  snapshotGardenModel,
  type GardenModel,
  type GardenSnapshot,
} from "./model/garden-model.ts";

export type { GardenSnapshot as GardenData };

/** True in the static GitHub Pages demo. */
export const STATIC_DEMO = import.meta.env.MODE === "pages";

export const gardenModel: GardenModel = STATIC_DEMO
  ? snapshotGardenModel(`${import.meta.env.BASE_URL}demo-data/`)
  : liveGardenModel();

export function useGardenModel(
  model: GardenModel = gardenModel,
): GardenSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot);
}

export const useGardenData = (): GardenSnapshot => useGardenModel();
