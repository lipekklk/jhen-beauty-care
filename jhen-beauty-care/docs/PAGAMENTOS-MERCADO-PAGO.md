# Pagamentos com Mercado Pago (Checkout Pro)

Guia da integração de pagamentos online da plataforma JHEN beauty care.

- **O que se compra:** um procedimento agendado (valor integral ou sinal).
- **O que libera o "acesso":** o horário só é confirmado depois que o Mercado Pago aprova o pagamento.
- **Formas aceitas:** cartão de crédito, cartão de débito e Pix, todos no ambiente do Mercado Pago. Boleto e lotérica ficam desativados: a reserva do horário dura minutos e esses meios levam dias para compensar.

Sumário
1. [Como funciona](#1-como-funciona)
2. [Arquivos criados e alterados](#2-arquivos-criados-e-alterados)
3. [Configurar a conta do Mercado Pago](#3-configurar-a-conta-do-mercado-pago)
4. [Credenciais e variáveis de ambiente](#4-credenciais-e-variáveis-de-ambiente)
5. [Configurar o Supabase](#5-configurar-o-supabase)
6. [Configurar o webhook](#6-configurar-o-webhook)
7. [Testar com contas de teste](#7-testar-com-contas-de-teste)
8. [Conferir se o webhook está funcionando](#8-conferir-se-o-webhook-está-funcionando)
9. [Como o horário é liberado](#9-como-o-horário-é-liberado)
10. [Estornos, cancelamentos e contestações](#10-estornos-cancelamentos-e-contestações)
11. [Colocar em produção](#11-colocar-em-produção)
12. [Segurança](#12-segurança)
13. [Solução de problemas](#13-solução-de-problemas)

---

## 1. Como funciona

```
Cliente            Site (navegador)          Edge Functions (Supabase)         Mercado Pago
   │  escolhe horário   │                              │                              │
   │──────────────────▶│ book_appointment (RPC)       │                              │
   │                    │── reserva horário + pagamento "pendente" (valor do BANCO)  │
   │  "Pagar com MP"    │                              │                              │
   │──────────────────▶│── create-payment ──────────▶│── POST /checkout/preferences ─▶│
   │                    │◀──────── link do checkout ───│◀────────── init_point ────────│
   │◀──── redireciona para o Mercado Pago ─────────────────────────────────────────────│
   │  digita cartão / paga Pix no ambiente do Mercado Pago                              │
   │                    │                              │◀── Webhook assinado ──────────│
   │                    │                              │── GET /v1/payments/{id} ─────▶│
   │                    │                              │── apply_gateway_payment (banco)│
   │                    │                              │   aprovado → horário confirmado│
   │◀─ volta para pagamento.html ─│── sync-payment ───▶│── consulta o MP de novo ──────▶│
   │   (mostra o status do BANCO, nunca o da URL)                                      │
```

Pontos-chave:
- O **valor** vem sempre do banco. O navegador só envia o ID do pagamento.
- A **confirmação oficial** é o webhook assinado. A página de retorno também pede ao servidor para consultar o Mercado Pago (útil se o webhook atrasar), mas nunca confia nos parâmetros da URL.
- A reserva do horário dura `payment_hold_minutes` (padrão 15). O checkout expira junto com ela.
- Se o pagamento falhar, a cliente pode tentar de novo enquanto a reserva valer (na própria página de retorno ou em *Minhas compras*).

### Estados do pagamento

| Status no Mercado Pago | Status no sistema | Horário |
|---|---|---|
| `pending` (ex.: Pix aguardando) | Pendente | Reservado, **não** confirmado |
| `in_process`, `authorized` | Em análise | Reservado, **não** confirmado |
| `approved` | Aprovado | **Confirmado** |
| `rejected` | Recusado | Reservado; pode tentar de novo |
| `cancelled` | Cancelado | Não confirmado |
| `refunded` (total) | Estornado | **Cancelado** (se ainda for futuro) |
| `approved` com valor devolvido parcial | Estornado (parcial) | Mantido |
| `in_mediation` | Em disputa | Mantido; administradoras avisadas |
| `charged_back` | Contestado | **Cancelado**; administradoras avisadas |

---

## 2. Arquivos criados e alterados

**Criados**
| Arquivo | Função |
|---|---|
| `supabase/functions/create-payment/index.ts` | Cria a preferência do Checkout Pro com o valor do banco e devolve o link do Mercado Pago |
| `supabase/functions/payment-webhook/index.ts` | Recebe o webhook, valida a assinatura, consulta a API e aplica o resultado |
| `supabase/functions/sync-payment/index.ts` | Consulta o status real no Mercado Pago (página de retorno e botão do painel) |
| `supabase/functions/refund-payment/index.ts` | Faz estornos pela API (valor calculado no banco) |
| `supabase/functions/_shared/mercadopago.ts` | Cliente da API, validação da assinatura, aplicação do estado, estorno automático |
| `supabase/functions/.env.example` | Lista das variáveis de ambiente, sem valores reais |
| `supabase/migrations/20261012_mercadopago.sql` | Atualiza um banco que já tinha a versão anterior |
| `pagamento.html` + `js/pagamento-retorno.js` | Página de retorno (aprovado, pendente, recusado, cancelado, estornado) |
| `cliente/compras.html` | *Minhas compras* da cliente |
| `.gitignore` | Impede versionar arquivos `.env` |
| `docs/PAGAMENTOS-MERCADO-PAGO.md` | Este guia |

**Alterados**
| Arquivo | Mudança |
|---|---|
| `supabase/schema.sql` | Novos status (`in_process`, `charged_back`, `in_mediation`) e método `online`; colunas do Mercado Pago em `payments`; tabelas `payment_events` (auditoria) e `api_rate_limits`; view `purchases`; função `apply_gateway_payment`; trigger `guard_payment_changes`; simulador antigo removido; permissões revisadas |
| `supabase/functions/_shared/utils.ts` | CORS por lista de origens, leitura de JSON com limite, limite de requisições, logs sem dados pessoais |
| `supabase/seed.sql` | Pagamentos de teste no formato novo |
| `js/pagamentos.js` | Só pede o link ao servidor e redireciona; nunca recebe dados de cartão |
| `js/agendamento.js` | Opção "Pagar online", aviso de ambiente seguro, botão "Preparando pagamento seguro…" |
| `js/appointment-actions.js`, `js/cliente.js`, `js/data.js`, `js/utils.js`, `js/layout.js` | Pagar novamente, estorno ao cancelar, *Minhas compras*, rótulos e mensagens de erro |
| `js/admin/pagamentos.js`, `js/admin/configuracoes.js`, `js/admin/agendamentos.js` | Estorno pelo Mercado Pago, consulta de status, histórico de eventos, chave liga/desliga |
| `css/style.css` | Estilos dos novos status, aviso de segurança e página de retorno |

---

## 3. Configurar a conta do Mercado Pago

1. Acesse o [Mercado Pago Developers](https://www.mercadopago.com.br/developers) com a conta do estúdio.
2. Em **Suas integrações**, crie uma aplicação. Escolha o produto **Checkout Pro** (pagamentos online).
3. Dentro da aplicação, abra **Credenciais de teste** e **Credenciais de produção**. Vamos usar só o **Access Token** de cada uma (a Public Key não é necessária no Checkout Pro com redirecionamento).
4. **Pix:** para receber Pix em produção, a conta precisa ter uma **chave Pix cadastrada** no Mercado Pago.

> O Access Token é **secreto**. Ele nunca vai para o site, para o GitHub ou para mensagens. Fica apenas nos Secrets do Supabase.

---

## 4. Credenciais e variáveis de ambiente

Todas ficam em **Supabase → Edge Functions → Secrets** (ou `supabase secrets set`). O arquivo `supabase/functions/.env.example` traz a lista completa, sem valores.

| Variável | Obrigatória | Descrição |
|---|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | sim | Access Token da aplicação (de teste ou de produção, conforme o ambiente) |
| `MERCADOPAGO_WEBHOOK_SECRET` | sim | Assinatura secreta gerada na configuração do webhook (seção 6) |
| `MERCADOPAGO_ENV` | sim | `test` ou `production`. Em `production`, pagamentos de teste (`live_mode = false`) são ignorados |
| `SITE_URL` | sim | Endereço público do site, ex.: `https://jhenbeautycare.com.br` (usado nas URLs de retorno) |
| `ALLOWED_ORIGINS` | recomendada | Origens autorizadas a chamar as funções pelo navegador, separadas por vírgula. A origem de `SITE_URL` já entra automaticamente |
| `MERCADOPAGO_STATEMENT_DESCRIPTOR` | não | Nome na fatura do cartão (até 13 caracteres). Padrão: `JHENBEAUTY` |
| `MERCADOPAGO_MAX_INSTALLMENTS` | não | Máximo de parcelas no cartão (1 a 12). Padrão: `1` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` já existem automaticamente nas Edge Functions. Não cadastre nem copie a `service_role` para nenhum outro lugar.

**Nunca misture ambientes:** com `MERCADOPAGO_ENV=test` use o Access Token de teste; com `production`, o de produção. Para trocar, altere os dois secrets juntos.

Pela CLI:
```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase secrets set MERCADOPAGO_ENV=test \
  MERCADOPAGO_ACCESS_TOKEN=<access token de TESTE> \
  SITE_URL=https://jhenbeautycare.com.br \
  ALLOWED_ORIGINS=https://jhenbeautycare.com.br
# depois do passo 6:
supabase secrets set MERCADOPAGO_WEBHOOK_SECRET=<assinatura secreta>
```
(Digitar segredos na linha de comando os deixa no histórico do terminal. Se preferir, cadastre pelo painel do Supabase.)

---

## 5. Configurar o Supabase

1. **Banco:**
   - Instalação nova: rode `supabase/schema.sql` no *SQL Editor*.
   - Banco que já tinha a versão anterior: rode **uma vez** `supabase/migrations/20261012_mercadopago.sql`.
   - Depois disso o pagamento online fica **desligado** até o passo 4.
2. **Publicar as funções** (na pasta do projeto):
   ```bash
   supabase functions deploy create-payment
   supabase functions deploy sync-payment
   supabase functions deploy refund-payment
   supabase functions deploy payment-webhook --no-verify-jwt
   ```
   O webhook precisa de `--no-verify-jwt` porque o Mercado Pago não envia o token do Supabase. A autenticidade é garantida pela assinatura `x-signature` (seção 6). As outras três exigem a sessão da usuária.
3. Confira em **Edge Functions** se as quatro aparecem como ativas.
4. **Ligar no site:** *Admin → Configurações → Pagamentos → Pagamento online: Mercado Pago (Checkout Pro)* → Salvar. Para desligar a qualquer momento, volte para "Desligado".

---

## 6. Configurar o webhook

1. No Mercado Pago Developers → **Suas integrações** → sua aplicação → **Webhooks** → **Configurar notificações**.
2. **URL** (modo de teste e de produção):
   ```
   https://<PROJECT_REF>.supabase.co/functions/v1/payment-webhook
   ```
3. **Eventos:** marque **Pagamentos**.
4. Salve. O painel mostra a **assinatura secreta**. Copie para o secret `MERCADOPAGO_WEBHOOK_SECRET`.
5. Use o botão de **simular notificação** do painel: a resposta esperada é `200`. Uma notificação simulada aponta para um pagamento que não existe, e o sistema só registra o evento.

Como a função valida cada notificação:
1. Confere a assinatura `x-signature` (HMAC-SHA256 com a assinatura secreta, sobre `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`). Sem assinatura válida → `401`. Notificações IPN antigas, que não têm assinatura, são recusadas. Por isso o projeto não usa `notification_url`.
2. Ignora eventos que não são de pagamento (`200`).
3. Valida o ID (só dígitos) → senão `400`.
4. Ignora reentregas com o mesmo `x-request-id` (`200 duplicate`).
5. **Consulta o pagamento na API** (`GET /v1/payments/{id}`). O conteúdo da notificação nunca é usado como verdade. Se a API estiver fora, responde `500` e o Mercado Pago reenvia.
6. Aplica no banco com `apply_gateway_payment`, que confere referência, valor, moeda, ambiente (teste ou produção), ordem dos eventos e duplicidade.

---

## 7. Testar com contas de teste

1. Com `MERCADOPAGO_ENV=test` e o Access Token **de teste**, ligue o Mercado Pago no painel (seção 5).
2. Em **Suas integrações → Contas de teste**, crie uma conta de teste **compradora** (e use a vendedora que a aplicação de teste já fornece). Faça os pagamentos de teste com a compradora. Não use a sua conta real no checkout de teste.
3. Use os **cartões de teste oficiais** da documentação do Checkout Pro (*Documentação → Checkout Pro → Testar a integração*). Eles não são reproduzidos aqui para não ficarem desatualizados. A documentação explica como escolher o resultado (aprovado, recusado etc.) pelo **nome do titular** do cartão de teste.
4. Roteiro mínimo:
   | Cenário | Esperado no site |
   |---|---|
   | Cartão aprovado | Retorno "Pagamento aprovado! Seu horário está confirmado." e horário confirmado em *Meus agendamentos* |
   | Cartão recusado | "Não foi possível confirmar o pagamento." com botão "Tentar novamente" |
   | Pix (não pago) | "Seu pagamento ainda está sendo processado."; o horário **não** é confirmado |
   | Voltar sem pagar | "O pagamento foi cancelado."; o horário continua reservado até expirar |
   | Estorno pelo painel | Status "Estornado" e horário cancelado |
5. **Testando pelo Live Server** (`SITE_URL=http://127.0.0.1:5500`): o retorno automático do Mercado Pago só é ligado com HTTPS. Depois de pagar, clique em **"Voltar ao site"** no Mercado Pago para cair na página de retorno. O webhook confirma o horário do mesmo jeito.
6. Depois de cada teste, confira **Admin → Pagamentos** (forma, nº da transação, eventos) e **Minhas compras** da cliente.

> Pagamentos de teste aparecem com a marca "pagamento de teste" no painel. Em produção (`MERCADOPAGO_ENV=production`), eles são ignorados e as administradoras recebem um aviso.

---

## 8. Conferir se o webhook está funcionando

- **No site:** *Admin → Pagamentos → ícone de lista* (Histórico de eventos) mostra cada notificação e consulta, com o resultado: *Status atualizado*, *Notificação repetida (sem mudança)*, *Valor divergente*, *Pagamento em duplicidade*, *Estorno automático solicitado* etc. Reentregas idênticas do webhook não geram linha nova.
- **No banco (SQL Editor):**
  ```sql
  select created_at, source, outcome, provider_payment_id, detail
    from public.payment_events order by created_at desc limit 20;
  ```
- **No Mercado Pago:** *Webhooks → histórico de notificações* mostra o código HTTP de cada entrega (`200` = recebido).
- **Logs da função:** *Supabase → Edge Functions → payment-webhook → Logs* (sem dados pessoais nem tokens). `webhook_invalid_signature` indica assinatura secreta errada ou desatualizada.

---

## 9. Como o horário é liberado

O horário é confirmado **somente** quando **todas** as condições abaixo valem:
1. A notificação é autêntica (assinatura válida) ou a consulta foi feita pelo próprio servidor.
2. A API do Mercado Pago informa `status = approved`.
3. `external_reference` corresponde a um pagamento existente no banco, do tipo online.
4. Valor pago ≥ valor cobrado e moeda igual. Se não, o pagamento é **estornado automaticamente** e o horário não é confirmado.
5. Em produção, `live_mode = true`.
6. O evento não é mais antigo que o último já aplicado.

Casos especiais tratados:
- **Pagou duas vezes:** o segundo pagamento aprovado é estornado automaticamente.
- **Pagou depois que a reserva expirou:** se o horário ainda estiver livre, o agendamento é reativado. Se outra cliente já ocupou, o valor é estornado automaticamente.
- **Pendente, recusado ou em análise:** nunca confirmam o horário.
- **Estorno total ou chargeback:** o horário futuro é cancelado.

*Minhas compras* (view `purchases`) mostra para cada compra: procedimento, valor, status, forma de pagamento, nº da transação e se o horário está confirmado.

---

## 10. Estornos, cancelamentos e contestações

- **Cancelamento pela cliente dentro do prazo:** o sistema calcula o valor a devolver (política em *Configurações → Políticas*) e pede o estorno ao Mercado Pago automaticamente.
- **Cancelamento pela administradora:** o pagamento fica "Estorno pendente". Em *Admin → Pagamentos*, clique em **Estornar no Mercado Pago**.
- **Estorno direto de um pagamento aprovado:** *Admin → Pagamentos → Estornar* (total). O horário é cancelado.
- **Estorno feito no painel do Mercado Pago:** o webhook atualiza o status sozinho (total → cancela o horário; parcial → mantém).
- **Pagamento no estúdio:** *Marcar como pago* e *Registrar estorno* continuam manuais. Pagamentos online **não** podem ser alterados manualmente, nem pela administradora (proteção do banco).
- **Em disputa / chargeback:** as administradoras recebem notificação; a resposta à disputa é feita no painel do Mercado Pago.
- Os estornos usam chave de idempotência: clicar duas vezes não devolve em dobro.

---

## 11. Colocar em produção

Checklist:
- [ ] Testes da seção 7 concluídos no modo de teste
- [ ] Conta do Mercado Pago verificada e **chave Pix** cadastrada
- [ ] Aplicação com **credenciais de produção** ativas
- [ ] Secrets trocados **juntos**: `MERCADOPAGO_ENV=production` e `MERCADOPAGO_ACCESS_TOKEN=<token de produção>`
- [ ] Webhook do **modo produção** configurado com a mesma URL, evento *Pagamentos*, e `MERCADOPAGO_WEBHOOK_SECRET` atualizado com a assinatura secreta dele
- [ ] `SITE_URL` e `ALLOWED_ORIGINS` com o domínio final (HTTPS)
- [ ] `supabase/seed_cleanup.sql` executado (remove dados de teste)
- [ ] Um pagamento real de baixo valor feito e estornado pelo painel, conferindo os eventos (seção 8)
- [ ] *Admin → Configurações → Pagamentos* em **Mercado Pago (Checkout Pro)**

Para pausar os pagamentos online (manutenção, problema na conta), basta voltar para "Desligado". Agendamentos com pagamento no estúdio continuam funcionando.

---

## 12. Segurança

- **Dados de cartão:** número, CVV e validade são digitados só no Mercado Pago. Nada disso passa pelo site, pelas Edge Functions ou pelo banco. São guardados apenas tipo, bandeira e os 4 últimos dígitos, vindos da API.
- **Segredos:** Access Token e assinatura do webhook ficam só nos Secrets do Supabase. Nenhuma resposta de API ou log contém tokens. `.gitignore` bloqueia arquivos `.env`.
- **Valor e status:** o navegador nunca envia valor nem status. O trigger `guard_payment_changes` impede que qualquer usuária (inclusive a administradora) altere valor, cliente, IDs do Mercado Pago ou status de pagamentos online pela API.
- **Funções internas** (`apply_gateway_payment`, `notify`, `rate_limit_hit` etc.) só podem ser executadas pela `service_role`.
- **RLS:** cada cliente vê só os próprios pagamentos e compras; `payment_events` só a administradora; `api_rate_limits` ninguém.
- **Abuso:** limite de requisições por usuária (criar checkout: 10 a cada 10 min; consultar status: 30 a cada 10 min), corpo limitado a 16 KB, origem (CORS) restrita.
- **Página de retorno:** exige login, aceita só pagamentos da própria cliente e ignora `status`/`payment_id` da URL (um ID de outro pagamento é recusado).

---

## 13. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| "O pagamento online está indisponível no momento" | Provedor desligado ou secrets ausentes | Confira a seção 5 (passo 4) e os secrets da seção 4 |
| "Não foi possível conectar ao Mercado Pago agora" | Access Token inválido ou do ambiente errado | Confira `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_ENV`; veja os logs de `create-payment` |
| Webhook com `401` no painel do MP | Assinatura secreta diferente | Copie de novo a assinatura do ambiente certo para `MERCADOPAGO_WEBHOOK_SECRET` |
| Pago, mas o horário não confirmou | Webhook não chegou ou valor divergente | *Admin → Pagamentos → ícone "Consultar status no Mercado Pago"*; veja o histórico de eventos |
| Evento "Pagamento de teste ignorado" | Pagamento de teste com `MERCADOPAGO_ENV=production` | Use credenciais de produção, ou volte para `test` |
| "Muitas tentativas seguidas" | Limite de requisições | Aguarde alguns minutos |
| Checkout expirou | Reserva de 15 min terminou | Faça um novo agendamento; ajuste "Tempo para concluir o pagamento online" em *Configurações → Pagamentos* |
