import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS, PASSO_0, enforceSpawn, judge, mergeModels, parseModelOverrides } from "../src/judge/index.js";

const table: [string, string, string, string, string][] = [
  ["find where the retry config is defined", "search", "claude-subagent", "claude-haiku-5-5", "low"],
  ["explore the auth module and explain it", "explore", "claude-subagent", "claude-haiku-5-5", "low"],
  ["summarize the last 20 commits", "summary", "claude-subagent", "claude-haiku-5-5", "low"],
  ["rename Foo to Bar everywhere", "mechanical", "claude-subagent", "claude-haiku-5-5", "low"],
  ["resumir o log de deploy", "summary", "claude-subagent", "claude-haiku-5-5", "low"],
  ["fix the null pointer in the invoice parser", "fix", "claude-subagent", "claude-sonnet-5-5", "medium"],
  ["add a retry option to the http client", "feature", "claude-subagent", "claude-sonnet-5-5", "medium"],
  ["review the diff on this branch", "review", "claude-subagent", "claude-opus-5-5", "high"],
  ["use fable to decide the data model", "architecture", "claude-subagent", "claude-fable-5-2", "high"],
  ["do the thing", "feature", "claude-subagent", "claude-sonnet-5-5", "medium"],
];

describe("judge table", () => {
  for (const [text, cls, worker, model, effort] of table) {
    test(text, () => {
      const d = judge(text);
      expect([d.class, d.worker, d.model, d.effort]).toEqual([cls, worker, model, effort]);
      expect(d.reason.length).toBeGreaterThan(0);
    });
  }
  test("large cheap task gets high effort", () => expect(judge("search the whole codebase for callers", {}).effort).toBe("high"));
  test("review needs a fresh context", () => expect(judge("review this").freshContext).toBe(true));
  test("plain architecture wording never climbs to T0", () => expect(judge("improve the architecture of the cache layer").level).not.toBe("top"));
  test("cheap work prefers codex luna when asked and installed", () => {
    const d = judge("find the config", { prefer: "codex", available: { codex: true } });
    expect([d.worker, d.model, d.agentType]).toEqual(["codex", "luna", undefined]);
  });
  test("agy flash when preferred", () => expect(judge("find the config", { prefer: "agy" }).model).toBe("gemini-flash"));
  test("unavailable cli falls back to claude", () => {
    const d = judge("find the config", { prefer: "codex", available: { codex: false } });
    expect(d.worker).toBe("claude-subagent");
    expect(d.reason).toContain("unavailable");
  });
  test("agent type matches the pair", () => expect(judge("fix the bug").agentType).toBe("harness:sonnet-medium"));
});


const real: [string, string][] = [
  ["Revisa o diff da branch", "review"],
  ["Review the changes in PR 42", "review"],
  ["Faça uma revisão do módulo de pagamentos", "review"],
  ["Audit the auth middleware", "review"],
  ["Verifique se o build passa", "explore"],
  ["Check whether the migration ran", "explore"],
  ["Valide o schema do payload", "explore"],
  ["Explique como funciona o cache", "explore"],
  ["Explain the retry flow", "explore"],
  ["Analisar o fluxo de login", "explore"],
  ["Análise do consumo de memória", "explore"],
  ["Investigate why the login crashes", "explore"],
  ["Investigue por que o worker trava", "explore"],
  ["Refatorar o serviço de notificações", "feature"],
  ["Refactor the billing module", "feature"],
  ["Implementa o endpoint de exportação", "feature"],
  ["Write a summary of the last release", "summary"],
  ["Escreva um resumo dos commits da semana", "summary"],
  ["Resuma o log de deploy", "summary"],
  ["Summarize the incident thread", "summary"],
  ["Corrigir o erro de timeout no upload", "fix"],
  ["Fix the off-by-one in pagination", "fix"],
  ["Conserta o teste que está falhando", "fix"],
  ["Add a retry option to the http client", "feature"],
  ["Adicione validação no formulário de cadastro", "feature"],
  ["Create a new endpoint for invoices", "feature"],
  ["Find where the invoice total is computed", "search"],
  ["Onde fica a configuração de CORS?", "search"],
  ["Procura todos os usos de getUser", "search"],
  ["Liste os arquivos que importam o logger", "search"],
  ["Rename getUser to fetchUser", "mechanical"],
  ["Renomear a variável tmp em todo o arquivo", "mechanical"],
  ["Convert the config files from json to yaml", "mechanical"],
  ["Scaffold a new service folder", "mechanical"],
  ["Explore the payments module", "explore"],
  ["nao precisa revisar, so implementa o form", "feature"],
  ["do not fix anything, just explain the flow", "explore"],
  ["Implement the form and review it", "feature"],
  ["adiciona logs e depois revisa", "feature"],
  ["Check whether the migration is safe", "review"],
  ["Verifique se o deploy quebrou algo", "review"],
  ["check where the token is defined", "explore"],
];

