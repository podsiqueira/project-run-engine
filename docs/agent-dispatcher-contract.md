# Agent Dispatcher Contract — V1

## Purpose

The Agent Dispatcher is the execution boundary between the deterministic Coordinator and the runtime-specific agent adapters.

It combines:

```text
AgentDispatchRequest
        |
        v
Agent Dispatcher
   |          |
   v          v
Registry    Runtime Adapter
   |          |
   v          v
Agent Role   Antigravity / Claude / Mock
```

## Responsibilities

The Dispatcher MUST:

1. receive an `AgentDispatchRequest`;
2. resolve the requested `AgentRole` through the `AgentRegistry`;
3. select the requested `AgentRuntime`;
4. verify that the role supports that runtime;
5. resolve the corresponding `AgentRuntimeAdapter`;
6. execute the request;
7. return the resulting `AgentResult`.

## Non-responsibilities

The Dispatcher MUST NOT:

- change the State Machine;
- determine the next Coordinator state;
- evaluate gates;
- modify findings;
- generate implementation code itself;
- choose an LLM model;
- call OpenRouter;
- contain feature-specific prompts;
- bypass the Agent Registry;
- bypass the Runtime Adapter.

## Runtime selection

Runtime selection is explicit.

Example:

```ts
dispatcher.dispatch(request, "ANTIGRAVITY");
```

The Dispatcher does not infer a runtime from the agent role.

This allows the same role to execute through different hosts:

```text
IMPLEMENTATION
    |
    +--> ANTIGRAVITY
    |
    +--> CLAUDE
    |
    +--> MOCK
```

## Error handling

The Dispatcher should fail fast when:

- the role is not registered;
- the role does not support the requested runtime;
- no adapter exists for the requested runtime.

Runtime execution errors are propagated to the Coordinator boundary.

The Dispatcher must not convert runtime failures into `PASS` or `FINDINGS`.

## Determinism

The Dispatcher is deterministic with respect to:

```text
role + runtime + registered adapter
```

It does not make an LLM decision.

## V1 validation

The V1 test suite must prove:

- registered role + supported runtime dispatches;
- unsupported role/runtime combinations fail;
- missing runtime adapter fails;
- the exact `AgentDispatchRequest` reaches the adapter;
- `AgentResult` is returned unchanged;
- the Dispatcher does not mutate the request.
