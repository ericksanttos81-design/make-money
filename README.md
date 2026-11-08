# Make Money — Especificação do produto

## 1. Visão geral

O Make Money é uma aplicação web demonstrativa para administrar um grupo de seis participantes que contribuem mensalmente para um ciclo de seis rodadas. Assim que o Administrador Mestre confirma o pagamento individual, o participante pode fazer seu giro, sem esperar os demais pagamentos. O servidor registra os seis resultados e define o vencedor pela maior quantidade de ocorrências; em caso de empate, os resultados da tentativa são registrados e todos os participantes podem girar novamente. O prêmio considera os pagamentos aprovados quando uma tentativa termina com vencedor.

Este diretório contém um MVP executável sem dependências externas. Toda a interface — estrutura, estilos e interações — está em um único arquivo, [public/index.html](./public/index.html). O servidor Node.js fornece a API, a persistência local em JSON, o sorteio e as atualizações em tempo real por Server-Sent Events (SSE).

### Executar o MVP

1. Instale o Node.js 18 ou superior.
2. No diretório do projeto, execute `npm start`.
3. Abra `http://localhost:3000` no navegador.
4. Na primeira abertura em `http://localhost:3000`, configure a senha do **Administrador Mestre** na tela inicial. O e-mail inicial é `ericksanttos81@gmail.com`; depois da configuração, o aplicativo entra automaticamente no painel ADM.
5. Cadastre os seis participantes com **Criar conta**. A chave Pix (telefone, e-mail, CPF ou chave aleatória) é opcional e fica visível ao ADM na lista de participantes; o administrador acompanha o status e pode marcar cada contribuição como paga ou pendente. Na tela **Pix**, os participantes consultam o código Copia e Cola e o QR Code configurados pelo ADM. O administrador pode atualizar ambos na seção **Configurar Pix** do Painel ADM. Um participante também pode informar seu pagamento, mas apenas a confirmação do administrador libera o giro individual. No Painel ADM, **Excluir Conta** remove as credenciais e o perfil cadastral, encerra as sessões do participante e libera o e-mail para novo cadastro. Na visualização **Histórico**, o ADM pode excluir individualmente um sorteio da lista após confirmação; os registros operacionais de pagamentos e giros são mantidos para preservar os ciclos e rodadas.
6. Para zerar os dados de demonstração, pare o servidor e execute `npm run reset`.
7. Para rodar os testes automatizados, execute `npm test` (no PowerShell do Windows, use `npm.cmd test` se a política bloquear scripts).

Os dados locais são salvos em `data/make-money.json` e sobrevivem a reinicializações. Para testar atualização entre janelas, abra o mesmo endereço em mais de uma aba. O HTML único precisa do servidor Node.js para pagamentos demonstrativos, sorteio compartilhado e persistência; abrir o arquivo diretamente não substitui esses recursos.

> **Limites do MVP:** o cadastro/login é funcional neste protótipo: senhas são derivadas com PBKDF2, as sessões usam cookies HttpOnly e ficam no armazenamento local do servidor, e a API exige sessão. A recuperação de senha envia um código de seis dígitos pelo Resend quando as variáveis de ambiente estão configuradas; o código expira em 15 minutos, é de uso único e tem limite de tentativas. Ainda não há integração com Pix ou pagamento. O armazenamento JSON e o servidor de instância única não substituem um backend de produção, provedores de identidade, controles operacionais ou revisão de segurança. Não use o protótipo para movimentar dinheiro nem exponha o servidor à internet.

O perfil de administrador não ocupa uma das seis vagas do grupo. A configuração inicial é feita uma única vez pela interface do navegador, usando `localhost`; escolha uma senha exclusiva com pelo menos 8 caracteres. O servidor guarda apenas um hash PBKDF2 com salt aleatório no arquivo local de dados, nunca a senha em texto puro. A rota de configuração é restrita a conexões de loopback e não pode redefinir uma conta ADM já criada. Para alterar a senha depois da configuração, ainda é possível usar `npm run admin:password` no terminal. Opcionalmente, `MASTER_ADMIN_EMAIL` ainda pode substituir o endereço inicial. Contas criadas em versões anteriores continuam como participantes e preservam o vínculo com suas vagas.

