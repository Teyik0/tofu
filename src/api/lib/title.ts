const combiningMarks = /\p{M}/gu;
const titleSeparators = /[^\p{L}\p{N}]+/gu;

export function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(combiningMarks, "")
    .toLocaleLowerCase("en-US")
    .replace(titleSeparators, " ")
    .trim();
}
