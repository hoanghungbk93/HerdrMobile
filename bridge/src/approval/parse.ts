import { createHash } from 'node:crypto';

export interface ApprovalOption {
  key: string;
  label: string;
}

export interface ParsedApproval {
  options: ApprovalOption[];
  hash: string;
  text: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const OPTION = /^\s*[│ ]*[❯›>]?\s*(\d)\.\s+(.+?)\s*[│ ]*$/;

export function parseApproval(detectionText: string): ParsedApproval {
  const clean = detectionText.replace(ANSI, '').trim();
  const hash = createHash('sha256').update(clean).digest('hex');
  const lines = clean.split('\n').filter((l) => l.trim() !== '');
  const text = lines.slice(-12).join('\n');

  // Last contiguous block of option lines.
  let end = lines.length - 1;
  while (end >= 0 && !OPTION.test(lines[end])) end--;
  let start = end;
  while (start > 0 && OPTION.test(lines[start - 1])) start--;

  const options: ApprovalOption[] = [];
  for (let i = start; end >= 0 && i <= end; i++) {
    const m = OPTION.exec(lines[i])!;
    options.push({ key: m[1], label: m[2] });
  }
  // A lone "1. foo" is far more likely a numbered list in output than a prompt: need at least two choices.
  const valid = options.length >= 2 && options.every((o, i) => o.key === String(i + 1));
  return { options: valid ? options : [], hash, text };
}