O comando interativo no PowerShell:

```powershell
npm.cmd run admin:password
```

### Configurar e-mail para recuperar senha

1. Crie uma chave de API no Resend e verifique um domínio de envio na sua conta.
2. Defina `RESEND_API_KEY` e `RESEND_FROM_EMAIL` no ambiente do servidor. Use como remetente um endereço permitido pelo domínio verificado, por exemplo `Make Money <contato@seudominio.com>`.
3. Opcionalmente, defina `PASSWORD_RESET_SECRET` com um segredo aleatório forte para assinar os códigos de recuperação. Se omitido, o servidor usa a chave secreta do Resend.
4. Inicie o servidor no mesmo ambiente em que definiu as variáveis. Exemplo no PowerShell:

   ```powershell
   $env:RESEND_API_KEY = "re_sua_chave"
   $env:RESEND_FROM_EMAIL = "Make Money <contato@seudominio.com>"
   $env:PASSWORD_RESET_SECRET = "seu_segredo_aleatorio_forte"
   npm.cmd start
   ```

As credenciais devem permanecer apenas no ambiente do servidor e nunca no HTML, no navegador ou em arquivos versionados. Sem as variáveis do Resend, o servidor retorna um erro claro e não informa que enviou o código.

### Premissas

- O grupo é fechado e tem exatamente seis participantes ativos durante cada ciclo.
- O Administrador Mestre configura a contribuição de cada um dos seis meses no Painel ADM. Os valores ficam registrados no ciclo, cada rodada usa seu próprio valor por participante, e novos ciclos herdam os seis valores anteriores até nova configuração. Um mês não pode ser alterado depois que seu pagamento ou giro começar, preservando os registros existentes.
- O prêmio de cada rodada é a soma dos pagamentos aprovados quando os seis giros forem concluídos; seu valor depende das contribuições configuradas e confirmadas.
- O ciclo contém seis rodadas, com um ganhador diferente em cada uma.
- Ao concluir a sexta rodada, o sistema arquiva o ciclo no histórico e aguarda o Administrador Mestre iniciar outro pelo botão **Iniciar Novo Ciclo** no Painel ADM. O novo ciclo começa na rodada 1, com pagamentos pendentes e giros liberados após novas confirmações individuais.
- Os resultados e pagamentos das rodadas anteriores permanecem registrados; o Administrador Mestre pode remover individualmente um sorteio da lista visível do Histórico, sem apagar os dados operacionais da rodada. A regra de ganhadores diferentes reinicia no novo ciclo.
- Cada participante registrado faz um giro por tentativa, assim que o próprio pagamento for aprovado pelo ADM. O resultado de cada giro é escolhido e persistido pelo backend.
- Após os seis giros, vence quem tiver mais ocorrências. Em caso de empate na maior contagem, o sistema zera os giros daquela tentativa e libera todos para girar novamente.
- O ciclo só avança depois que uma tentativa terminar com vencedor.
- O ciclo não permite substituir participantes depois de iniciado. Uma eventual substituição exige encerrar ou cancelar o ciclo conforme uma política definida antes do lançamento.

> **Atenção:** sorteios, consórcios, pagamentos e premiações podem estar sujeitos a regras legais, tributárias e de proteção ao consumidor. Validar o modelo e os meios de pagamento com assessoria adequada antes de operar ou divulgar o serviço. Este documento não é orientação jurídica ou financeira.

## 2. Regras de negócio

