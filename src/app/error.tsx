"use client";

import { Button } from "@/components/ui/primitives";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <h2 className="text-2xl font-bold text-ink">Something went wrong</h2>
      <p className="mt-2 max-w-md text-sm text-night-500">
        {error.message || "An unexpected error occurred."}
      </p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
