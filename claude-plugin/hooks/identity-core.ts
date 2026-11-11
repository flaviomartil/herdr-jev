export type CliKind = "claude" | "codex" | "agy" | "haiku" | "other";

export const CLI_COLORS: Record<CliKind, string> = {
  claude: "#d97757",
  codex: "#4c6ef5",
  agy: "#15aabf",
  haiku: "#40c057",
  other: "#868e96",
};

export const NAMES: readonly string[] = [
  "Ada", "Bo", "Cass", "Dev", "Ede", "Fen", "Gus", "Hana", "Ines", "Jo",
  "Kit", "Lex", "Mo", "Nils", "Oona", "Pim", "Quinn", "Rae", "Sol", "Tao",
  "Uma", "Vic", "Wren", "Xan", "Yuri", "Zed", "Ari", "Bex", "Cleo", "Dax",
  "Ezra", "Fay", "Gil", "Hux", "Ivo", "Juno", "Kai", "Lior", "Mika", "Nix",
];

export function cliKind(client: string | null | undefined, model?: string | null): CliKind {
  const c = (client ?? "").toLowerCase();
  const m = (model ?? "").toLowerCase();
  if (c.includes("codex")) return "codex";
  if (c.includes("agy") || c.includes("antigravity") || c.includes("gemini")) return "agy";
  if (c.includes("haiku") || m.includes("haiku")) return "haiku";
  if (c.includes("claude") || c === "") return m.includes("haiku") ? "haiku" : "claude";
  return "other";
}

export function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function nickname(index: number, names: readonly string[] = NAMES): string {
  const list = names.length > 0 ? names : NAMES;
  const lap = Math.floor(index / list.length);
  return list[index % list.length] + (lap ? String(lap + 1) : "");
}

export class Roster {
  private readonly seen = new Map<string, number>();
  constructor(private readonly names: readonly string[] = NAMES) {}
  name(agentId: string): string {
    let index = this.seen.get(agentId);
    if (index === undefined) {
      index = this.seen.size;
      this.seen.set(agentId, index);
    }
    return nickname(index, this.names);
  }
  size(): number {
    return this.seen.size;
  }
}

export function parseRosterFile(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : (parsed as { names?: unknown })?.names;
    if (!Array.isArray(list)) return [];
    return list.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim().slice(0, 12));
  } catch {
    return [];
  }
}

export type Cell = { ch: string; fg?: string; bg?: string };
export type Avatar = { rows: Cell[][]; kind: CliKind };

const SKINS = ["#ffc19b", "#f1c27d", "#8d5524", "#ffdbac", "#e0ac69", "#c68642", "#3d2b1f"];
const HAIRS = ["#2a2a2a", "#502a18", "#1a1a1a", "#f0e6d2", "#6e6e6e", "#8b4513", "#ff8c00"];

const SHAPES: Record<CliKind, readonly string[]> = {
  claude: [".HHHH.", ".SeeS.", ".SSSS.", "BBBBBB"],
  codex: ["HHHHHH", "BBBBBB", ".SSSS.", ".BBBB."],
  agy: ["..HH..", ".SeeS.", ".SSSS.", "BB..BB"],
  haiku: ["......", ".HHHH.", ".SeeS.", "..BB.."],
  other: ["......", ".SSSS.", ".SeeS.", ".BBBB."],
};

export function avatar(kind: CliKind, agentId: string): Avatar {
  const h = hashId(agentId);
  const palette: Record<string, string> = {
    H: HAIRS[h % HAIRS.length],
    S: SKINS[(h >>> 8) % SKINS.length],
    e: "#212529",
    B: CLI_COLORS[kind],
  };
  const grid = SHAPES[kind].map((row) => [...row].map((c) => palette[c]));
  const rows: Cell[][] = [];
  for (const base of [0, 2]) {
    rows.push(
      grid[base].map((top, x) => {
        const bottom = grid[base + 1][x];
        if (top && bottom) return { ch: "▀", fg: top, bg: bottom };
        if (top) return { ch: "▀", fg: top };
        if (bottom) return { ch: "▄", fg: bottom };
        return { ch: " " };
      }),
    );
  }
  return { rows, kind };
}

export function avatarText(av: Avatar): string[] {
  return av.rows.map((r) => r.map((c) => c.ch).join(""));
}

export function avatarSignature(av: Avatar): string {
  return av.rows.map((r) => r.map((c) => `${c.ch}${c.fg ?? ""}${c.bg ?? ""}`).join("")).join("|");
}