1. **Composição do grupo:** só pode existir um ciclo ativo com exatamente seis participantes distintos.
2. **Contribuição:** o Administrador Mestre define um valor individual para cada mês do ciclo. Os valores são armazenados em centavos, nunca em ponto flutuante; o valor da rodada aparece na lista de pagamentos e na tela Pix dos participantes.
3. **Prêmio:** ao concluir os seis giros, o valor da rodada é a soma dos pagamentos confirmados pelo ADM naquele instante. Taxas, retenções ou ajustes não devem ser subtraídos silenciosamente; caso existam, precisam ser exibidos e registrados.
4. **Elegibilidade:** são elegíveis apenas os participantes do ciclo que ainda não ganharam nesse ciclo.
5. **Giros individuais:** cada um dos seis participantes pode registrar um único giro por tentativa após a aprovação do próprio pagamento pelo ADM, independentemente do status dos outros pagamentos. Participantes já contemplados continuam podendo girar, mas não podem ser sorteados novamente.
6. **Apuração:** cada giro seleciona, no backend, um participante elegível. Depois do sexto giro, o sistema conta as ocorrências e define como vencedor o nome mais frequente. Se houver empate na maior contagem, o sistema registra a tentativa empatada, zera os giros atuais e libera uma nova tentativa para todos.
7. **Resultado único:** uma rodada concluída tem exatamente um ganhador. Um participante não pode ganhar mais de uma rodada no mesmo ciclo.
8. **Ordem:** as rodadas são realizadas em ordem crescente. A próxima rodada só pode ser aberta depois da conclusão da anterior.
9. **Transparência:** os seis resultados individuais e a contagem de ocorrências são exibidos em tempo real no Painel ADM.
10. **Auditoria:** registrar cada giro, quem o realizou, seu resultado, as apurações e reinícios automáticos por empate, além das transições da rodada.
11. **Correção de dados:** pagamentos e resultados não devem ser apagados ou editados sem trilha de auditoria. Correções devem gerar eventos/ajustes identificáveis.
12. **Falha de conexão:** desconectar ou atualizar a tela não desfaz giros já registrados. Ao reconectar, o cliente consulta o estado oficial.
13. **Cancelamento e exceções:** política de atraso, devolução, cancelamento e reabertura de rodada precisa ser decidida pelo responsável pelo grupo antes do uso.

## 3. Requisitos funcionais

### Conta e acesso

- **RF-01:** permitir autenticação individual para cada participante.
- **RF-02:** permitir que um usuário veja somente os ciclos e informações para os quais tem autorização.
- **RF-03:** oferecer recuperação de acesso e encerramento seguro da sessão.
- **RF-04:** permitir que o responsável pelo grupo convide ou cadastre os seis participantes antes do início do ciclo.

### Ciclo, rodadas e pagamentos

- **RF-05:** exibir o ciclo atual, a rodada (por exemplo, “Mês 2 de 6”) e seu estado.
- **RF-06:** exibir os seis pagamentos da rodada, os respectivos estados e horários de confirmação.
- **RF-07:** permitir registrar confirmação de pagamento por integração confiável ou por ação autorizada do responsável, mantendo origem e auditoria.
- **RF-08:** impedir confirmação duplicada do mesmo pagamento; usar o valor configurado para cada mês e registrar alterações administrativas em auditoria, sem permitir alterar meses já iniciados.
- **RF-09:** permitir a cada participante registrado exatamente um giro após a aprovação do próprio pagamento, sem exigir a aprovação dos demais para esse giro.
- **RF-10:** após os seis giros, contar as ocorrências e definir automaticamente como ganhador o participante mais sorteado; calcular o prêmio com base nos pagamentos aprovados ao concluir os giros.
- **RF-11:** após concluir uma rodada, apresentar o ganhador, o valor do prêmio, a data e o estado do pagamento do prêmio, quando acompanhado pelo sistema.
- **RF-12:** mostrar histórico de rodadas e pagamentos, incluindo comprovantes disponíveis e indicação clara de itens pendentes.
- **RF-13:** permitir exportar ou consultar um extrato legível do ciclo e de seu histórico de auditoria para os usuários autorizados.

### Sorteio e transparência

