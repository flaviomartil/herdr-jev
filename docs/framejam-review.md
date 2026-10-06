O FrameJam vale testar como **companheiro de revisão de vídeos no Harness**, mantendo o herdr-jev como coordenador. A recomendação é integrar o produto existente por MCP, sem copiar seu editor ou trocar nossa ferramenta de renderização.

Análise em 05/10/2026, no [commit `c0358fc`](https://github.com/moritzkremb/framejam/tree/c0358fc9aa3089f356508b578b1f946653c3b6d1). Foi uma inspeção de documentação e código; não houve instalação, execução dos testes upstream ou validação de um vídeo real.

| Recurso | Uso possível no nosso fluxo | Decisão |
|---|---|---|
| Comentários com timestamp e imagem do frame | Dar instruções precisas para corrigir um vídeo já renderizado | Principal motivo para um piloto |
| Rodadas e versões de revisão | Manter comentários ligados à versão que o usuário viu | Reutilizar pelo MCP |
| Storyboard com imagens | Revisar sequência e composição antes de renderizar o vídeo | Avaliar no mesmo piloto |
| Presets de estilo | Receber paleta, fontes, animações e templates | Opcional; os templates são de Hyperframes |
| Player vivo com identificação de elemento e tween | Ajustar uma composição Hyperframes com precisão | Depois; o upstream o marca como beta |

O diferencial é o ciclo de feedback humano: o agente entrega o render, o usuário comenta e termina a revisão, o agente recebe os comentários e entrega outra versão. MP4s de Remotion, ffmpeg e outros renderizadores podem ser revisados; a identificação de elemento/GSAP depende do player Hyperframes. Isso complementa nosso fluxo de mídia, que já registra `agyforge`, `deck-gen`, `paperbanana` e `video-engine` em `produce-media`. Não há motivo para criar outro renderizador no herdr-jev. Fontes: [README](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/README.md), [MCP](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/src/server/mcp.ts).

O servidor expõe nove ferramentas: `open_review`, `wait_for_feedback`, `get_feedback`, `list_reviews`, `resolve_comments`, `add_version`, `list_presets`, `get_preset` e `get_selected_preset`. Suporta stdio e HTTP; a CLI usa `127.0.0.1` como host padrão. A versão no `package.json` é `0.1.3`, com Node 22+ e licença MIT; o README também pede ffmpeg. Os projetos ficam em JSON local, com escrita por arquivo temporário e rename. Isso não é memória de agentes e não substituiria Ruflo. Fontes: [manifesto](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/package.json), [CLI](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/src/server/cli.ts), [armazenamento](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/src/server/store.ts).

Para o piloto, eu usaria um MP4 já produzido pelo fluxo atual, abriria uma revisão, receberia um comentário num instante específico e entregaria uma segunda versão. Os critérios de aceite seriam: imagem/timestamp corretos, comentários associados à versão correta, consulta recuperável após reconexão e resolução ligada à nova versão. `wait_for_feedback` tem timeout configurável e retorna pendência; uma integração deve esperar de forma limitada e permitir retomada, sem manter um agente bloqueado indefinidamente. Uma eventual ponte com a inbox do Harness registraria apenas a necessidade de atenção e a referência da revisão, sem interpretar o comentário como autorização para executar comandos.

O instalador upstream altera configurações MCP dos clientes e instala a skill globalmente via `npx skills add`. Aqui, uma adoção deve passar pelo catálogo compartilhado do Harness e pelo armazenamento canônico de skills, preservando as configurações atuais. No WSL, o acesso do navegador ao serviço local também precisa ser validado no piloto. A skill upstream descreve seu fluxo; foi consultada como fonte, sem executar suas instruções. Fontes: [instalador](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/src/server/install.ts), [skill upstream](https://github.com/moritzkremb/framejam/blob/c0358fc9aa3089f356508b578b1f946653c3b6d1/skills/framejam/SKILL.md).

Eu deixaria fora do primeiro teste: fork da UI, cópia de presets, mudança obrigatória para Hyperframes e conexão automática de todos os clientes. A utilidade principal já pode ser medida com um render e duas rodadas de revisão.

Learning Review: nenhuma skill foi criada ou atualizada; a recomendação ainda depende de validação em uso real.