describe("realistic task texts", () => {
  for (const [text, cls] of real) test(text, () => expect(judge(text).class).toBe(cls));
});

describe("model overrides", () => {
  test("local yaml replaces ids and ignores junk", () => {
    const over = parseModelOverrides("claude:\n  haiku: my-haiku # note\ncodex:\n  luna: 'x y'\nagy:\n  flash: flash-9\n");
    const merged = mergeModels(DEFAULT_MODELS, over);
    expect(merged.claude.haiku).toBe("my-haiku");
    expect(merged.codex.luna).toBe("luna");
    expect(merged.agy.flash).toBe("flash-9");
    expect(judge("find x", {}, merged).model).toBe("my-haiku");
  });
});

describe("spawn enforcement", () => {
  test("implementing with opus becomes sonnet with passo 0", () => {
    const fix = enforceSpawn({ model: "opus", subagentType: "general-purpose", prompt: "Implement the pagination endpoint", description: "implement pagination" });
    expect([fix.subagentType, fix.model]).toEqual(["harness:sonnet-medium", "sonnet"]);
    expect(fix.prompt.startsWith(PASSO_0)).toBe(true);
  });
  test("review on sonnet becomes opus", () => {
    const fix = enforceSpawn({ subagentType: "harness:sonnet-medium", prompt: "Review the diff", description: "review diff" });
    expect(fix.subagentType).toBe("harness:opus-high");
  });
  test("explore on opus becomes haiku low", () => {
    const fix = enforceSpawn({ model: "claude-opus-5-5", prompt: "Find where routes are declared", description: "find routes" });
    expect([fix.subagentType, fix.model]).toEqual(["harness:haiku-low", "haiku"]);
  });
  test("wrong effort on the right tier is rewritten", () => {
    const fix = enforceSpawn({ subagentType: "harness:sonnet-high", prompt: "Fix the parser bug", description: "fix parser" });
    expect(fix.subagentType).toBe("harness:sonnet-medium");
  });
  test("a correct spawn only gets passo 0, and never twice", () => {
    const base = { subagentType: "harness:sonnet-medium", prompt: "Fix the parser bug", description: "fix parser" };
    const once = enforceSpawn(base);
    expect(once.subagentType).toBe("harness:sonnet-medium");
    expect(enforceSpawn({ ...base, prompt: once.prompt }).changed).toBe(false);
  });
  test("never climbs a tier for implementation", () => {
    expect(enforceSpawn({ model: "haiku", prompt: "Implement the endpoint", description: "implement" }).subagentType).toBeUndefined();
  });
});

describe("plugin copy", () => {
  test("judge core is in sync with src", () => {
    const root = join(import.meta.dir, "..");
    expect(readFileSync(join(root, "claude-plugin/hooks/judge-core.ts"), "utf8")).toBe(readFileSync(join(root, "src/judge/index.ts"), "utf8"));
  });
});
