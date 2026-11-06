import { Spinner } from "@/components/ui/primitives";
import { FluxSymbol } from "@/components/brand/logo";

export default function Loading() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <FluxSymbol size={56} />
      <Spinner label="Loading FluxPad…" />
    </div>
  );
}
