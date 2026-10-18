// where a message can be cut into parts that parse the same alone as together, so a part that is
// done is never parsed again while the rest streams in. pure.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * a new part starts at the margin after a blank line, at a heading, at a fence, and after a fence
 * closes. never inside a fence, and never at an indented line: that is a list's or a code block's
 */
export function blocks(text: string): string[] {
  const out: string[] = [];
  let part: string[] = [];
  let fence: string | null = null;
  let blank = false;
  const cut = () => {
    if (part.some((l) => l.trim())) out.push(part.join("\n"));
    else if (out.length) out[out.length - 1] += `\n${part.join("\n")}`;
    part = [];
  };
  for (const line of text.split("\n")) {
    const mark = FENCE.exec(line)?.[1];
    if (fence) {
      part.push(line);
      // the same character, at least as many, and nothing after it
      const closes =
        mark !== undefined &&
        mark[0] === fence[0] &&
        mark.length >= fence.length &&
        !line.trim().slice(mark.length).trim();
      if (closes) {
        fence = null;
        cut();
      }
      continue;
    }
    const margin = line.length > 0 && !/^\s/.test(line);
    const heading = margin && /^#{1,6}(\s|$)/.test(line);
    if (margin && (blank || heading || mark)) cut();
    if (mark) fence = mark;
    part.push(line);
    // a heading is one line: what follows it at the margin is a part of its own
    blank = !line.trim() || heading;
  }
  if (part.length) cut();
  return out;
}
