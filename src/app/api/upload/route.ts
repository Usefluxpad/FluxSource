import { NextResponse } from "next/server";
import { parseTokenSocials, validateArtwork, validateMetadataUri } from "@/lib/metadata";
import { getDb } from "@/lib/db";

/**
 * POST /api/upload
 *  - multipart/form-data with `file` → uploads artwork to IPFS via Pinata,
 *    then builds the off-chain metadata JSON with a `name`/`symbol`/etc. form
 *    payload and uploads it too. Returns { imageUrl, metadataUri }.
 *
 * Security: Pinata credentials live only in server env vars. Files are
 * validated (type + size) before leaving the server. Upload attempts are
 * audited in the UploadAudit table (no file content, no credentials).
 *
 * Without PINATA_JWT the endpoint returns a clear configuration error —
 * it never fakes success.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

async function pinataUpload(jwt: string, data: FormData) {
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: data,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new Error("Pinata response missing IpfsHash");
  return json.IpfsHash;
}

export async function POST(req: Request) {
  const jwt = process.env.PINATA_JWT;
  const gateway = process.env.PINATA_GATEWAY || "ipfs.io";

  if (!jwt) {
    return NextResponse.json(
      {
        error: "upload_not_configured",
        message:
          "Artwork uploads require PINATA_JWT in the server environment (see .env.example). FluxPad does not accept uploads it cannot store.",
      },
      { status: 503 },
    );
  }

  const db = getDb();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const file = form.get("file");
  const metaRaw = form.get("metadata");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }

  const artworkCheck = validateArtwork(file.size, file.type);
  if (!artworkCheck.ok) {
    await audit(db, file.name, file.size, file.type, null, "rejected", artworkCheck.reason);
    return NextResponse.json({ error: "invalid_file", message: artworkCheck.reason }, { status: 400 });
  }

  let metadata: Record<string, unknown> | null = null;
  if (typeof metaRaw === "string") {
    try {
      metadata = JSON.parse(metaRaw) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "invalid_metadata_json" }, { status: 400 });
    }
    // Social links are re-normalized SERVER-SIDE before anything reaches IPFS:
    // the on-chain JSON must carry validated absolute https URLs in the
    // top-level fields scanners read (website/twitter/telegram). Anything
    // unsafe (javascript:, data:, non-URL strings) is dropped, and legacy
    // client shapes (`social` object) are flattened into the standard fields.
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const socials = parseTokenSocials(metadata);
      for (const key of ["website", "twitter", "telegram", "external_url", "social", "extensions"]) {
        delete metadata[key];
      }
      if (socials.website) {
        metadata.website = socials.website;
        metadata.external_url = socials.website;
      }
      if (socials.twitter) metadata.twitter = socials.twitter;
      if (socials.telegram) metadata.telegram = socials.telegram;
    }
  }

  try {
    // 1) artwork
    const artForm = new FormData();
    artForm.append("file", file, file.name);
    const imageCid = await pinataUpload(jwt, artForm);
    const imageUrl = `https://${gateway}/ipfs/${imageCid}`;

    // 2) metadata JSON referencing the artwork
    let metadataUri: string | null = null;
    if (metadata) {
      metadata.image = imageUrl;
      const blob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
      const metaForm = new FormData();
      metaForm.append("file", blob, "metadata.json");
      const metaCid = await pinataUpload(jwt, metaForm);
      metadataUri = `https://${gateway}/ipfs/${metaCid}`;
      const uriCheck = validateMetadataUri(metadataUri);
      if (!uriCheck.ok) throw new Error(`Metadata URI validation failed: ${uriCheck.reason}`);
    }

    await audit(db, file.name, file.size, file.type, imageCid, "ok", null);
    return NextResponse.json({ imageUrl, metadataUri });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit(db, file.name, file.size, file.type, null, "error", reason);
    return NextResponse.json({ error: "upload_failed", message: reason }, { status: 502 });
  }
}

async function audit(
  db: ReturnType<typeof getDb>,
  fileName: string,
  sizeBytes: number,
  mime: string,
  cid: string | null,
  status: string,
  reason: string | null,
) {
  if (!db) return;
  try {
    await db.uploadAudit.create({
      data: {
        uploader: "api",
        fileName: fileName.slice(0, 200),
        sizeBytes: Math.min(sizeBytes, 2_000_000_000),
        mime: mime.slice(0, 100),
        cid,
        status,
        reason: reason?.slice(0, 500) ?? null,
      },
    });
  } catch (err) {
    console.error("[api/upload] audit write failed", err);
  }
}