- **RF-14:** mostrar na roleta os participantes elegíveis no momento de cada giro.
- **RF-15:** exibir no Painel ADM os seis giros individuais, seus resultados e a contagem atualizada em tempo real.
- **RF-16:** definir automaticamente o ganhador pela maior quantidade de ocorrências após os seis giros; em empate, registrar a tentativa, zerar seus giros e liberar nova tentativa para todos.
- **RF-17:** exibir a mesma apuração oficial em todos os dispositivos, inclusive para quem entrar depois ou reconectar.
- **RF-18:** remover da lista de resultados possíveis os ganhadores anteriores do mesmo ciclo.
- **RF-19:** manter um estado textual acessível equivalente ao resultado visual da roleta e informar giros pendentes, reinício por empate e resultado final.
- **RF-20:** permitir que somente o Administrador Mestre corrija o ganhador da rodada concluída mais recente; registrar a ação em auditoria, impedir ganhadores repetidos e sincronizar o resultado.
- **RF-21:** exigir aprovação do pagamento individual para liberar o giro e validar essa regra no servidor.
- **RF-22:** comunicar estados de carregamento, giros pendentes, conexão perdida e resultado já definido sem apresentar esses estados como sucesso.
- **RF-23:** inserir automaticamente na roleta o nome de cada participante após o cadastro e permitir que apenas o Administrador Mestre edite nomes e reordene as fatias, sincronizando as alterações e registrando-as em auditoria sem alterar os IDs dos participantes.

## 4. Requisitos não funcionais

- **RNF-01 — Segurança:** usar TLS em trânsito, controles de acesso no servidor e políticas de acesso por linha no banco de dados.
- **RNF-02 — Integridade:** impor as regras críticas com transações, restrições únicas e validações no backend; não confiar em validação apenas no app.
- **RNF-03 — Disponibilidade e recuperação:** em falha ou reconexão, o estado persistido no servidor é a fonte de verdade; clientes podem recuperar o estado consultando a API.
- **RNF-04 — Consistência:** um sorteio deve produzir no máximo um ganhador oficial por rodada, mesmo com chamadas simultâneas ou repetidas.
- **RNF-05 — Privacidade:** coletar somente dados necessários; proteger e limitar a exposição de e-mail, chave Pix e comprovantes.
- **RNF-06 — Auditoria:** manter registros imutáveis ou append-only das ações administrativas, confirmações de pagamento e sorteios.
- **RNF-07 — Usabilidade:** funcionar em telas móveis e desktop, com mensagens claras, confirmação de ações relevantes e estados vazios/erro.
- **RNF-08 — Acessibilidade:** suportar navegação por teclado, leitores de tela, contraste adequado, redução de movimento e alternativa textual à roleta.
- **RNF-09 — Desempenho:** carregar o painel e o estado da rodada em até 2 segundos em condições usuais de rede, sem contar a latência do provedor externo.
- **RNF-10 — Observabilidade:** registrar erros e métricas operacionais sem gravar credenciais, tokens ou dados de pagamento desnecessários em logs.
- **RNF-11 — Compatibilidade:** definir e testar versões suportadas de navegadores e sistemas móveis antes do lançamento.
- **RNF-12 — Segurança do sorteio:** a seleção deve usar fonte aleatória criptograficamente segura no servidor e ser registrada de modo auditável. Não revelar segredos ou dados internos no cliente.

## 5. Telas e experiência

### 5.1 Login

- Entradas de e-mail e senha ou provedor de autenticação escolhido.
- Recuperação de acesso e mensagens de erro que não revelem se uma conta específica existe.
- Após autenticar, encaminhar o participante ao painel do ciclo ativo.

### 5.2 Painel do ciclo

- Identificação do ciclo e indicador “Mês N de 6”.
- Progresso de pagamentos: lista dos seis participantes e estado de cada contribuição.
- Exibir para cada participante se o seu pagamento está aprovado, se já registrou seu giro e quantos giros faltam.
- Ação “Fazer meu giro” liberada após aprovação individual, com bloqueio contra um segundo giro da mesma pessoa.
- Último ganhador e acesso ao histórico.

### 5.3 Roleta

