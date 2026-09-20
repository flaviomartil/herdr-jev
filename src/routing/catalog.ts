export type ToolRisk = "read" | "write" | "execute";

export interface ToolDef {
  readonly description: string;
  readonly risk: ToolRisk;
  readonly threshold?: number;
  readonly hints?: readonly RegExp[];
}

export interface ModelTierCard {
  readonly tier: "fast" | "balanced" | "deep";
  readonly id: string;
  readonly label: string;
  readonly use: string;
  readonly hints?: readonly RegExp[];
}

export interface SkillCard {
  readonly description: string;
  readonly notFor?: string;
  readonly examples?: readonly string[];
  readonly detail?: string;
  readonly hints?: readonly RegExp[];
}

export const DEFAULT_MODELS: readonly ModelTierCard[] = [
  {
    tier: "fast",
    id: "gemini-3-8-flash",
    label: "Fast / Flash",
    use: "Quick questions, definitions, localized simple checks, unit edits.",
    hints: [/\b(simples?|rapido|status|checa|olha|typo|fix typo)\b/i],
  },
  {
    tier: "balanced",
    id: "sonnet-5",
    label: "Balanced / Sonnet",
    use: "Standard development, debugging across files, feature implementation.",
    hints: [/\b(implement|refator|bug|endpoint|service|component|test)\b/i],
  },
  {
    tier: "deep",
    id: "opus-5",
    label: "Deep / Opus",
    use: "Architectural design, cross-cutting migrations, subtle security or distributed consensus.",
    hints: [/\b(arquitet|distribu|protocolo|consenso|multi-tenant|seguran|vulnerab)\b/i],
  },
] as const;

export const DEFAULT_TOOLS: Record<string, ToolDef> = {
  Read: {
    description: "Inspect files, read documentation, search symbols or view code without altering anything.",
    risk: "read",
    threshold: 0.35,
    hints: [/\b(le|ler|leia|veja|mostre|search|find|view|open|cat|grep)\b/i],
  },
  Edit: {
    description: "Modify existing files, apply patches, fix code, or update configurations in place.",
    risk: "write",
    threshold: 0.6,
    hints: [/\b(edite|altere|modifique|corrija|mude|troque|patch|replace)\b/i],
  },
  Write: {
    description: "Create new files, write fresh documents, generate scripts, or scaffold modules.",
    risk: "write",
    threshold: 0.6,
    hints: [/\b(crie|criar|escreva|adicione|novo|gerar|scaffold)\b/i],
  },
  Bash: {
    description: "Run shell commands: build, test, git operations, migration executions, or external CLIs.",
    risk: "execute",
    threshold: 0.8,
    hints: [/\b(rode|rodar|execute|executar|bash|sh|cmd|npm|git|bun|cargo)\b/i],
  },
};

export const CONTINUATIONS: ReadonlySet<string> = new Set([
  "dale",
  "dale dale",
  "continua",
  "prossiga",
  "vai",
  "avanca",
  "ok",
  "sim",
  "yes",
  "pode ir",
  "manda bala",
  "segue",
  "siga",
  "yes please",
  "continue",
  "proceed",
  "go",
]);

export const COMMAND_PREFIX = /^[/!#]/;
