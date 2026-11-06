import type { LaunchRoute, RouteAdapter } from "./types";
import { FluxpadError } from "../connection";

/**
 * Adapter registry. Adapters are loaded lazily so that bundlers keep each
 * protocol's SDK in its own chunk and neither route's code loads when the
 * other is used.
 */
export async function getAdapter(route: LaunchRoute): Promise<RouteAdapter> {
  switch (route) {
    case "pump": {
      const { PumpAdapter } = await import("./pump");
      return new PumpAdapter();
    }
    case "launchlab": {
      const { LaunchLabAdapter } = await import("./launchlab");
      return new LaunchLabAdapter();
    }
    default: {
      const never: never = route;
      throw new FluxpadError("VALIDATION", `Unknown launch route: ${String(never)}`);
    }
  }
}

export const ROUTES: { id: LaunchRoute; label: string }[] = [
  { id: "pump", label: "Pump.fun → PumpSwap" },
  { id: "launchlab", label: "LaunchLab → CPMM" },
];
