# Próxima análise: Jev no harness, vídeo da LangChain

Solicitação de Flavio: analisar depois de terminar a integração atual entre AI Harness e herdr-jev. Fonte: transcrição WEBVTT fornecida na conversa em 2026-09-22; sem URL identificada. Nenhuma instalação ou adoção automática autorizada por este registro.

Pontos a confrontar com o código existente:

- 01:46–02:22: estado + perguntas produzem respostas tipadas e probabilidades. Verificar os contratos do evaluator, sem tratar classificação como geração ou raciocínio aberto.
- 04:28–05:14: `choice`, `score` e resposta booleana (a legenda diz “null”; conferir o nome `noul` no SDK instalado). Preservar distribuição, confiança e abstinência; não confundir score ordinal com probabilidade.
- 05:16–05:35: agrupar várias perguntas sobre o mesmo estado numa chamada; verificar se o evaluator já faz isso e medir economia antes de alterar.
- 06:04–06:47: roteamento por complexidade. Jev recomenda; perfis, disponibilidade e decisão executável continuam canônicos no Harness.
- 06:47–07:28: avaliação de risco de chamadas. No setup atual, aproveitar somente sinal observacional; hooks não bloqueiam execução nem criam aprovações adicionais.
- 07:29–08:44: avaliações online com rubrica, referência e evidência de fundamentação. Investigar como sinal auxiliar, sem substituir testes determinísticos ou revisão independente do mesmo snapshot.
- 05:35–06:00 e 08:51–09:01: integração LangChain/TypeSafe. O projeto já usa o SDK TypeSafe; adicionar LangChain somente diante de uma lacuna concreta.

As alegações de velocidade, custo e confiabilidade no vídeo são relatos da apresentação, não resultados medidos neste ambiente. Próximo passo: mapear cada ideia para implementação existente, lacuna verificável e avaliação mínima.
