# dot dot dot — Figma Plugin

Transforma uma imagem no estilo **dot matrix / pill halftone**: cada linha vira uma
sequência de **pílulas** (cápsulas de comprimento variável) e **pontos** isolados, sobre
fundo preto. O resultado sai como **vetores editáveis** no Figma — cada pílula/ponto é um
nó que você pode mover, recolorir ou apagar. Também gera **formas aleatórias** procedurais.

Grátis e aberto (MIT). Compartilhe à vontade.

## O que dá pra fazer

- **Imagem → dot matrix** — selecione um objeto com preenchimento de imagem e converta.
  Detecta transparência (modo silhueta) ou usa luminância (fotos).
- **Formas aleatórias** — clique na carinha 🙂 e gere arte procedural em 4 estilos:
  **Nuvem** (ruído orgânico), **Explosão** (starburst), **Poeira** (pontos espalhados) e
  **Simétrico** (kaleidoscópico).
- **Controles** — densidade, threshold/preenchimento, tamanho do dot, espaçamento, inverter
  e, no aleatório, **largura do dot** (encurta as pílulas até virarem quadrados 1:1).
- **Expandir** — aumenta a janela e dá todo o espaço extra pro preview, mantendo os
  controles do tamanho normal.
- **Imagens grandes** — células consecutivas viram uma única pílula (run-length), mantendo
  a contagem de nós baixa. Saída limitada a 1500px no lado maior.

## Instalar (sem programar)

1. Baixe este repositório (botão verde **Code → Download ZIP**) e descompacte.
2. No **Figma Desktop**: `Plugins → Development → Import plugin from manifest…`
3. Selecione o arquivo `manifest.json` da pasta.

A pasta `dist/` já vem pronta, então **não precisa instalar nada** pra usar.

## Rodar do código (desenvolvimento)

```bash
npm install
npm run build
```

Depois importe o `manifest.json` como acima. Use `npm run watch` para rebuildar a cada
alteração (é só rodar o plugin de novo no Figma).

## Como usar

1. Rode o plugin em `Plugins → Development → dot dot dot`.
2. **Para uma imagem:** selecione no canvas um objeto com preenchimento de imagem.
   **Para forma aleatória:** clique na carinha 🙂 e escolha um estilo.
3. Ajuste os sliders vendo o preview ao vivo (branco sobre preto).
4. Clique **Gerar** — cria um grupo `Dot Matrix` com fundo preto e dots/pílulas brancos
   vetoriais, selecionáveis individualmente.

## Estrutura

- `src/code.ts` — thread principal: lê a imagem selecionada e cria os nós vetoriais.
- `src/ui.ts` / `src/ui.html` — UI (iframe): processamento de imagem, gerador aleatório,
  preview e controles.
- `src/shared.ts` — tipos das mensagens `postMessage`.
- `build.js` — bundle via esbuild; injeta o JS da UI inline em `dist/ui.html`.

## Licença

[MIT](LICENSE) — uso livre, inclusive comercial.
