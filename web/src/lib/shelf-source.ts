// Pure shelf / RedGifs URL helpers. No crypto here — this is domain logic for
// classifying a shelf content URL and deriving RedGifs embed/poster URLs. The
// crypto layer (room-record-crypto.ts) re-exports the public symbols.

export function shelfContentLooksLikeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function shelfSourceLabelForUrl(value: string) {
  const source = shelfSourceForUrl(value);
  if (source === "redgifs") return "REDGIFS";
  if (source === "literotica") return "LITEROTICA";
  if (source === "ao3") return "AO3";
  if (source === "bellesa") return "BELLESA";
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host || "Link";
  } catch {
    return "Link";
  }
}

export function shelfSourceForUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (/^(?:www\.)?redgifs\.com$/.test(host)) return "redgifs";
    if (/^(?:www\.)?literotica\.com$/.test(host)) return "literotica";
    if (/^(?:www\.)?archiveofourown\.org$/.test(host)) return "ao3";
    if (/^(?:www\.)?bellesa\.(?:co|com)$/.test(host)) return "bellesa";
  } catch {}
  return "";
}

export function normalizeRedgifsId(value: string) {
  const raw = String(value || "").toLowerCase().trim();
  if (!raw) return "";
  const segment = raw.split(/[/?#]/)[0].replace(/[^a-z0-9-]/g, "");
  if (!segment) return "";
  if (/^[a-z0-9]+$/.test(segment)) return segment;
  return segment.split("-").filter(Boolean).pop() || segment.replace(/-/g, "");
}

export function redgifsIdFromUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.split("/").filter(Boolean);
    if (/^(?:www\.)?redgifs\.com$/.test(host)) {
      const markerIndex = path.findIndex((part) => ["watch", "ifr", "detail"].includes(part.toLowerCase()));
      const candidate = markerIndex >= 0 ? path[markerIndex + 1] : path[path.length - 1];
      return normalizeRedgifsId(candidate || "");
    }
    if (/^(?:thumbs\d+|media)\.redgifs\.com$/.test(host)) {
      const basename = (path[path.length - 1] || "")
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/-(?:hd|sd|mobile|poster|thumb|thumbnail)$/i, "");
      return normalizeRedgifsId(basename);
    }
  } catch {}
  return "";
}

export function redgifsShelfFromUrl(value: string) {
  const id = redgifsIdFromUrl(value);
  if (!id) return null;
  const directVideoUrl = /^https:\/\/(?:thumbs\d+|media)\.redgifs\.com\/.+\.(?:mp4|webm)(?:[?#].*)?$/i.test(value)
    ? value
    : "";
  return {
    sourceId: id,
    sourceUrl: value,
    embedUrl: `https://www.redgifs.com/ifr/${id}?hd=1&muted=1&autoplay=0`,
    posterUrl: `https://media.redgifs.com/${id}-poster.jpg`,
    videoHdUrl: directVideoUrl,
  };
}
