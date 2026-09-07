import { MAX_CHUNK_CHARS, MAX_TOTAL_CHARS } from "./constants";

/**
 * Turn a markdown answer from the agent into chunks that are short enough to
 * synthesize one at a time.
 *
 * DeerFlow answers are long markdown reports: code blocks, tables and link
 * targets must never reach the TTS engine, and a single request must stay well
 * below the endpoint's character limit. Everything here is a pure function so
 * it can be unit tested without a DOM.
 */

/** Sentence boundary marker, stripped before the chunks are returned. */
const BOUNDARY = "\u0000";

/** Placeholder used to keep decimals (`3.14`) out of the sentence splitter. */
const DECIMAL = "\u0001";

const TRUNCATION_NOTICE = "……（内容过长，已省略剩余部分）";

const MIN_MERGE_CHARS = 12;

/**
 * Strip markdown syntax and keep only what a human would actually read aloud.
 */
export function stripMarkdown(markdown: string): string {
  if (!markdown) {
    return "";
  }

  return (
    markdown
      // Fenced and inline code carry no spoken value.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/`([^`\n]*)`/g, "$1")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Links keep their label, drop the URL.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Tables: separator rows and every row starting with a pipe.
      .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
      .replace(/^\s*\|.*$/gm, " ")
      .replace(/^\s*#{1,6}\s*/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      // Leftover markdown punctuation and bare URLs.
      .replace(/[`>#*~_]/g, " ")
      .replace(/https?:\/\/\S+/g, " 链接 ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
}

/**
 * Split plain text into sentence-sized chunks bounded by `max` characters.
 */
export function splitIntoChunks(
  text: string,
  max: number = MAX_CHUNK_CHARS,
): string[] {
  if (!text) {
    return [];
  }

  const marked = text
    // Protect decimals so `3.14` is not treated as a sentence end.
    .replace(/(\d)\.(\d)/g, `$1${DECIMAL}$2`)
    // Latin sentence end: a period only counts when whitespace follows.
    .replace(/([.!?])(?=\s|$)/g, `$1${BOUNDARY}`)
    // CJK sentence end.
    .replace(/([。！？；])/g, `$1${BOUNDARY}`)
    // Paragraph breaks are natural pauses.
    .replace(/\n+/g, BOUNDARY)
    .split(BOUNDARY)
    .map((part) => part.split(DECIMAL).join(".").trim())
    .filter((part) => part.length > 0);

  return merge(burst(marked, max), max);
}

/**
 * Merge very short neighbours so a single "好的。" does not cost a round trip.
 */
function merge(chunks: string[], max: number): string[] {
  const merged: string[] = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      chunk.length < MIN_MERGE_CHARS &&
      previous.length >= MIN_MERGE_CHARS &&
      previous.length + 1 + chunk.length <= max
    ) {
      merged[merged.length - 1] = `${previous} ${chunk}`;
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

/**
 * Break over-long sentences at commas first, then hard-cut at `max`.
 */
function burst(chunks: string[], max: number): string[] {
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= max) {
      result.push(chunk);
      continue;
    }

    let remaining = chunk;
    while (remaining.length > max) {
      let cut = -1;
      for (const index of indexesOf(remaining, ["，", ",", "、", "：", ":"])) {
        if (index > max * 0.6 && index <= max) {
          cut = index + 1;
        }
      }

      if (cut <= 0) {
        const spaceCut = remaining.lastIndexOf(" ", max);
        cut = spaceCut > max * 0.6 ? spaceCut + 1 : max;
      }

      result.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining.length > 0) {
      result.push(remaining);
    }
  }
  return result.filter((chunk) => chunk.length > 0);
}

function indexesOf(text: string, needles: string[]): number[] {
  const found: number[] = [];
  for (const needle of needles) {
    let index = text.indexOf(needle);
    while (index !== -1) {
      found.push(index);
      index = text.indexOf(needle, index + needle.length);
    }
  }
  return found;
}

/**
 * Full pipeline: markdown in, TTS-ready chunks out, with a total length cap so
 * a long report cannot flood the endpoint.
 */
export function toSpeechChunks(markdown: string): string[] {
  const plain = stripMarkdown(markdown);
  if (!plain) {
    return [];
  }

  const truncated =
    plain.length > MAX_TOTAL_CHARS
      ? `${plain.slice(0, MAX_TOTAL_CHARS)}${TRUNCATION_NOTICE}`
      : plain;

  return splitIntoChunks(truncated);
}

/**
 * Rough spoken duration in seconds, used by the fallback mouth animation when
 * the browser blocks audio playback and no analyser data is available.
 */
export function estimateSpeechSeconds(text: string, rate = 0): number {
  const cjkCount = (text.match(/[㐀-鿿぀-ヿ가-힯]/g) ?? []).length;
  // Chinese reads at roughly 5.5 characters per second, latin words are slower
  // per character but far fewer characters per word.
  const cjkSeconds = cjkCount / 5.5;
  const otherSeconds = (text.length - cjkCount) / 14;
  const speed = 1 + rate / 100;
  return Math.max(0.6, (cjkSeconds + otherSeconds) / Math.max(speed, 0.5));
}
