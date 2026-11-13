import type { TimeMachineAgentFacade } from "./agent-actions";

declare global {
  interface Window {
    /**
     * In-page action facade. Present once `installAgentActions()` has run, so
     * automated tests and agents drive the same handlers the UI drives.
     */
    timeMachineAgent?: TimeMachineAgentFacade;
  }
}
