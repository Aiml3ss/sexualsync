// Parsing helpers for the inspiration shelf.
//
// Two save modes:
//   • Paste a URL  → produces a "gif" or "story" tile linking to the source.
//   • Paste a passage of text (no URL) → produces a "passage" tile that
//     showcases the text itself as a framed quote.

const REDGIFS_RE = /(?:https?:\/\/)?(?:[a-z]+\.)?redgifs\.com\/(?:watch\/|ifr\/|[a-z]+\/)([a-z0-9-]+)/i;
const REDGIFS_MEDIA_RE = /(?:https?:\/\/)?(?:thumbs\d+|media)\.redgifs\.com\/([a-z0-9]+)/i;
const LITEROTICA_HOST_RE = /^(?:www\.)?literotica\.com$/i;
const AO3_HOST_RE        = /^(?:www\.)?archiveofourown\.org$/i;
const BELLESA_HOST_RE    = /^(?:www\.)?bellesa\.(?:co|com)$/i;

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

function parseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  return u;
}

function normalizeRedgifsId(value) {
  const raw = String(value || "").toLowerCase().trim();
  if (!raw) return "";
  const segment = raw.split(/[/?#]/)[0].replace(/[^a-z0-9-]/g, "");
  if (!segment) return "";
  if (/^[a-z0-9]+$/.test(segment)) return segment;
  return segment.split("-").filter(Boolean).pop() || segment.replace(/-/g, "");
}

// Extract a RedGifs gif id from any of the common URL shapes.
function extractRedGifsId(raw) {
  const m = String(raw).match(REDGIFS_RE) || String(raw).match(REDGIFS_MEDIA_RE);
  return m ? normalizeRedgifsId(m[1]) : null;
}

// Public — turn a raw user-pasted string into a structured shelf item draft.
// Returns one of:
//   { kind: "gif",     source, sourceId, sourceUrl, embedUrl, posterUrl }
//   { kind: "story",   source, sourceUrl }
//   { kind: "passage", passageText }
//   null  (input was empty)
export function parseShelfInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  if (looksLikeUrl(s)) {
    // RedGifs gets the gif treatment with native video URLs + poster.
    const id = extractRedGifsId(s);
    if (id) {
      const originalUrl = parseUrl(s);
      return {
        kind: "gif",
        source: "redgifs",
        sourceId: id,
        sourceUrl: originalUrl?.toString() || `https://www.redgifs.com/watch/${id}`,
        embedUrl:  `https://www.redgifs.com/ifr/${id}?hd=1&muted=1&autoplay=0`,
        posterUrl: `https://media.redgifs.com/${id}-poster.jpg`,
      };
    }

    // Other URL — classify the source so the tile shows where it's from.
    const u = parseUrl(s);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    let source = "other";
    if (LITEROTICA_HOST_RE.test(host)) source = "literotica";
    else if (AO3_HOST_RE.test(host))   source = "ao3";
    else if (BELLESA_HOST_RE.test(host)) source = "bellesa";
    return {
      kind: "story",
      source,
      sourceUrl: u.toString(),
    };
  }

  // No URL → treat the entire input as a passage of text.
  return {
    kind: "passage",
    passageText: s.slice(0, 1200),
  };
}

// Friendly label for a source code (rendered as the eyebrow on story tiles).
export function sourceLabel(source) {
  switch (source) {
    case "redgifs":    return "REDGIFS";
    case "literotica": return "LITEROTICA";
    case "ao3":        return "AO3";
    case "bellesa":    return "BELLESA";
    case "other":
    default:           return "LINK";
  }
}