- Mostrar fatias com os nomes dos participantes elegíveis; indicar de forma acessível quem já foi contemplado.
- Enquanto a rodada está aberta, explicar se o pagamento do próprio participante aguarda aprovação; depois liberar um giro por pessoa.
- Animar cada giro individual até o resultado oficial enviado pelo backend.
- Após seis giros, exibir a contagem e destacar a maioria; em caso de empate, zerar a tentativa e liberar novos giros para todos.
- Ao concluir, destacar o mesmo ganhador para todos, com opção de movimento reduzido e resultado anunciado por texto/leitor de tela.
- Não usar a posição final calculada pelo navegador para determinar ou alterar o ganhador.

### 5.4 Histórico e extrato

- Rodadas anteriores, ganhadores, datas e valores.
- Pagamentos por participante, estado, data de confirmação e comprovante, se houver.
- Identificação de correções ou ajustes sem ocultar o registro original.
- Dados sensíveis e comprovantes acessíveis apenas a usuários autorizados.

## 6. Stack tecnológica sugerida para produção

Para a versão de produção, uma opção enxuta seria:

- **Aplicação:** React Native com Expo para iOS/Android e React Native Web (ou uma aplicação web React separada, se as necessidades web crescerem).
- **Backend e dados:** Supabase (PostgreSQL, Auth, Row Level Security e Realtime).
- **Lógica privilegiada:** função de servidor/Edge Function para validar e registrar cada giro, apurar os seis resultados, reiniciar tentativas empatadas, confirmar pagamentos por webhook e validar permissões. Nunca colocar service-role key no app.
- **Animação:** biblioteca de animação compatível com React Native; a interface anima até o destino informado pelo servidor.
- **Notificações:** push opcional para avisos de pagamento e resultado; não substitui o estado persistido nem o canal realtime.
- **Testes:** testes unitários de regras, testes de integração contra banco de teste e testes ponta a ponta dos fluxos críticos.

Alternativas possíveis incluem Flutter ou Firebase, mas a escolha deve considerar transações, regras de acesso, auditoria e garantias de consistência. Para este caso, PostgreSQL facilita impor unicidade e executar alterações atômicas. No MVP, o HTML único contém o CSS e o JavaScript da interface; o servidor Node.js continua sendo necessário para a demonstração sincronizada.

## 7. Modelo de dados relacional sugerido

Use UUIDs como identificadores, timestamps com fuso horário e valores monetários em centavos. Abaixo estão entidades conceituais; a implementação pode ajustar nomes e detalhes.

### `users`

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `id` | UUID | Mesmo identificador do provedor de autenticação |
| `name` | texto | Nome exibido |
| `email` | texto | Único; gerenciado/protegido conforme o provedor |
| `pix_key` | texto anulável | Dado sensível; acesso restrito, preferencialmente criptografado |
| `status` | enum | `active`, `invited`, `disabled` |
| `created_at` | timestamptz | Data de criação |

### `cycles`

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `id` | UUID | Chave primária |
| `status` | enum | `draft`, `active`, `completed`, `cancelled` |
| `contribution_cents` | inteiro | 1000 |
| `round_count` | inteiro | 6 |
| `created_at` | timestamptz | Data de criação |
| `started_at` | timestamptz anulável | Início do ciclo |
| `completed_at` | timestamptz anulável | Conclusão do ciclo |

### `cycle_members`

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `cycle_id` | UUID | FK para `cycles` |
| `user_id` | UUID | FK para `users` |
| `joined_at` | timestamptz | Entrada no ciclo |

Chave primária composta (`cycle_id`, `user_id`). Ao ativar o ciclo, validar que há exatamente seis membros distintos. A composição não muda depois que o ciclo começa, salvo fluxo explícito de cancelamento.

### `rounds`

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `id` | UUID | Chave primária |
| `cycle_id` | UUID | FK para `cycles` |
| `round_number` | inteiro | De 1 a 6 |
| `status` | enum | `pending`, `open`, `ready`, `drawing`, `completed`, `cancelled` |
| `prize_cents` | inteiro | Soma dos pagamentos aprovados ao concluir os seis giros |
| `winner_user_id` | UUID anulável | FK para `users`; preenchido uma única vez |
| `tie_count` | inteiro | Quantidade de tentativas empatadas e reiniciadas |
| `draw_started_at` | timestamptz anulável | Hora do primeiro giro da rodada |
| `draw_completed_at` | timestamptz anulável | Hora da conclusão |
| `created_at` | timestamptz | Data de criação |

