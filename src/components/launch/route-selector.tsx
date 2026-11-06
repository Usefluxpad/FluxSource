"use client";

import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import { getAdapter, ROUTES } from "@/lib/adapters";
import type { LaunchRoute } from "@/lib/adapters/types";
import { Badge, Card, Spinner } from "@/components/ui/primitives";
import { RelaypadError } from "@/lib/connection";

export function RouteSelector({
  value,
  onChange,
  connection,
  cluster,
}: {
  value: LaunchRoute;
  onChange: (r: LaunchRoute) => void;
  connection: Connection;
  cluster: string;
}) {
  const [configs, setConfigs] = useState<Partial<Record<LaunchRoute, { ok: boolean; details: string[] }>>>({});
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    setChecking(true);
    void (async () => {
      const out: Partial<Record<LaunchRoute, { ok: boolean; details: string[] }>> = {};
      for (const route of ROUTES) {
        try {
          const adapter = await getAdapter(route.id);
          const config = await adapter.loadConfig(connection, cluster as never);
          out[route.id] = {
            ok: true,
            details: [
              ...adapter.describePrograms(cluster as never).map((p) => `${p.name}: ${p.address}`),
              ...Object.entries(config.details)
                .filter(([, v]) => v !== null && v !== undefined)
                .map(([k, v]) => `${k}: ${String(v)}`),
            ],
          };
        } catch (err) {
          out[route.id] = {
            ok: false,
            details: [
              err instanceof RelaypadError
                ? `${err.code}: ${err.message}`
                : String(err).slice(0, 200),
            ],
          };
        }
      }
      if (live) {
        setConfigs(out);
        setChecking(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, cluster]);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {ROUTES.map((route) => {
        const cfg = configs[route.id];
        const selected = value === route.id;
        return (
          <Card
            key={route.id}
            className={`cursor-pointer transition ${
              selected
                ? route.id === "pump"
                  ? "border-mint-500 shadow-glow-mint"
                  : "border-ice-500 shadow-glow-mint"
                : "hover:border-night-500"
            }`}
          >
            <label className="flex h-full cursor-pointer flex-col">
              <div className="flex items-center justify-between">
                <input
                  type="radio"
                  name="route"
                  className="sr-only"
                  checked={selected}
                  onChange={() => onChange(route.id)}
                />
                <Badge tone={route.id === "pump" ? "mint" : "ice"}>
                  {route.id === "pump" ? "Bonding Curve" : "LaunchLab"}
                </Badge>
                {checking ? (
                  <Spinner />
                ) : cfg?.ok ? (
                  <Badge tone="success">available</Badge>
                ) : (
                  <Badge tone="warn">unavailable</Badge>
                )}
              </div>
              <h3 className="mt-3 font-semibold text-ink">{route.label}</h3>
              <ul className="mt-2 space-y-1 text-xs text-night-500">
                {(cfg?.details ?? ["checking live protocol configuration…"]).map((d, i) => (
                  <li key={i} className="break-all">
                    {d}
                  </li>
                ))}
              </ul>
            </label>
          </Card>
        );
      })}
    </div>
  );
}
