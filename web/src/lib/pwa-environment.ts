export type AccessBlockReason = "desktop" | "embedded" | "ios-browser";

export interface PwaEnvironment {
  android: boolean;
  embedded: boolean;
  ios: boolean;
  iosSafari: boolean;
  mobileLike: boolean;
  standalone: boolean;
}

interface NavigatorWithPwaHints extends Navigator {
  standalone?: boolean;
  userAgentData?: {
    mobile?: boolean;
  };
}

export function getPwaEnvironment(): PwaEnvironment {
  if (typeof window === "undefined") {
    return {
      android: false,
      embedded: false,
      ios: false,
      iosSafari: false,
      mobileLike: false,
      standalone: false,
    };
  }

  const nav = window.navigator as NavigatorWithPwaHints;
  const ua = nav.userAgent || "";
  const maxTouchPoints = nav.maxTouchPoints || 0;
  const iPadOS = /\bMacintosh\b/.test(ua) && maxTouchPoints > 1;
  const ios = /\b(iPad|iPhone|iPod)\b/.test(ua) || iPadOS;
  const android = /\bAndroid\b/i.test(ua);
  const uaMobile = nav.userAgentData?.mobile === true
    || /\b(Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile)\b/i.test(ua)
    || iPadOS;
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches === true;
  const compactViewport = Math.min(window.innerWidth || 9999, window.screen?.width || 9999) <= 932;
  const mobileLike = uaMobile || (coarsePointer && maxTouchPoints > 0 && compactViewport);
  const safari = /\bSafari\b/.test(ua)
    && !/\b(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA)\b/.test(ua);
  const iosSafari = ios && safari;
  const embedded = /\b(FBAN|FBAV|FB_IAB|Instagram|Line|MicroMessenger|TikTok|Snapchat|Pinterest|LinkedInApp|Twitter|GSA)\b/i.test(ua)
    || /\bwv\b/i.test(ua)
    || /; wv\)/i.test(ua);
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches === true
    || nav.standalone === true;

  return {
    android,
    embedded,
    ios,
    iosSafari,
    mobileLike,
    standalone,
  };
}

export function getAccessBlockReason(env: PwaEnvironment): AccessBlockReason | null {
  if (!env.mobileLike) return "desktop";
  if (env.embedded) return "embedded";
  if (env.ios && !env.iosSafari && !env.standalone) return "ios-browser";
  return null;
}