Restrições: `UNIQUE (cycle_id, round_number)`; `CHECK (round_number BETWEEN 1 AND 6)`; ganhador obrigatório quando `status = 'completed'`; no máximo um ganhador por ciclo (`UNIQUE (cycle_id, winner_user_id)` onde o ganhador não é nulo).

### `spins`

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `id` | UUID | Chave primária |
| `round_id` | UUID | FK para `rounds` |
| `participant_id` | UUID | FK para `cycle_members`; autor do giro |
| `result_participant_id` | UUID | FK para `cycle_members`; nome sorteado naquele giro |
| `spun_at` | timestamptz | Data e hora do giro |

Restrições: `UNIQUE (round_id, participant_id)` garante no máximo um giro por participante em cada tentativa. Ao registrar o sexto giro, apurar as ocorrências no backend; para empate na maior contagem, guardar a tentativa na auditoria, limpar os giros ativos e permitir que todos girem novamente.

### `payments`

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `id` | UUID | Chave primária |
| `round_id` | UUID | FK para `rounds` |
| `user_id` | UUID | FK para `users` |
| `amount_cents` | inteiro | 1000 |
| `status` | enum | `pending`, `confirmed`, `rejected`, `refunded` |
| `confirmed_at` | timestamptz anulável | Data da confirmação |
| `confirmed_by` | UUID anulável | Admin ou identificador da integração |
| `provider_reference` | texto anulável | Referência externa sem dados sensíveis |
| `receipt_uri` | texto anulável | Referência privada para comprovante |
| `created_at` | timestamptz | Data de criação |

Restrições: `UNIQUE (round_id, user_id)` e valor validado no servidor contra a contribuição definida no ciclo.

### `draw_events` (auditoria)

| Campo | Tipo sugerido | Observações |
|---|---|---|
| `id` | UUID | Chave primária |
| `round_id` | UUID | FK para `rounds` |
| `event_type` | texto/enum | Ex.: `participant_spin_recorded`, `draw_started`, `draw_tie_restarted`, `completed` |
| `actor_user_id` | UUID anulável | Autor da ação, se aplicável |
| `created_at` | timestamptz | Data do evento |
| `details` | JSONB | Metadados não secretos necessários à auditoria |

Não armazenar senhas, tokens ou chaves privadas em `details`. Para auditabilidade reforçada, pode-se registrar a versão do algoritmo e um identificador do sorteio; qualquer mecanismo de prova criptográfica requer projeto específico e revisão independente.

## 8. Fluxo da roleta sincronizada

1. **Preparação:** o servidor cria as seis rodadas, seis pagamentos e seis contas/vagas de participante. A rodada atual só avança depois da conclusão da anterior.
2. **Confirmação:** pagamentos são confirmados por ação autorizada do responsável. Cada confirmação atualiza o estado individual e libera somente o giro daquele participante.
3. **Giro individual:** cada participante autenticado pode enviar uma única solicitação para sua rodada. O servidor valida a rodada atual, a aprovação do próprio pagamento, a ausência de giro anterior e a existência de todos os seis participantes cadastrados.
4. **Seleção por giro:** o backend escolhe aleatoriamente um membro ainda elegível com gerador criptograficamente seguro e armazena o resultado associado ao participante que girou. A tela do cliente não escolhe nem define o resultado.
5. **Contagem:** cada gravação é persistida e publicada por SSE. O Painel ADM mostra quem girou, o resultado e as ocorrências acumuladas. Chamadas repetidas do mesmo participante são recusadas.
6. **Apuração automática:** após os seis giros únicos, o servidor soma os resultados e define vencedor quando há uma única maior contagem. O prêmio passa a ser a soma dos pagamentos aprovados naquele instante.
7. **Empate:** se duas ou mais pessoas tiverem a maior contagem, registrar o empate e os seis resultados na auditoria, limpar os giros ativos e liberar automaticamente uma nova tentativa a todos. O pagamento já aprovado continua válido.
8. **Finalização:** quando há vencedor automático, o servidor persiste e publica o resultado oficial antes de concluir a animação sincronizada. O cliente não pode alterar o vencedor ou as contagens.
9. **Recuperação:** se um evento se perder ou o cliente desconectar, ao reconectar ele lê o estado salvo, incluindo os giros da tentativa atual, o número de tentativas empatadas ou o vencedor.
10. **Próxima rodada:** depois que o vencedor é oficializado, remover essa pessoa da lista de resultados possíveis, abrir a rodada seguinte e atualizar o painel do grupo.
11. **Renovação:** ao concluir a sexta rodada, arquivar o ciclo concluído e aguardar o Administrador Mestre iniciar um novo ciclo pelo Painel ADM. O novo ciclo começa na rodada 1, com pagamentos pendentes. Os registros anteriores continuam no Histórico; elegibilidade e apuração por frequência são reiniciadas para o novo ciclo.

