import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center py-24 text-center">
      <h2 className="text-2xl font-bold text-ink">Not found</h2>
      <p className="mt-2 text-sm text-night-500">
        This page, token, or launch record does not exist on FluxPad.
      </p>
      <Link href="/" className="mt-6 text-sm text-mint-400 hover:underline">
        ← Back to FluxPad
      </Link>
    </div>
  );
}
