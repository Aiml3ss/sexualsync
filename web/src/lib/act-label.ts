export function splitActLabel(label: string) {
  const clean = String(label || "").trim();
  const chars = Array.from(clean);
  if (!isEmojiish(chars[0])) {
    return { emoji: "", text: clean };
  }

  let end = 1;
  end = consumeEmojiSuffix(chars, end);
  while (chars[end] === "\u200D" && isEmojiish(chars[end + 1])) {
    end += 2;
    end = consumeEmojiSuffix(chars, end);
  }

  const emoji = chars.slice(0, end).join("");
  const text = chars.slice(end).join("").trim();
  return { emoji, text: text || clean };
}

function consumeEmojiSuffix(chars: string[], index: number) {
  let next = index;
  while (chars[next] === "\uFE0F" || chars[next] === "\uFE0E" || isEmojiModifier(chars[next])) {
    next += 1;
  }
  return next;
}

function isEmojiish(char?: string) {
  const code = char?.codePointAt(0) || 0;
  return code > 255;
}

function isEmojiModifier(char?: string) {
  const code = char?.codePointAt(0) || 0;
  return code >= 0x1f3fb && code <= 0x1f3ff;
}
