# Agent Runtime Boundary — V1

## Objetivo

Definir a fronteira entre o Coordinator e os agentes especializados sem acoplar o Coordinator a um provedor de LLM.

O V1 será testado com os agentes disponíveis no **Antigravity**. Posteriormente, a mesma fronteira deverá permitir execução com **Claude**.

**OpenRouter não faz parte desta arquitetura.**

## Princípio

```text
Coordinator
    |
    | AgentDispatchRequest
    v
Agent Registry
    |
    | resolve(role)
    v
Agent Definition
    |
    v
Host Runtime
    |
    +--> Antigravity (V1)
    |
    +--> Claude (futuro)
```

O Coordinator não sabe:

- qual modelo está sendo usado;
- qual fornecedor de LLM está por trás do agente;
- como o agente é executado pelo host;
- como o host autentica o agente.

O Coordinator sabe apenas:

- qual `AgentRole` é necessário;
- qual estado está sendo executado;
- qual contexto deve ser entregue;
- quais evidências/artefatos são esperados;
- qual contrato de resultado deve ser devolvido.

## V1: Antigravity

O primeiro runtime real será o host de agentes do Antigravity.

A integração deve preservar a separação:

```text
Coordinator
    -> dispatch
       -> Antigravity Agent
          -> executa trabalho
          -> produz artifacts
          -> produz evidence
          -> retorna resultado estruturado
    -> validate gate
    -> transition
```

Não devemos criar uma chamada HTTP para um LLM para simular o Antigravity.

Se o Antigravity não expuser uma API programática para invocação de agentes no ambiente atual, o primeiro adapter deve ser um **host dispatch adapter**, responsável por produzir um dispatch determinístico que o agente do Antigravity possa executar.

O mecanismo concreto de invocação deve ser validado no ambiente antes de ser implementado.

## Futuro: Claude

Claude será apenas outro runtime:

```text
AgentRole
   |
   +--> AntigravityRuntime
   |
   +--> ClaudeRuntime
```

O contrato do Coordinator não muda.

## Proibições

O runtime boundary V1 não deve:

- chamar OpenRouter;
- selecionar modelos dinamicamente;
- conter prompts de negócio específicos de uma feature;
- implementar state transitions;
- decidir se um gate passou;
- substituir o Independent Review;
- permitir que o Implementation Agent seja a autoridade final sobre sua implementação.

## Host Dispatch Adapter e Fronteira de Execução

### Propósito do HostDispatchAdapter

O `HostDispatchAdapter` é o adaptador concreto que implementa a interface `AgentRuntimeAdapter` para hosts gerenciados (`ANTIGRAVITY` e futuramente `CLAUDE`).

Sua função é atuar como uma fronteira estrita e determinística entre o domínio de orquestração do Coordinator e o mecanismo de execução provido pelo ambiente hospedeiro:

```text
Coordinator
  ↓ (AgentDispatchRequest with resolved skills & options)
AgentDispatcher
  ↓ resolve(role, runtime) & validate skills
AgentRuntimeAdapter (HostDispatchAdapter)
  ↓ executeWithHostGuards(hostDispatcher.dispatch, options)
HostAgentDispatcher (Injected Host Capability)
  ↓
Host Runtime (Antigravity / Claude / Cursor / Mock Host)
```

### Contrato HostAgentDispatcher & Host Execution Contract

Para desacoplar a orquestração de qualquer detalhe de implementação ou execução do hospedeiro, o adapter recebe por injeção de dependência a capacidade de execução do host:

```typescript
export interface HostAgentDispatcher {
  dispatch(
    request: AgentDispatchRequest,
    options?: HostExecutionOptions,
  ): Promise<AgentResult>;
}
```

#### Ciclo de Vida da Execução Host

O ciclo de vida da execução host é explícito e padronizado:

```text
CREATED
  ↓
RUNNING ────► COMPLETED (sucesso do host: PASS ou FINDINGS)
  │
  ├─────────► FAILED (falha operacional: crash, erro inesperado)
  │
  ├─────────► TIMED_OUT (timeout_ms excedido via HostTimeoutError)
  │
  └─────────► CANCELLED (AbortSignal disparado via HostCancellationError)
```

```typescript
export type HostExecutionLifecycleStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export interface HostExecutionOptions {
  signal?: AbortSignal;
  timeout_ms?: number;
  onLifecycleChange?: (
    status: HostExecutionLifecycleStatus,
    record: HostExecutionRecord,
  ) => void;
  [key: string]: unknown;
}
```

#### Semântica de Erros vs Findings de Agente

O contrato separa estritamente duas categorias de desfecho:

1. **Agent Findings (Resultado de Domínio Válido):**
   - Exemplo: `status: "FINDINGS"`, lista de findings identificadas durante o review.
   - Trata-se de uma **execução bem-sucedida** do ponto de vista do host (`lifecycle_status: "COMPLETED"`).
   - O Coordinator recebe o `AgentResult` e transiciona deterministicamente para `REMEDIATION`.
   - **Nunca** é convertido em falha ou exceção de execução.

