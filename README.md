# Renomeador de PDF por Código de Rastreamento (Correios/Transportadora)

Sistema web desenvolvido em Node.js para automatizar o renomeamento de arquivos PDF com base em códigos de rastreamento encontrados internamente no documento.

## 🚀 Funcionalidades

*   **Extração Automática**: Lê o texto do PDF e localiza o padrão `(RASTREAMENTO) : [CÓDIGO]`.
*   **Correção Inteligente (Fuzzy Match)**: Corrige erros comuns de digitalização ou fonte desconfigurada (Ex: entende que `S` é `5`, `O` é `0`, `B` é `8` nos códigos).
*   **Relatório de Erros**: Se enviar um lote misto, o sistema processa os arquivos válidos e gera uma lista clara dos arquivos inválidos (imagens sem texto, sem código, etc.).
*   **Auto-Cleanup**: Arquivos processados são automaticamente baixados e removidos do servidor para economizar espaço.
*   **Implantação Facilitada**: Gera um ZIP pronto para upload em painéis como DirectAdmin (Node.js Selector).

## 📋 Pré-requisitos

*   Node.js (v14 ou superior)
*   NPM

## 🔧 Instalação Local

1.  Clone o repositório:
    ```bash
    git clone https://github.com/AdrianoDevequi/renomeia-pdf-por-codigo.git
    cd renomeia-pdf-por-codigo
    ```

2.  Instale as dependências:
    ```bash
    npm install
    ```

3.  Inicie o servidor:
    ```bash
    npm start
    ```

4.  Acesse `http://localhost:3000` no seu navegador.

## 📦 Como Usar

1.  Arraste seus arquivos PDF (um ou vários) para a área de upload.
2.  Clique em **"Processar e Baixar"**.
3.  O sistema irá:
    *   Renomear os arquivos encontrados (Ex: `AB123456789BR.pdf`).
    *   Gerar um ZIP se houver múltiplos arquivos.
    *   Mostrar um alerta caso algum arquivo não possa ser processado.

## ☁️ Deploy (DirectAdmin/CPanel)

1.  Gere o arquivo de deploy (se tiver o script):
    ```bash
    node create_deploy_zip.js
    ```
2.  Ou compacte manualmente os arquivos (exceto `node_modules` e `uploads`).
3.  No seu painel de hospedagem (Node.js App):
    *   Faça upload dos arquivos.
    *   Instale as dependências (`npm install` no painel).
    *   Inicie o app.

## 🛡️ Solução de Problemas

*   **Erro 503**: Verifique se a pasta `uploads` existe e tem permissão de escrita.
*   **Travamento**: O servidor já está configurado com `X-Accel-Buffering: no` para evitar timeouts em proxies Nginx.

---
Desenvolvido com ❤️ e Node.js.
