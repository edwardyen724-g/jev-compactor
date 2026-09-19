# Product Documentation: Sealed Context & `jev-compactor`

> Founding spec, pasted by Edward on 2026-09-18. Kept verbatim; design decisions that refine it live in `ARCHITECTURE.md`.

## 1. Product Vision & Positioning

Sealed Context is a developer-first context management and safety middleware designed for multi-agent orchestration. By replacing computationally expensive, lossy LLM summarization with ultra-fast, deterministic semantic filtering powered by TypeSafe AI's Jev, the platform solves the dual bottlenecks of agentic development: context bloat and unpredictable execution loops.

The product operates on a Commercial Open-Source Software (COSS) model. The core algorithm is distributed as a free NPM package and CLI tool, establishing it as the default community standard. The monetization layer is a hosted Vercel-style control plane offering visual telemetry, secure API routing, and enterprise-grade safety escrow.

## 2. Core Mechanics: The Engine

The underlying architecture relies on Jev functioning not as a text generator, but as a high-frequency semantic array filter.

* **State Injection:** When an agent's context array approaches token limits, the engine halts the primary generative model (e.g., GPT-4o, Claude). It serializes the historical message array and the agent's active goal into a read-only state payload.
* **Speculative Fan-Out:** The engine dynamically generates a batch of Jev `Choice` primitives (e.g., `[KEEP, DROP]`) for every individual message in the history, processing the entire array in a single parallel pass (70–500ms latency).
* **Foreman Piggyback:** Simultaneously, `Noul` primitives evaluate the full state for recursive logic loops and destructive commands (e.g., `rm -rf`, unauthorized network access).
* **Deterministic Reassembly:** The engine physically slices the `DROP` messages from the JSON array and injects corrective system prompts if the `Noul` evaluations detect thrashing, returning a compressed, pristine context window back to the orchestration framework.

## 3. Product Architecture (The Open-Core Model)

### Tier 1: `jev-compactor` (Open-Source Core)

A lightweight, framework-agnostic NPM package designed for rapid developer adoption.

* **Form Factor:** NPM package and CLI utility.
* **Integrations:** Natively supports LangChain, CrewAI, and Model Context Protocol (MCP) standards.
* **Capabilities:** Executes the core compaction algorithm locally. Developers bring their own TypeSafe API keys. Retains 100% string fidelity for code blocks and system logs.

### Tier 2: Sealed Context Cloud (Pro Tier SaaS)

A managed infrastructure layer that removes operational friction and provides deep visibility into the agent's cognitive loop.

* **Form Factor:** Hosted web application and managed API proxy.
* **Capabilities:**
  * API key routing and rate limiting.
  * Real-time visual telemetry of agent context.
  * Token savings analytics and latency monitoring.
* **Monetization:** Per-compaction micro-transaction fee or a flat monthly seat license for development teams.

### Tier 3: The Foreman Pattern (Enterprise Security)

An advanced safety guardrail designed for mid-market engineering teams deploying autonomous agents into production environments.

* **Form Factor:** Enterprise-gated features within the Cloud dashboard.
* **Capabilities:**
  * Asynchronous background supervision of all agent API calls.
  * Physical interception of destructive commands at the networking layer.
  * Manual "Escrow" queues where human engineers must approve flagged agent actions.
  * SOC2-compliant, searchable audit logs of all intercepted commands.
  * Role-Based Access Control (RBAC).

## 4. User Experience & Interface (DX)

### Developer Integration

The integration must be frictionless. Developers wrap their existing orchestration logic in two lines of code without restructuring their native agent applications:

```javascript
import { withCompaction } from 'jev-compactor';

// Wraps existing LangChain or custom OpenAI calls
const agent = withCompaction(new Agent(), {
  maxTokens: 15000,
  safetyGating: true
});
```

### The Visual Debugger (Dashboard UI)

The Cloud Dashboard acts as a specialized agent control plane. The user interface prioritizes clarity and execution auditing:

* **The Context Stream (Left Panel):** A chronological feed of the agent's interaction history. Messages are color-coded: green (Kept), gray/strikethrough (Dropped by Jev), and red (Flagged by Foreman).
* **The Inspector (Right Panel):** Clicking any message reveals the exact Jev semantic evaluation. It displays the `Choice` confidence score (e.g., 98% confidence this message is irrelevant to the active goal) and the latency of the decision.
* **The Escrow Inbox (Top Nav):** A notification center alerting human supervisors that an agent has been suspended due to a high-risk `Noul` evaluation, requiring manual review of the proposed code execution before proceeding.

## 5. Development Roadmap

### Phase 1: OSS Launch & Efficacy Proof (Weeks 1-4)

* **Goal:** Publish `jev-compactor` to NPM and prove the economic/technical viability.
* **Deliverables:** State injector logic, speculative fan-out batching, and deterministic JSON reconstruction.
* **Go-to-Market:** Release comprehensive benchmarking data demonstrating an 80% reduction in frontier model API costs and a decrease in hallucinated file paths compared to standard LLM summarization.

### Phase 2: Telemetry & The SaaS Control Plane (Weeks 5-8)

* **Goal:** Transition from a local utility to a managed cloud product.
* **Deliverables:** Build the visual debugging dashboard, implement API proxy routing for secure key management, and launch the subscription billing model.
* **Go-to-Market:** Target independent developers and small teams seeking visibility into why their autonomous loops are failing.

### Phase 3: Enterprise Foreman Safety Layer (Months 3-6)

* **Goal:** Monetize institutional risk mitigation.
* **Deliverables:** Implement the `Noul` interception logic, build the Escrow UI for human approval, and deploy RBAC and compliance audit logging.
* **Go-to-Market:** Direct sales to DevSecOps teams and mid-market startups building AI-driven internal tooling that require hard mathematical guarantees against destructive agent actions.
