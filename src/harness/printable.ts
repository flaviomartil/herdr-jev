const TERMINAL_SEQUENCES = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function printable(text: string): string {
  return text.replace(TERMINAL_SEQUENCES, "").replace(UNPRINTABLE, "");
}

export function singleLine(text: string): string {
  return printable(text).replace(/[\t\n\u2028\u2029]+/g, " ");
}
