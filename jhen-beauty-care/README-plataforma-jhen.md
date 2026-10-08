# JHEN beauty care: plataforma de agendamento

Site e sistema de agendamento online para designer de sobrancelhas, com área da cliente, área da profissional e painel administrativo. HTML5, CSS3 e JavaScript puro (ES Modules), com **Supabase** (Auth, Postgres, RLS, Storage e Edge Functions) no backend.

- **Cliente:** cria conta, vê procedimentos e preços, escolhe profissional, data e horário livre, paga (PIX, cartão ou no estúdio), recebe a confirmação, remarca e cancela conforme a política, avalia e edita os próprios dados.
- **Profissional:** vê a agenda do dia, da semana e do mês com os dados necessários da cliente, muda o status do atendimento, pede alterações e consulta o histórico.
- **Administradora:** painel com indicadores e gráficos, e gestão de clientes (incluindo bloqueio e permissões), equipe, procedimentos, agendamentos, pagamentos, horários, feriados, folgas, políticas, galeria e depoimentos.

---

## Sumário

1. [Estrutura do projeto](#1-estrutura-do-projeto)
2. [Identidade visual (arquivos do ZIP)](#2-identidade-visual-arquivos-do-zip)
3. [Arquitetura e segurança](#3-arquitetura-e-segurança)
4. [Configurar o Supabase](#4-configurar-o-supabase-passo-a-passo)
5. [Autenticação](#5-configurar-a-autenticação)
6. [Primeiro administrador, equipe, procedimentos e horários](#6-primeiro-administrador-equipe-procedimentos-e-horários)
7. [Pagamentos (Mercado Pago)](#7-pagamentos-mercado-pago)
8. [Notificações (e-mail, WhatsApp, SMS)](#8-notificações)
9. [Publicar o site](#9-publicar-o-site)
10. [Dados de teste](#10-dados-de-teste)
11. [Testes realizados](#11-testes-realizados)
12. [Observações e próximos passos](#12-observações-e-próximos-passos)

---

## 1. Estrutura do projeto

```
site/
├── index.html                 Página inicial
├── procedimentos.html         Procedimentos e preços
├── contato.html               Contato, mapa e horário
├── agendamento.html           Fluxo de agendamento (5 etapas)
├── login.html · cadastro.html · recuperar-senha.html · redefinir-senha.html
├── 404.html
├── cliente/      dashboard.html · agendamentos.html · perfil.html
├── funcionario/  dashboard.html · agenda.html
├── admin/        dashboard.html · clientes.html · funcionarios.html · procedimentos.html
│                 agendamentos.html · pagamentos.html · configuracoes.html
├── css/
│   ├── style.css         tokens da marca, componentes e páginas públicas
│   ├── dashboard.css     áreas logadas
│   └── responsive.css    breakpoints (mobile primeiro nas decisões de layout)
├── js/
│   ├── config.js         ← URL e chave PÚBLICA do Supabase (único arquivo a editar)
│   ├── supabase.js       cliente Supabase + upload de imagens
│   ├── auth.js           login, cadastro, sessão, proteção por papel
│   ├── data.js           consultas e RPCs compartilhadas
│   ├── utils.js          datas no fuso do negócio, moeda, rótulos, validação, erros
│   ├── ui.js             toast, modal, confirmação, loading, skeleton, estados vazios
│   ├── icons.js          ícones SVG
│   ├── layout.js         cabeçalho, rodapé e menu das áreas logadas
│   ├── calendar.js       calendário com disponibilidade real
│   ├── agendamento.js    fluxo de agendamento
│   ├── pagamentos.js     pagamento (sandbox e Mercado Pago)
│   ├── appointment-actions.js  detalhes, cancelar, remarcar, pagar, avaliar
│   ├── home.js · auth-pages.js · cliente.js · funcionario.js · charts.js
│   └── admin/            admin.js (base) + um módulo por página
├── assets/
│   ├── images/marca/     arquivos ORIGINAIS do ZIP (+ versões .webp otimizadas)
│   ├── images/og-image.jpg
│   └── logo/             logos transparentes derivadas dos originais + favicons
├── supabase/
│   ├── schema.sql        tabelas, constraints, índices, funções, triggers, RLS, grants, storage
│   ├── seed.sql          dados de TESTE (opcional)
│   ├── seed_cleanup.sql  remove os dados de teste
│   ├── cron.sql          tarefas agendadas (opcional)
│   └── functions/        Edge Functions: create-payment, payment-webhook,
│                         invite-employee, send-notifications
├── vercel.json · _headers   cabeçalhos de segurança (CSP etc.)
└── README.md
```

Não há etapa de build: os arquivos rodam como estão em qualquer hospedagem estática.

---

## 2. Identidade visual (arquivos do ZIP)

O ZIP `site-jheny.zip` trouxe **seis arquivos de marca**, todos preservados sem alteração em `assets/images/marca/`:

| Arquivo original | O que é | Onde é usado |
|---|---|---|
| `jhen-beauty-care.jpeg` | Wordmark "JHEN beauty care" creme sobre degradê rosé | Hero (moldura em cápsula), fundo da tela de login, imagem Open Graph |
| `jhen-logo.jpeg` | Estampa "JHEN" repetida em vinho sobre blush | Seção "Sobre" (moldura em arco), fundo das telas de cadastro e nova senha |
| `libelula.jpeg` | Libélula (símbolo) creme sobre degradê | Galeria vazia (estado inicial) |
| `libelulas.jpeg` | Estampa de libélulas moca sobre rosé antigo | Faixa de chamada "Agendar agora", miniaturas de procedimentos sem foto |
| `pink-j.jpeg` | Monograma "J" em cápsula, creme sobre degradê | Fonte do monograma transparente e do favicon |
| `white-j.jpeg` | Monograma "J" vinho sobre branco | Referência de cor do vinho |

**Arquivos derivados** (gerados a partir dos originais, sem redesenhar) em `assets/logo/`:

- `logo-jhen-vinho.png` / `logo-jhen-creme.png`: wordmark com fundo transparente (cabeçalho, rodapé, menu lateral e telas de login).
- `libelula-vinho.png` / `libelula-creme.png`: ornamentos e estados de carregamento/vazios.
- `monograma-j-vinho.png` / `monograma-j-creme.png`: selo na seção "Sobre" e QR de demonstração.
- `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`: a partir do monograma.
- Versões `.webp` (inteira e 640px) de cada original para performance.

A **cápsula do monograma J** virou o motivo estrutural do site: molduras de imagem, miniaturas e a data do próximo horário usam esse formato.

### Paleta (extraída dos pixels das imagens)

| Token CSS | HEX | Origem |
|---|---|---|
| `--color-primary` | `#A0585C` | vinho das letras (`jhen-logo.jpeg`, `white-j.jpeg`) |
| `--color-primary-strong` | `#7E4246` | vinho escurecido para hover, rodapé e menu lateral |
| `--color-secondary` | `#BB8E88` | rosé antigo, fundo de `libelulas.jpeg` |
| `--color-mocha` | `#956C66` | traço das libélulas |
| `--color-accent` | `#CFA090` | nude pêssego do degradê |
| `--color-rose` / `--color-rose-deep` | `#D6ABA4` / `#BA7F7B` | tons do degradê de fundo |
| `--color-cream` | `#F4EBE2` | creme do wordmark |
| `--color-blush` | `#F2DCD1` | blush claro de `jhen-logo.jpeg` |
| `--color-background` | `#FBF5F1` | fundo principal (blush `#F8EEE6` clareado) |
| `--color-surface` / `--color-surface-alt` | `#FFFDFB` / `#F6ECE6` | cartões e seções alternadas |
| `--color-text` | `#3D2627` | vinho-cacau para textos (contraste AA em todos os fundos claros) |
| `--color-text-muted` | `#75585A` | textos secundários |
| `--color-border` | `#E7D3CB` | bordas |
| sucesso / alerta / erro | `#4E7A5B` / `#9A6A1E` / `#B03A3E` | estados, ajustados para combinar com a paleta |

Sobre o contraste: creme sobre o degradê rosé dá cerca de 2:1, o que não basta para texto. Por isso o creme aparece só sobre o vinho (botões, rodapé, menu lateral), e os textos ficam em `#3D2627`.

### Tipografia

O ZIP não incluía arquivos de fonte. O logo usa uma serifa de alto contraste e "beauty care" em sans geométrica espaçada. Escolhas equivalentes (ambas com licença livre, SIL OFL):

- **Cormorant Garamond**: títulos, preços e números de destaque.
- **Jost**: textos e interface. As etiquetas de seção imitam o "b e a u t y  c a r e" do logo (minúsculas com espaçamento largo).

As fontes vêm do Google Fonts. Para hospedá-las localmente (melhor para LGPD), baixe os `.woff2` para `assets/fonts/`, declare com `@font-face` em `css/style.css` e remova o `<link>` do Google Fonts das páginas.

---

## 3. Arquitetura e segurança

- **Sem segredo no navegador.** O front só tem a URL e a chave pública (`anon`). Tokens do gateway e a `service_role` ficam nos Secrets das Edge Functions.
- **RLS em todas as 16 tabelas.** A cliente vê só os próprios dados, a profissional só os próprios atendimentos (sem dados financeiros) e a administradora gerencia tudo.
- **Escritas sensíveis só via funções do banco** (`security definer`), que revalidam tudo no servidor: `book_appointment`, `cancel_appointment`, `reschedule_appointment`, `update_appointment_status`. Cliente e profissional não conseguem inserir ou alterar agendamentos direto na tabela.
- **Anti-conflito à prova de corrida:** `appointments` tem uma *exclusion constraint* (`btree_gist`) que impede dois atendimentos sobrepostos da mesma profissional. Se dois clientes confirmarem o mesmo horário ao mesmo tempo, o banco aceita um e o outro recebe "Este horário acabou de ser reservado por outro cliente."
- **A disponibilidade considera** duração do procedimento, horário de funcionamento, horários especiais, intervalo do estúdio e da profissional, jornada de cada profissional, feriados, folgas, férias, bloqueios de dia e de horário, agendamentos existentes, antecedência mínima e máxima.
- **Reserva com prazo:** agendamento com pagamento online fica como "Aguardando pagamento" por `payment_hold_minutes` (padrão 15). Se não for pago, o horário volta a ficar livre.
- **Papel nunca vem do cliente:** todo cadastro nasce `client`, e um trigger impede a usuária de alterar o próprio papel, bloqueio ou e-mail.
- **Pagamentos:** a tabela guarda só ID e status do gateway, valor, método, data, cliente e agendamento. Nenhum dado de cartão passa pelo site (o cartão é digitado no checkout do Mercado Pago).
- **Cabeçalhos HTTP:** `vercel.json` e `_headers` aplicam Content-Security-Policy, HSTS, nosniff e Referrer-Policy.

---

## 4. Configurar o Supabase (passo a passo)

1. **Crie o projeto** em [supabase.com](https://supabase.com) → *New project*. Escolha a região **South America (São Paulo)** e guarde a senha do banco.
2. **Execute o SQL:** *SQL Editor* → *New query* → cole todo o conteúdo de `supabase/schema.sql` → *Run*. O script é idempotente, então pode ser executado de novo depois de alterações.
3. **(Opcional) Dados de teste:** execute `supabase/seed.sql` para ter procedimentos, profissionais e clientes fictícias (seção 10). Antes de publicar, rode `supabase/seed_cleanup.sql`.
4. **Chaves públicas:** *Project Settings → API*. Copie a **Project URL** e a **anon public key** para `js/config.js`:

   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```

   A anon key é pública por design: quem protege os dados é o RLS. **Nunca** coloque a `service_role` nesse arquivo.
5. **Storage:** o `schema.sql` já cria o bucket público `media` (procedimentos, galeria, fotos de perfil e da equipe) com as policies. Só a administradora envia imagens de site; cada usuária só envia a própria foto, em `avatars/<id>/`.
6. **Data API:** em *Project Settings → API → Exposed schemas*, confirme que `public` está exposto.

---

## 5. Configurar a autenticação

Em *Authentication → URL Configuration*:

- **Site URL:** o endereço final do site, ex. `https://jhenbeautycare.com.br`.
- **Redirect URLs:** adicione `https://jhenbeautycare.com.br/**` (e `http://localhost:5500/**` se for testar localmente).

Em *Authentication → Providers → Email*:

- Mantenha **Confirm email** ligado em produção. A cliente recebe o link e depois entra; o site mostra a mensagem certa nos dois casos.
- Senha mínima: 8 caracteres (o site já valida).

Em *Authentication → Emails (Templates)*, traduza os modelos para português. Os links já apontam para as páginas certas:

- *Reset password* → `redefinir-senha.html`
- *Confirm signup* → `login.html?confirmado=1`
- *Change email address* → `cliente/perfil.html?email=confirmado`

**SMTP próprio (recomendado):** o envio padrão do Supabase tem limite baixo por hora. Configure um provedor (Resend, Brevo, Amazon SES) em *Authentication → SMTP Settings*.

**Troca de e-mail** usa o fluxo seguro do Supabase: a troca só acontece depois da confirmação por link.

---

## 6. Primeiro administrador, equipe, procedimentos e horários

### Criar o primeiro administrador
1. Abra o site e crie uma conta normal em **Criar conta** com o e-mail da dona do negócio.
2. No *SQL Editor* do Supabase, execute (trocando o e-mail):

   ```sql
   update public.profiles set role = 'admin' where email = 'seu-email@dominio.com';
   ```
3. Saia e entre de novo: você cai no **Painel**. Para promover outras pessoas depois, use *Clientes → ícone de escudo (Permissões)*.

Se a administradora também atende, cadastre-a em **Equipe** com o próprio e-mail. Ela continua admin e passa a aparecer no agendamento, com o atalho "Minha agenda de atendimentos" no menu.

### Cadastrar profissionais
1. A profissional cria a conta pelo site.
2. *Admin → Equipe → Adicionar profissional* → informe o e-mail da conta, o nome exibido e o cargo.
3. Em **Editar**, marque os procedimentos que ela realiza e a jornada de cada dia ("Igual ao estúdio", "Horário próprio" ou "Não trabalha").

Para convidar por e-mail quem ainda não tem conta, publique a função `invite-employee` (seção 7). Sem ela, o botão avisa para a pessoa se cadastrar primeiro.

### Cadastrar procedimentos
*Admin → Procedimentos → Novo procedimento*: nome, descrição, preço, duração, imagem, ordem, cobrança (**integral online**, **sinal online + restante no local** ou **presencial**), se aceita pagar no local, profissionais habilitadas e status. Procedimento com histórico não pode ser excluído; desative-o para tirá-lo do site.

### Horários, feriados, folgas e políticas
*Admin → Configurações*:

- **Funcionamento:** aberto/fechado, abertura, fechamento e intervalo de cada dia.
- **Feriados e datas especiais:** feriados fecham o dia; datas especiais substituem o horário normal.
- **Folgas e bloqueios:** folgas, férias e bloqueios de dias (por profissional ou para todas) e de faixas de horário.
- **Políticas:** prazo de cancelamento gratuito, taxa de cancelamento tardio (%), perda do sinal, reembolso, prazo e limite de remarcações, texto exibido para a cliente, intervalo entre horários, antecedência mínima e máxima.
- **Pagamentos:** modo de teste ou Mercado Pago, pagamento no estúdio e tempo de reserva.
- **Contato e avisos:** WhatsApp, Instagram, e-mail, endereço, mapa e canais de notificação.
- **Galeria e depoimentos:** fotos de resultados e moderação das avaliações.

---

## 7. Pagamentos (Mercado Pago)

O site vem em **modo de teste (sandbox)**: o passo de pagamento mostra botões "Simular pagamento aprovado" e "Simular falha", sem cobrança. O modo só funciona enquanto `settings.payment_provider = 'sandbox'`.

### Ativar o Mercado Pago
1. Crie uma aplicação em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers) → *Suas integrações*. Copie o **Access Token** (comece pelo de *teste*).
2. Instale a [Supabase CLI](https://supabase.com/docs/guides/cli) e vincule o projeto:
   ```bash
   supabase login
   supabase link --project-ref <PROJECT_REF>
   ```
3. Cadastre os segredos, que **ficam só no servidor**:
   ```bash
   supabase secrets set MP_ACCESS_TOKEN=APP_USR-... \
                        MP_WEBHOOK_SECRET=<assinatura secreta do passo 5> \
                        SITE_URL=https://jhenbeautycare.com.br \
                        ALLOWED_ORIGINS=https://jhenbeautycare.com.br
   ```
4. Publique as funções:
   ```bash
   supabase functions deploy create-payment
   supabase functions deploy payment-webhook --no-verify-jwt
   supabase functions deploy invite-employee        # opcional
   ```
5. No painel do Mercado Pago → *Webhooks*: URL `https://<PROJECT_REF>.supabase.co/functions/v1/payment-webhook`, evento **Pagamentos**. Copie a **assinatura secreta** gerada para `MP_WEBHOOK_SECRET` (passo 3).
6. No site: *Admin → Configurações → Pagamentos → Mercado Pago (produção)*.

### Como funciona
- **PIX:** `create-payment` cria o pagamento com o valor lido do banco e mostra QR Code e "copia e cola". O site consulta o status a cada 4 segundos.
- **Cartão:** a cliente vai para o **Checkout Pro** do Mercado Pago, digita o cartão lá e volta para "Meus agendamentos".
- **Confirmação oficial:** `payment-webhook` valida a assinatura `x-signature`, consulta o pagamento na API do Mercado Pago (não confia no corpo da notificação), confere se o valor pago cobre o cobrado e atualiza o banco. O trigger confirma o agendamento e notifica a cliente.
- **Sinal:** procedimentos com cobrança por sinal cobram só o sinal online; o restante aparece como pendente para pagar no estúdio.
- **Pagamento no estúdio:** a administradora dá baixa em *Pagamentos → Marcar como pago*.
- **Estornos:** cancelamentos com reembolso deixam o pagamento como "Estorno pendente". Faça o estorno no painel do Mercado Pago e clique em *Registrar estorno*.

Para usar Stripe ou outro gateway, mantenha a mesma interface: uma função que cria a cobrança e um webhook que chama `public.apply_payment_update(...)`.

---

## 8. Notificações

Toda mudança importante gera uma notificação automaticamente (triggers no banco): agendamento confirmado, horário reservado aguardando pagamento, pagamento aprovado ou recusado, cancelamento, remarcação, lembrete, pedido de alteração da equipe e alerta de estorno.

- **No site:** aparecem na área da cliente e no painel da administradora.
- **Fora do site (estrutura pronta):** marque os canais em *Configurações → Contato e avisos*. Cada notificação gera uma cópia "pendente" por canal (fila na tabela `notifications`).
- **Envio:** a Edge Function `send-notifications` lê a fila e envia por **e-mail (Resend)**, **WhatsApp (Cloud API da Meta)** ou **SMS (Twilio)**. Configure só os canais que usar:
  ```bash
  supabase secrets set CRON_SECRET=<senha-longa> RESEND_API_KEY=... EMAIL_FROM="JHEN <agenda@seudominio.com>"
  supabase secrets set WHATSAPP_TOKEN=... WHATSAPP_PHONE_ID=...      # requer template aprovado pela Meta
  supabase functions deploy send-notifications --no-verify-jwt
  ```
- **Agendamento das tarefas:** habilite `pg_cron` e `pg_net` em *Database → Extensions* e execute `supabase/cron.sql` (troque `<PROJECT_REF>` e `<CRON_SECRET>`). Isso cria lembretes 24h antes, libera reservas expiradas e envia a fila a cada 5 minutos.

---

## 9. Publicar o site

O site é estático. Qualquer uma das opções abaixo funciona:

- **Vercel:** importe a pasta ou o repositório (*Framework: Other*, sem build). O `vercel.json` aplica os cabeçalhos de segurança.
- **Netlify / Cloudflare Pages:** publique a pasta. O arquivo `_headers` aplica os mesmos cabeçalhos.
- **Hospedagem comum (cPanel):** envie todos os arquivos por FTP para `public_html`.

Depois de publicar:
1. Configure o domínio próprio com HTTPS.
2. Atualize **Site URL** e **Redirect URLs** no Supabase (seção 5) e o secret `SITE_URL`.
3. Troque `og:image` pela URL absoluta se quiser pré-visualização garantida em todas as redes sociais.
4. Teste um agendamento real de ponta a ponta com o token de **teste** do Mercado Pago antes de trocar para o de produção.

### Checklist de produção
- [ ] `js/config.js` com URL e anon key do projeto
- [ ] `supabase/seed_cleanup.sql` executado (remove dados e contas de teste)
- [ ] Administradora criada e textos da seção "Sobre" revisados
- [ ] Contato, endereço, mapa e horários em *Configurações*
- [ ] Procedimentos, preços e profissionais revisados
- [ ] SMTP próprio e templates de e-mail em português
- [ ] Mercado Pago ativado e webhook testado, sandbox desligado
- [ ] Fotos reais na galeria
- [ ] `cron.sql` executado (lembretes e limpeza)

---

## 10. Dados de teste

Criados por `supabase/seed.sql`, **todos fictícios** e identificados: nomes com "(teste)", e-mails `@example.com`, coluna `is_test_data = true` e selo "teste"/"exemplo" na interface.

| Papel | E-mail | Senha |
|---|---|---|
| Profissional | `ana.teste@example.com` | `Teste@1234` |
| Profissional | `bianca.teste@example.com` | `Teste@1234` |
| Cliente | `carla.teste@example.com` | `Teste@1234` |
| Cliente | `daniela.teste@example.com` | `Teste@1234` |
| Cliente | `elaine.teste@example.com` | `Teste@1234` |

Procedimentos: **Design de Sobrancelhas** (R$ 40, 40 min), **Design + Henna** (R$ 60, 60 min), **Brow Lamination** (R$ 120, 90 min, sinal de R$ 40), mais Micropigmentação e Manutenção como exemplos. Também há histórico de atendimentos, próximos agendamentos, feriados nacionais e três depoimentos de exemplo.

A conta de administradora não vem no seed: crie a sua pelo passo da seção 6.

---

## 11. Testes realizados

Ambiente de teste local equivalente ao Supabase: Postgres 16, **GoTrue** (o servidor de Auth do Supabase), **PostgREST**, servidor de e-mail falso e Chromium com Playwright, com a mesma Content-Security-Policy de produção.

| Bateria | Resultado |
|---|---|
| Segurança e regras de negócio direto na API (RLS, escalada de privilégio, disponibilidade, bloqueios, cancelamento, remarcação, sinal, expiração da reserva) | 84/84 |
| Corrida: 8 clientes confirmando o mesmo horário ao mesmo tempo | 1 reserva, 7 recusadas com mensagem clara |
| E2E cliente (desktop e celular): navegação, cadastro, agendamento com pagamento recusado e aprovado, remarcar, cancelar, avaliar, perfil, recuperação de senha por e-mail | 37/37 |
| E2E profissional e administradora: agenda, status, pedido de alteração e todos os cadastros do painel | 36/36 |
| Edge Functions de pagamento rodando no Deno contra Mercado Pago simulado: PIX, cartão, assinatura do webhook, valor divergente, idempotência | 22/22 |

Problemas encontrados e corrigidos durante os testes:
- Falha de permissão no cancelamento (comparação com `NULL` no SQL) que permitiria a uma cliente cancelar o agendamento de outra.
- Menu mobile fechado que alargava a página no celular.
- Botão "Avaliar" aparecendo em atendimento já avaliado.
- Logout que às vezes mostrava "sessão expirada".
- Detalhes visuais: barras do gráfico, capitalização de datas e ícone do menu.

Não foram testados aqui: o upload real para o Storage (não há servidor de Storage no ambiente local; as policies estão no `schema.sql`) e a chamada real à API do Mercado Pago (simulada com o mesmo formato de requisição e resposta).

---

## 12. Observações e próximos passos

- **Fotos:** o ZIP trouxe só a identidade visual, sem fotos de procedimentos, de resultados ou da profissional. O site não usa nenhuma imagem inventada. Os procedimentos sem foto mostram a estampa de libélulas, e a galeria mostra um convite ao Instagram até a administradora enviar fotos reais (*Configurações → Galeria e depoimentos*).
- **Textos:** a apresentação "Olá, eu sou a Jhenyfer" (em `index.html`) é um texto-base para a Jhenyfer revisar com a história e as credenciais dela.
- **Fuso horário:** `America/Sao_Paulo` (em `settings.timezone`). O Brasil não tem horário de verão desde 2019; a Edge Function `create-payment` usa o offset `-03:00`.
- **LGPD:** o cadastro pede consentimento. Para atender pedidos de exclusão, use *Authentication → Users → Delete user* no Supabase (agendamentos com histórico financeiro devem ser anonimizados antes, conforme a sua política).
