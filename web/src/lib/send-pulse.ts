/* fireSendPulse — visual-only send confirmation. Self-mounting overlay
   that fires one glowing rose orb up a curved sync-wave path from an
   origin point, then cleans itself up. Optionally fades in a confirm
   message after the orb exits. Framework-agnostic, SSR-safe. */

type PulseOrigin = HTMLElement | { x: number; y: number };

type PulseConfirm = {
  headline: string;
  sub?: string;
};

type PulseOptions = {
  confirm?: PulseConfirm;
};

const TRAIL_LEN = 800;
const DURATION = 1600;
// Hold long enough for the confirm to finish fading in (~0.9s after the orb
// exits) plus a brief beat, then begin the dissolve. Callers that await the
// promise navigate at that point, so this is also how long "It's with X now"
// sits on the calm composer before the next page is revealed.
const CONFIRM_HOLD = 1200;
const CONFIRM_FADE_OUT = 600;
// Reduced-motion paints the confirm instantly (see globals.css), so there's
// nothing to wait for — land it briefly and move on.
const REDUCED_ORB = 400;
const REDUCED_HOLD = 700;

export function fireSendPulse(origin?: PulseOrigin, options?: PulseOptions): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();

  let ox: number, oy: number;
  if (origin instanceof Element) {
    const r = origin.getBoundingClientRect();
    ox = r.left + r.width / 2;
    oy = r.top + r.height / 2;
  } else if (origin && "x" in origin) {
    ox = origin.x;
    oy = origin.y;
  } else {
    ox = window.innerWidth / 2;
    oy = window.innerHeight - 100;
  }

  const tx = window.innerWidth / 2;
  const ty = -40;

  const dy = oy - ty;
  const c1x = ox + 90, c1y = oy - dy * 0.32;
  const c2x = ox - 70, c2y = oy - dy * 0.68;
  const pathD = `M ${ox},${oy} C ${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`;

  const layer = document.createElement("div");
  layer.className = "ss-send-pulse-layer";
  layer.setAttribute("aria-hidden", "true");

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", pathD);
  path.setAttribute("class", "ss-send-pulse-trail");
  svg.appendChild(path);

  try {
    const len = path.getTotalLength();
    if (Number.isFinite(len) && len > 0) {
      layer.style.setProperty("--ss-trail-len", String(len));
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
    } else {
      layer.style.setProperty("--ss-trail-len", String(TRAIL_LEN));
    }
  } catch {
    layer.style.setProperty("--ss-trail-len", String(TRAIL_LEN));
  }

  const flash = document.createElement("div");
  flash.className = "ss-send-pulse-flash";
  flash.style.left = `${ox}px`;
  flash.style.top = `${oy}px`;

  const orb = document.createElement("div");
  orb.className = "ss-send-pulse-orb";
  // setProperty is more reliable than the camelCase setter on Safari iOS,
  // which has historically been finicky about offsetPath via JS DOM. The
  // -webkit- form is a no-op on modern WebKit but covers older builds.
  const pathValue = `path('${pathD}')`;
  orb.style.setProperty("offset-path", pathValue);
  orb.style.setProperty("-webkit-offset-path", pathValue);

  layer.appendChild(svg);
  layer.appendChild(flash);
  layer.appendChild(orb);

  const confirm = options?.confirm;
  let confirmEl: HTMLDivElement | null = null;
  if (confirm) {
    layer.classList.add("has-confirm");
    confirmEl = document.createElement("div");
    confirmEl.className = "ss-send-pulse-confirm";
    const headline = document.createElement("p");
    headline.className = "ss-send-pulse-confirm-headline";
    headline.textContent = confirm.headline;
    confirmEl.appendChild(headline);
    if (confirm.sub) {
      const sub = document.createElement("p");
      sub.className = "ss-send-pulse-confirm-sub";
      sub.textContent = confirm.sub;
      confirmEl.appendChild(sub);
    }
    layer.appendChild(confirmEl);
  }

  document.body.appendChild(layer);

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // When the send carries a confirm message the caller awaits this promise and
  // navigates only once it resolves — so the moment lands on the calm composer
  // instead of flashing over the next page as it mounts. Resolve as the confirm
  // BEGINS its fade-out, then let the layer dissolve over the freshly revealed
  // page before removing it. Without a confirm the caller doesn't await, so we
  // just clean up after the orb's flight.
  const orbTime = reduceMotion ? REDUCED_ORB : DURATION;
  const hold = reduceMotion ? REDUCED_HOLD : CONFIRM_HOLD;
  const confirmLand = orbTime + hold;
  const totalDuration = confirm ? confirmLand + CONFIRM_FADE_OUT : DURATION + 100;

  return new Promise<void>((resolve) => {
    if (confirm) {
      window.setTimeout(() => {
        if (confirmEl) confirmEl.classList.add("is-fading");
        layer.classList.add("is-confirm-fading");
        // Hand control back to the caller as the confirm dissolves; the layer
        // finishes fading out over the next page on its own.
        resolve();
      }, confirmLand);
      window.setTimeout(() => { layer.remove(); }, totalDuration);
    } else {
      window.setTimeout(() => {
        layer.remove();
        resolve();
      }, totalDuration);
    }
  });
}

export default fireSendPulse;