2. **Host Execution Failures (Falha Operacional do Hospedeiro):**
   - Exemplos: processo do agente travou, timeout de execução (`HostTimeoutError`), cancelamento do usuário (`HostCancellationError`), falha de rede/daemon, rejeição síncrona/assíncrona.
   - São erros operacionais que interrompem a execução do host.
   - **Nunca** são convertidos em findings de agente (`status: "FINDINGS"`).
   - Propagam diretamente como promessas rejeitadas para o Coordinator e `/project-run` (`status: "FAILED"`).

#### Timeout e Cancelamento Neutros

O timeout e o cancelamento são coordenados na fronteira de execução (`executeWithHostGuards`), sem acoplamento a provedores ou SDKs específicos:
- `timeout_ms`: monitorado por temporizador desacoplado, rejeitando a execução com `HostTimeoutError` se o host não responder dentro do limite.
- `AbortSignal`: monitorado via listener de evento de aborto padrão do Node/DOM, rejeitando com `HostCancellationError` imediatamente (se pré-abortado) ou em tempo de execução.
- Ambos os recursos limpam seus temporizadores e event listeners no bloco `finally`, prevenindo vazamentos de recursos.

### Divisão de Responsabilidades

#### O que pertence ao Coordinator e Dispatcher:
- Controle e persistência da máquina de estados do workflow;
- Decisão sobre o próximo estado e seleção do `AgentRole`;
- Seleção explícita do `AgentRuntime` (ex: `ANTIGRAVITY`, `CLAUDE`, `CURSOR`, `MOCK`);
- Validação no `AgentRegistry` se o papel suporta o runtime alvo;
- Resolução e validação prévia obrigatória de skills Spec Kit via `SkillValidator`;
- Montagem do `AgentDispatchRequest` com contexto mínimo, skills resolvidas e opções de execução (`HostExecutionOptions`);
- Avaliação determinística de gates e transições a partir do `AgentResult` recebido;
- **Não** gera código de implementação;
- **Não** formata prompts para modelos de LLM;
- **Não** interpreta ou altera findings do resultado.

#### O que pertence ao HostDispatchAdapter e executeWithHostGuards:
- Validação do runtime suportado (`ANTIGRAVITY`, `CLAUDE` ou `CURSOR`);
- Validação da presença de um `HostAgentDispatcher` válido;
- Encaminhamento direto e fiel do `AgentDispatchRequest` e das `HostExecutionOptions` ao host dispatcher injetado;
- Gestão do ciclo de vida da execução (`RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`);
- Enriquecimento padronizado de metadados (`metadata` / `execution_metadata`) com duração, timestamps e status de ciclo de vida sem mutar dados de domínio;
- Retorno do `AgentResult` exatamente como produzido pelo host;
- Propagação fiel de erros de execução do host sem engolir ou distorcer exceções.

#### O que pertence ao Host Runtime (ex: Antigravity, Claude, Cursor):
- Ciclo de vida e execução do agente especializado no ambiente;
- Resolução e despacho interno para subagentes, skills ou ferramentas do host;
- Edição de arquivos e geração de código no workspace pelo agente especializado;
- Coleta de evidências de execução (testes, logs, comandos) e apuração de findings;
- Construção do objeto final `AgentResult` em conformidade com o schema.

### Arquitetura de Integração de Futuros Hosts

Futuras integrações de agentes reais conectar-se-ão através da interface `HostAgentDispatcher`:

```text
                      HostAgentDispatcher
                               ▲
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
    AntigravityHost        ClaudeHost         CursorHost
        Adapter             Adapter            Adapter
     (subprocess/          (CLI bridge/       (extension/
      socket IPC)          mcp bridge)        socket bridge)
```

Nenhuma dessas futuras integrações exigirá alterações em:
- `Coordinator`
- `CoordinatorDecisionEngine`
- `AgentDispatcher`
- `State Machine`
- `SkillValidator`
- `AgentDispatchRequest` / `AgentResult`

### Por que nenhum Provedor de LLM é Permitido nesta Camada

1. **Separação de Preocupações:** O Coordinator é um orquestrador determinístico de fluxo de trabalho, não um executor gerador de código.
2. **Encapsulamento do Host:** O ambiente host (como o Antigravity) é quem possui e gerencia os agentes, ferramentas e modelos. Qualquer chamada direta a SDKs de LLM (OpenRouter, OpenAI, Anthropic, Vercel AI SDK) violaria a fronteira do host e introduziria acoplamento indevido.
3. **Imutabilidade do Resultado:** O adapter não deve sintetizar ou filtrar respostas via prompts intermediários.
4. **Substituibilidade:** A independência de provedores permite plugar hosts diferentes (Antigravity hoje, Claude amanhã, Cursor depois, Mock em testes) sem alterar uma única linha da máquina de estados ou do contrato do Coordinator.

## Definition of Done

- Coordinator consegue resolver um `AgentRole`.
- Registry retorna uma definição estável para cada role.
- Dispatch possui contexto mínimo e explícito com skills resolvidas.
- Resultado possui formato compatível com o `AgentResult`.
- Metadados de execução host (`runtime`, `duration_ms`, `lifecycle_status`) são propagados transparentemente.
- Timeout e cancelamento operam de maneira neutra e previsível.
- Mock runtime continua disponível para testes.
- Antigravity é tratado como host runtime, não como provider de LLM.
- Claude e Cursor podem ser adicionados posteriormente sem alterar State Machine ou Coordinator Contract.