### Garantias contra divergência e repetição

- Seleção aleatória exclusivamente no backend com gerador criptograficamente seguro em cada giro.
- Restrição de um giro por participante e por rodada, validada e persistida no servidor.
- Apuração pela contagem dos seis resultados registrados; o cliente não envia contagens nem vencedor.
- Resultado, empate e reinício persistidos antes de serem anunciados.
- Evento de broadcast derivado do estado persistido; o app reconcilia com a API em qualquer dúvida.
- Testes concorrentes devem simular várias solicitações simultâneas para a mesma rodada e confirmar que há um único resultado.

## 9. Estados e mensagens principais

| Estado da rodada | Condição/ação disponível | Mensagem sugerida |
|---|---|---|
| `pending` / `open` | Aguardando pagamentos e giros individuais; cada participante depende da aprovação do próprio pagamento | “Seu giro será liberado após a aprovação do pagamento.” |
| `ready` | Todos os pagamentos foram aprovados; ainda faltam giros | “Seu pagamento foi aprovado. Registre seu giro.” |
| `drawing` | Os seis giros foram apurados e o resultado único está sendo finalizado | “Apuração concluída. Aguarde o resultado oficial.” |
| `completed` | Ganhador persistido | “Ganhador: [nome]. Resultado confirmado pelo sistema.” |
| `cancelled` | Rodada cancelada por fluxo autorizado | Exibir motivo e instruções; não apresentar resultado |
| desconectado | Estado local pode estar desatualizado | “Sem conexão. Reconectando e verificando o resultado…” |

## 10. Critérios de aceite

- Não é possível iniciar um ciclo sem exatamente seis participantes.
- Cada participante registrado consegue fazer um giro por tentativa assim que o ADM aprova seu pagamento, sem depender das aprovações dos outros.
- Os seis giros ficam visíveis no Painel ADM em tempo real, com resultado individual e total de ocorrências por nome.
- Depois do sexto giro, o nome mais frequente vence automaticamente; em caso de empate, os giros são reiniciados e todos podem girar de novo.
- Chamadas repetidas do mesmo participante não criam giros adicionais.
- Ao longo de um ciclo concluído existem seis ganhadores distintos, um por rodada.
- Depois da rodada 6, somente o Administrador Mestre pode iniciar o próximo ciclo pelo Painel ADM. O ciclo novo começa na rodada 1 com pagamentos pendentes, e o histórico mantém os seis resultados do ciclo anterior.
- Um cliente que reconecta após o sorteio recupera o mesmo resultado sem executar novo sorteio.
- O estado e os pagamentos apresentados são autorizados por usuário e não expõem dados privados de outros participantes além do necessário para transparência.
- A roleta apresenta o resultado oficial também em modo de movimento reduzido e em formato compatível com leitor de tela.
- As ações de confirmação, sorteio e correção ficam registradas para auditoria.
