# Arquitectura

## Resumen

`agent-communication-bridge` es una plataforma local para descubrimiento y comunicación entre agentes. El sistema se compone de:

- `RegistryServer`: directorio central de agentes y bus de eventos para tiempo real.
- `AgentServer`: endpoint por proyecto que expone Agent Card, RPC y WebSocket.
- `A2AClient` y `RegistryClient`: clientes para interactuar con agentes y registry.
- `McpAgentBridge`: adaptador que expone agentes y skills como herramientas MCP.

## Componentes

### RegistryServer

Responsabilidades principales:

- aceptar registro y desregistro de agentes
- mantener heartbeat y salud en memoria
- exponer lista de agentes por HTTP
- emitir snapshot y eventos por WebSocket
- recibir eventos de tareas desde agentes por `POST /events`

Implementación principal:

- [`src/registry/server.ts`](../src/registry/server.ts)
- [`src/registry/store.ts`](../src/registry/store.ts)
- [`src/registry/events.ts`](../src/registry/events.ts)

Política de salud actual:

- heartbeat esperado cada 30 segundos desde el agente
- agente marcado como `unhealthy` después de 90 segundos sin heartbeat
- agente eliminado después de 5 minutos sin heartbeat

### AgentServer

Cada agente representa un proyecto local y expone:

- Agent Card en `GET /.well-known/agent-card.json` (spec 0.3.0; `agent.json` como alias legacy)
- JSON-RPC 2.0 en `POST /`
- health check en `GET /health`
- WebSocket en `WS /ws`

Responsabilidades:

- detectar tipo y nombre del proyecto
- construir la Agent Card
- registrar skills disponibles
- ejecutar métodos A2A y métodos locales
- registrar y mantener su presencia en el registry
- publicar actualizaciones de tareas al registry

Implementación principal:

- [`src/agent/server.ts`](../src/agent/server.ts)
- [`src/agent/handlers.ts`](../src/agent/handlers.ts)
- [`src/agent/card.ts`](../src/agent/card.ts)
- [`src/agent/project-detector.ts`](../src/agent/project-detector.ts)

### Skills

Las skills builtin se cargan desde `createDefaultRegistry()`:

- `file-search`
- `endpoint-find`
- `code-query`
- `prompt-execute`

Framework y runtime:

- [`src/skills/framework.ts`](../src/skills/framework.ts)
- [`src/skills/index.ts`](../src/skills/index.ts)
- [`src/skills/state-graph.ts`](../src/skills/state-graph.ts)

### MCP Adapter

`McpAgentBridge` toma el estado del registry y lo traduce a:

- meta-tools MCP
- tools por skill y por agente
- resources MCP
- prompts MCP

Puede funcionar en:

- `stdio` para clientes MCP locales
- HTTP/SSE para clientes remotos o pruebas

Implementación:

- [`src/mcp/adapter.ts`](../src/mcp/adapter.ts)

## Flujo principal

```text
1. RegistryServer arranca en localhost:4999
2. AgentServer arranca en un proyecto local
3. AgentServer detecta tipo de proyecto y skills
4. AgentServer se registra por POST /agents
5. AgentServer manda heartbeat a /agents/:id/heartbeat
6. Clientes consultan /agents o se suscriben a /ws
7. Un cliente envia tareas por POST / al agente
8. El agente ejecuta la skill y publica task.update a /events
9. El registry retransmite task.update a los suscriptores por /ws
```

## Protocolos y contratos

### Registry HTTP

Endpoints:

- `POST /agents`
- `DELETE /agents/:id`
- `POST /agents/:id/heartbeat`
- `GET /agents`
- `GET /agents/:id`
- `GET /health`
- `POST /events`

### Registry WebSocket

Endpoint:

- `WS /ws`

Mensajes emitidos:

- `snapshot`
- `agent.registered`
- `agent.deregistered`
- `agent.heartbeat`
- `agent.unhealthy`
- `agent.removed`
- `task.update`

### Agent HTTP

Endpoints:

- `GET /.well-known/agent-card.json` (y `agent.json` como alias legacy)
- `POST /`
- `GET /health`

### Agent WebSocket

Endpoint:

- `WS /ws`

Comportamiento actual:

- al conectar, el servidor envia `agent.hello`
- el cliente puede mandar JSON-RPC
- el servidor responde por el mismo socket

## Tipos centrales

Los contratos publicos principales viven en:

- [`src/types/a2a.ts`](../src/types/a2a.ts)
- [`src/types/jsonrpc.ts`](../src/types/jsonrpc.ts)
- [`src/types/messages.ts`](../src/types/messages.ts)
- [`src/types/skills.ts`](../src/types/skills.ts)

Tipos clave:

- `AgentCard`
- `AgentSkill`
- `Task`
- `TaskStatus`
- `JsonRpcRequest`
- `JsonRpcResponse`
- `RegistryEntry`
- `SkillDefinition`
- `SkillContext`

## Decisiones de diseño visibles en el código

- Todo el sistema esta optimizado para uso local y simple descubrimiento entre procesos.
- El registry usa memoria en proceso; no hay persistencia.
- La comunicación entre agentes y clientes se apoya en HTTP + WebSocket, no en colas externas.
- MCP es una capa adaptadora; no es el nucleo del sistema.
- El registry actúa como fuente única de verdad para agentes y trazas en memoria.

## Limitaciones actuales

- No hay autenticación.
- No hay almacenamiento persistente de agentes, tareas ni trazas.
- El streaming de tareas A2A no esta cerrado de punta a punta.
- `StateGraph` no implementa un motor completo de convergencia y fan-in.
- La detección de proyecto es heurística por archivos conocidos.
